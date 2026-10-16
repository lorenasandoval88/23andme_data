# raw_23andme_from_pgp

Download publicly available PGP 23andMe genetic files, detect genome-build information through the PGP SDK, fetch participant profiles, and save raw TXT files plus consolidated JSON in Google Cloud Storage.

This folder uses the full-workflow `index.js` from the supplied `all23andme.zip`. It retains file downloading, build detection, profile fetching, failure records, and both consolidated outputs. It removes the original project-specific deployment comments, validates numeric settings and existing-input shape, and uses Node.js 24 in Docker. The other experimental script versions are omitted.

## Contents

- `index.js`: full import and consolidation worker.
- `Dockerfile`: builds the worker image; copies only the package manifest and entry point.
- `package.json`: ES modules, dependencies, start command, and syntax check.
- `.dockerignore`, `.gcloudignore`, `.gitignore`: exclude credentials, local dependencies, and generated data from build contexts or version control.

No API keys, service-account key files, access tokens, original project identifiers, or participant data are bundled. Authentication is supplied at runtime with Application Default Credentials (ADC). No PGP login or 23andMe account credentials are configured by this application.

## 1. Prerequisites and settings

Use a Bash-compatible terminal for the commands below. Install Google Cloud CLI; install Node.js 24+ and npm for a local run. Docker is optional if using Cloud Build.

You need a Google Cloud project with billing and permission to build images, create a job, attach its service account, and read/write the output bucket. Set your own identifiers:

```bash
cd raw_23andme_from_pgp
export PROJECT_ID="YOUR_PROJECT_ID"
export REGION="us-east4"
export BUCKET_NAME="YOUR_GLOBALLY_UNIQUE_BUCKET_NAME"
export REPOSITORY="pgp-workers"
export JOB_NAME="raw-23andme-from-pgp"
export SERVICE_ACCOUNT="pgp-23andme-worker@${PROJECT_ID}.iam.gserviceaccount.com"
export IMAGE_URI="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/${JOB_NAME}:v1"
export LIMIT="6"
export BATCH_SIZE="10"

gcloud auth login
gcloud config set project "$PROJECT_ID"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com storage.googleapis.com iam.googleapis.com
```

Start with `LIMIT=6` to check your setup. For a larger import, change it to your desired SDK fetch limit, such as `1020`. This is a fetch request limit, not a promise of that many unique participants. Multiple file records can belong to one participant, and the source contents can change.

## 2. Create the output bucket and runtime identity

Run these once, or use an existing bucket and service account and skip their creation commands:

```bash
gcloud storage buckets create "gs://${BUCKET_NAME}" \
  --location="$REGION" --uniform-bucket-level-access

gcloud iam service-accounts create pgp-23andme-worker \
  --display-name="PGP 23andMe worker"

gcloud storage buckets add-iam-policy-binding "gs://${BUCKET_NAME}" \
  --member="serviceAccount:${SERVICE_ACCOUNT}" \
  --role="roles/storage.objectAdmin"

gcloud storage buckets add-iam-policy-binding "gs://${BUCKET_NAME}" \
  --member="serviceAccount:${SERVICE_ACCOUNT}" \
  --role="roles/storage.legacyBucketReader"
```

The worker checks bucket existence, so it needs `storage.buckets.get` in addition to reading and writing objects. The bucket reader role supplies that check; object admin supplies object access. Your administrator must also allow your deploying identity to attach the service account (`iam.serviceAccounts.actAs`). The build identity needs permission to push images into the repository. Keep bucket access private.

Always set `BUCKET_NAME`. The original automatic fallback (`all23_MMDDYYYY_HHMM`, UTC) is retained for compatibility, but creating a bucket automatically also requires project-level bucket creation permission. The setup above avoids needing that permission on the runtime identity.

## 3A. Run locally

Your local ADC identity needs the same bucket access. This authentication is separate from `gcloud auth login` and stores credentials outside this folder.

```bash
gcloud auth application-default login
export GOOGLE_CLOUD_PROJECT="$PROJECT_ID"
npm install
npm run check
PARTICIPANT_SOURCE=fetch npm start
```

The program writes to the bucket even when run locally. It does not write raw files or consolidated JSON to the local working directory.

The supplied dependency ranges are preserved, including `personal_genomes_project_sdk: latest`. `npm install` requires access to that npm package and generates `package-lock.json`; retain the lockfile if you need a repeatable dependency snapshot. This handoff has no dependency lockfile, so a fresh Docker build can resolve different versions. If npm reports a missing/private package, obtain access or the correct SDK version from its maintainer.

## 3B. Or build and run a Cloud Run job

Create the Artifact Registry repository once; skip its creation if it already exists:

```bash
gcloud artifacts repositories create "$REPOSITORY" \
  --repository-format=docker --location="$REGION"

gcloud builds submit . --tag="$IMAGE_URI"

gcloud run jobs deploy "$JOB_NAME" \
  --image="$IMAGE_URI" \
  --region="$REGION" \
  --service-account="$SERVICE_ACCOUNT" \
  --tasks=1 --parallelism=1 \
  --memory=32Gi --cpu=8 --task-timeout=14400s --max-retries=0 \
  --set-env-vars="GOOGLE_CLOUD_PROJECT=${PROJECT_ID},BUCKET_NAME=${BUCKET_NAME},LIMIT=${LIMIT},PARTICIPANT_SOURCE=fetch,BATCH_SIZE=${BATCH_SIZE}"

gcloud run jobs execute "$JOB_NAME" --region="$REGION" --wait
```

The Docker command allows a 28 GiB Node heap and the job above allocates 32 GiB total, matching the original workload settings. These are starting settings from the supplied project, not measured requirements for every run. The job uses its attached service account through ADC; no credential file is copied into the image. Use a new image tag when publishing a changed build.

## 4. Get the consolidated files with build and profile

After the job finishes, list the actual output filenames:

```bash
gcloud storage ls "gs://${BUCKET_NAME}/updatedParticipantsList/"
gcloud storage ls "gs://${BUCKET_NAME}/runReports/"
```

Each completed import writes these objects. `STAMP` is `MMDDYYYY_HHMM` in UTC at the end of processing.

| Object path inside the bucket | Contents |
| --- | --- |
| `participantList/participants_LIMIT.json` | Fetched input, one record per file; written only in fetch mode |
| `geneticFiles/ID_DOWNLOADID_FILENAME.txt` | Downloaded TXT, extracted from ZIP when applicable |
| `updatedParticipantsList/participants_LIMIT_with_build_STAMP.json` | Flat file records with build data, without profiles |
| `updatedParticipantsList/participants_LIMIT_with_build_and_profile_STAMP.json` | Flat file records with build data and profiles |
| `updatedParticipantsList/participants_LIMIT_consolidated_with_build_STAMP.json` | One record per participant; file/build metadata nested in `files` |
| `updatedParticipantsList/participants_LIMIT_consolidated_with_build_and_profile_STAMP.json` | **Requested consolidated result:** nested file/build metadata plus participant-level `profile` and `profileError` |
| `runReports/import_report_LIMIT_STAMP.json` | Counts and exact paths of generated outputs |
| `runReports/unauthorized_401s_LIMIT_STAMP.json` | File downloads returning HTTP 401 |

For example, copy both consolidated versions and the reports to your machine:

```bash
mkdir -p downloads/consolidated_files downloads/runReports
gcloud storage cp \
  "gs://${BUCKET_NAME}/updatedParticipantsList/participants_${LIMIT}_consolidated_with_build_*.json" \
  downloads/consolidated_files/
gcloud storage cp \
  "gs://${BUCKET_NAME}/runReports/*.json" \
  downloads/runReports/
```

The `consolidated_with_build_*.json` wildcard matches both build-only and build-and-profile outputs, across all matching runs in that bucket. To download only the requested version, use:

```bash
gcloud storage cp \
  "gs://${BUCKET_NAME}/updatedParticipantsList/participants_${LIMIT}_consolidated_with_build_and_profile_*.json" \
  downloads/consolidated_files/
```

To select one run, replace the wildcard with its exact stamp from the listing or use the exact `consolidatedBuildProfileJson` path from its import report. Downloads use your CLI identity, which must have object read access.

Optionally download the raw genetic files as well:

```bash
gcloud storage cp --recursive "gs://${BUCKET_NAME}/geneticFiles" downloads/
```

These generated files can contain genetic and profile information. Keep credentials outside the project and use appropriate access controls for the resulting data.

## Output shape and the supplied reference JSON

The attached `participants_1020_consolidated_with_build_and_profile_07102026_2053.json` is an example of the final output. Inspection found 885 participant records. The number in a filename is a run label based on `LIMIT`, not a unique-participant count. The original JSON is not included in this source-only folder.

Each participant has `id`, `profileUrl`, `number_of_files`, and `files`. Each nested file keeps its source metadata, `valid23File`, `genomeBuild`, and `genomeBuildFiles`. Successful `genomeBuildFiles` entries include the saved `gcsPath`, filename, size, and matched build header. The participant-level `profile` contains the SDK-returned profile object; `profileError` is null or an error message. Build detection reads the source header through the SDK; it does not convert genomic coordinates to another build. A build can remain null.

## Reprocess an existing flat input

`PARTICIPANT_SOURCE=existing` reads a JSON object from the **same bucket**. Supply a flat array of file records, each with `id`, `downloadUrl`, and the relevant file metadata. The attached consolidated JSON has a nested `files` array and is an output, so it cannot be used directly in this mode.

For a local run, after the earlier environment setup:

```bash
export PARTICIPANT_SOURCE="existing"
export INPUT_PARTICIPANT_JSON="participantList/participants_${LIMIT}.json"
npm start
```

To change the Cloud Run job to that mode, deploy again using the same flags from section 3B, but replace its `--set-env-vars` value with:

```bash
--set-env-vars="GOOGLE_CLOUD_PROJECT=${PROJECT_ID},BUCKET_NAME=${BUCKET_NAME},LIMIT=${LIMIT},PARTICIPANT_SOURCE=existing,BATCH_SIZE=${BATCH_SIZE},INPUT_PARTICIPANT_JSON=participantList/participants_${LIMIT}.json"
```

Then execute the job again. Existing mode re-downloads files and re-fetches profiles; it is not a profile-only update or a resume operation. It processes every record in the input array; `LIMIT` labels output filenames but does not truncate that array. Reusing the bucket can overwrite raw files with the same names. Output lists use minute-resolution timestamps, so runs with the same limit finishing within one minute can overwrite those lists too.

## Environment variables

| Name | Default | Meaning |
| --- | --- | --- |
| `BUCKET_NAME` | `all23_` plus UTC start stamp | Existing output bucket; explicitly set this |
| `LIMIT` | `6` | Positive integer passed to SDK fetch; also used in filenames |
| `BATCH_SIZE` | `10` | Positive integer passed to participant discovery; file processing remains sequential |
| `PARTICIPANT_SOURCE` | `fetch` | `fetch` or `existing` |
| `INPUT_PARTICIPANT_JSON` | `participantList/participants_LIMIT.json` | Bucket object path used only in existing mode |
| `GOOGLE_CLOUD_PROJECT` | ADC environment | Project used by the Google Cloud client |

## Failures and validation

Failed downloads and skipped unsupported files remain represented in the JSON with processing notes and null build metadata. A profile endpoint failure produces `profile: null` plus `profileError`; it does not stop the import. HTTP 401 failures are reported without attempting to bypass authentication. A successful process exit means output writing completed, not that every download or profile succeeded; inspect the run report and per-record fields. The inherited profile counters cover saved and failed file attempts and exclude skipped files; inspect records when assessing profile completeness. Profiles are fetched per input file record, and consolidation chooses the first non-null profile and error within each participant group.

The worker writes consolidated lists at the end. If the process terminates before then, some raw files may exist without completed JSON outputs. The PGP endpoint and SDK must be reachable. `npm run check` checks JavaScript syntax only. This handoff was checked with isolated mocked SDK/storage runs; it was not deployed to Google Cloud and no live genetic data import was run.

## Official command references

- [Cloud Run job deploy](https://docs.cloud.google.com/sdk/gcloud/reference/run/jobs/deploy)
- [Cloud Run job execute](https://docs.cloud.google.com/sdk/gcloud/reference/run/jobs/execute)
- [Cloud Build submit](https://cloud.google.com/sdk/gcloud/reference/builds/submit)
- [Cloud Storage authentication](https://docs.cloud.google.com/storage/docs/authentication)
- [Cloud Storage IAM roles](https://docs.cloud.google.com/iam/docs/roles-permissions/storage)
