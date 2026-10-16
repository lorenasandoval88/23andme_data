/**
 * Cloud Run worker: fetch PGP 23andMe participants, download each genetic file,
 * detect genome build, add profile data, and write consolidated lists.
 *
 * FULL MODE (download + build + profile all enabled).
 *
 * PARTICIPANT_SOURCE controls where the participant list comes from:
 *   PARTICIPANT_SOURCE=fetch     -> pulls a fresh participant list from the PGP
 *                                   site, saves it, then downloads every file.
 *   PARTICIPANT_SOURCE=existing  -> loads a participant list already in the bucket
 *                                   (path in INPUT_PARTICIPANT_JSON) and reprocesses.
 *
 * For each participant whose file is .txt/.zip: download the file, detect genome
 * build from the header, save the TXT to geneticFiles/, and fetch the profile.
 * profile / profileError are merged onto every record exactly once.
 *
 * On failure, the SDK attaches structured fields to the thrown error:
 *   err.status / err.requestedUrl / err.finalUrl / err.source
 *
 * Outputs:
 *   participantList/participants_${LIMIT}.json                                          (only when fetching fresh)
 *   updatedParticipantsList/participants_${LIMIT}_with_build_${dateStamp}.json
 *   updatedParticipantsList/participants_${LIMIT}_with_build_and_profile_${dateStamp}.json
 *   updatedParticipantsList/participants_${LIMIT}_consolidated_with_build_${dateStamp}.json
 *   updatedParticipantsList/participants_${LIMIT}_consolidated_with_build_and_profile_${dateStamp}.json
 *   runReports/unauthorized_401s_${LIMIT}_${dateStamp}.json
 *   runReports/import_report_${LIMIT}_${dateStamp}.json
 *
 * The two consolidated files collapse the flat (one-record-per-file) list to one
 * record per participant (keyed by id):
 *   { id, profileUrl, number_of_files, files: [ <per-file fields> ],
 *     profileError, profile }   // profile/profileError only in the build_and_profile version
 */


// Setup, execution, and output download commands are documented in README.md.

import { Storage } from "@google-cloud/storage";

import {
  fetch23andMeParticipants,
  load23andMeFileCloud_unknwn,
  fetchProfile
} from "personal_genomes_project_sdk/cloud_sdk.mjs";

const storage = new Storage();

function getDateStamp() {
  const now = new Date();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const yyyy = now.getUTCFullYear();
  const hh = String(now.getUTCHours()).padStart(2, "0");
  const min = String(now.getUTCMinutes()).padStart(2, "0");
  return `${mm}${dd}${yyyy}_${hh}${min}`;
}

// Only use BUCKET_NAME env var if explicitly set; otherwise build one
// from today's date, e.g. all23_07072026_1432
const BUCKET_NAME = process.env.BUCKET_NAME || `all23_${getDateStamp()}`;

const LIMIT = Number(process.env.LIMIT || 6);
const BATCH_SIZE = Number(process.env.BATCH_SIZE || 10);

for (const [name, value] of Object.entries({ LIMIT, BATCH_SIZE })) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
}

// "fetch"    = pull a fresh participant list from the PGP site (default).
// "existing" = reuse a participant list already saved in the bucket.
const PARTICIPANT_SOURCE = String(
  process.env.PARTICIPANT_SOURCE || "fetch"
).toLowerCase();

if (!["fetch", "existing"].includes(PARTICIPANT_SOURCE)) {
  throw new Error(
    `Invalid PARTICIPANT_SOURCE="${PARTICIPANT_SOURCE}". Must be "fetch" or "existing".`
  );
}

// Only used when PARTICIPANT_SOURCE=existing. Path to the participant list
// ALREADY in the bucket.
const INPUT_PARTICIPANT_JSON =
  process.env.INPUT_PARTICIPANT_JSON ||
  `participantList/participants_${LIMIT}.json`;

async function ensureBucketExists(bucketName) {
  const bucket = storage.bucket(bucketName);

  const [exists] = await bucket.exists();

  if (exists) {
    console.log(`Bucket already exists: gs://${bucketName}`);
    return bucket;
  }

  console.log(`Creating bucket: gs://${bucketName}`);

  try {
    await storage.createBucket(bucketName, {
      location: "US-EAST4",       // match your Cloud Run job's region
      storageClass: "STANDARD"
    });

    console.log(`Bucket created: gs://${bucketName}`);
  } catch (err) {
    // Race condition guard: if two runs try to create it at the same
    // moment, GCS returns 409 for the loser - treat that as success.
    if (err.code === 409) {
      console.log(`Bucket already existed (race condition): gs://${bucketName}`);
    } else {
      throw err;
    }
  }

  return storage.bucket(bucketName);
}

// Fetch a participant's profile without letting a profile-endpoint failure
// abort processing. Never throws. Returns { profile, profileError }.
async function fetchProfileSafe(id) {
  try {
    const profile = await fetchProfile(id);
    return { profile, profileError: null };
  } catch (err) {
    console.error(`  profile fetch failed for ${id}: ${err.message}`);
    return { profile: null, profileError: err.message };
  }
}

function getDataToSave(loaded) {
  if (typeof loaded.txt === "string") {
    return loaded.txt;
  }

  if (Buffer.isBuffer(loaded.buffer)) {
    return loaded.buffer;
  }

  if (loaded.buffer instanceof ArrayBuffer) {
    return Buffer.from(loaded.buffer);
  }

  if (ArrayBuffer.isView(loaded.buffer)) {
    return Buffer.from(
      loaded.buffer.buffer,
      loaded.buffer.byteOffset,
      loaded.buffer.byteLength
    );
  }

  return null;
}

function getSizeMB(data) {
  const sizeBytes =
    typeof data === "string"
      ? Buffer.byteLength(data, "utf8")
      : data.length;

  return Number((sizeBytes / 1024 / 1024).toFixed(2));
}

function makeNullBuildParticipant(participant, reason) {
  return {
    ...participant,
    valid23File: false,
    matchedLineValid23File: null,
    genomeBuild: null,
    genomeBuildFiles: [],
    processingNote: reason
  };
}

// Extracts the numeric file id from a PGP download URL, e.g.
// https://my.pgp-hms.org/user_file/download/4177 -> "4177".
// This id is unique per uploaded file, so it disambiguates cases where the
// same participant has multiple files sharing the same inner filename.
function getDownloadId(downloadUrl) {
  const match = String(downloadUrl || "").match(/\/download\/(\d+)/);
  return match ? match[1] : null;
}

// Builds: <id>_<numericDownloadId>_<filename>
// The numericDownloadId guarantees uniqueness even when a participant uploads
// two or more files with identical inner filenames (which previously collided
// and silently overwrote each other in GCS).
function makeSavedFilename(id, filename, downloadUrl) {
  const downloadId = getDownloadId(downloadUrl);

  if (!filename) {
    return downloadId ? `${id}_${downloadId}_unknown.txt` : `${id}_unknown.txt`;
  }

  let safeFilename = filename.replace(/[\/\\?%*:|"<>]/g, "_");

  // Strip a leading "<id>_" the inner filename may already carry, so we don't
  // produce huBB5257_huBB5257_20110420205535.txt.
  if (safeFilename.toLowerCase().startsWith(`${id.toLowerCase()}_`)) {
    safeFilename = safeFilename.slice(id.length + 1);
  }

  // If we couldn't parse a download id, fall back to <id>_<filename>.
  if (!downloadId) {
    return `${id}_${safeFilename}`;
  }

  return `${id}_${downloadId}_${safeFilename}`;
}

async function loadParticipantsFromBucket(bucket, path) {
  const [contents] = await bucket.file(path).download();
  const participants = JSON.parse(contents.toString("utf8"));

  if (!Array.isArray(participants)) {
    throw new Error(`Expected an array in ${path}, got ${typeof participants}`);
  }

  if (participants.some((p) => !p || typeof p !== "object" || !p.id || Array.isArray(p.files))) {
    throw new Error("Existing input must be a flat array of file records with id and downloadUrl; consolidated output is not valid input.");
  }

  return participants;
}

// First non-null value of `key` across a group of records, else null.
function firstNonNull(records, key) {
  for (const r of records) {
    if (r[key] !== null && r[key] !== undefined) {
      return r[key];
    }
  }
  return null;
}

// Collapse a flat (one-record-per-file) list to one record per participant,
// keyed by id. Each participant becomes:
//   { id, profileUrl, number_of_files, files: [ <per-file fields> ],
//     profileError, profile }
// When includeProfile is false, the per-person profile/profileError are omitted
// (both at the top level and from each nested file object) -> "consolidated build".
// When true, they are hoisted to the top level, profileError right before profile
// -> "consolidated build and profile".
function consolidateById(participants, includeProfile) {
  const groups = new Map();
  for (const p of participants) {
    if (!groups.has(p.id)) {
      groups.set(p.id, []);
    }
    groups.get(p.id).push(p);
  }

  const consolidated = [];
  for (const records of groups.values()) {
    const first = records[0];

    const files = records.map((r) => {
      // Drop per-person fields so they aren't duplicated inside every file.
      const { id, profileUrl, profile, profileError, ...fileFields } = r;
      return fileFields;
    });

    const obj = {
      id: first.id,
      profileUrl: first.profileUrl,
      number_of_files: records.length,
      files
    };

    if (includeProfile) {
      // Key order: ... files, profileError, profile
      obj.profileError = firstNonNull(records, "profileError");
      obj.profile = firstNonNull(records, "profile");
    }

    consolidated.push(obj);
  }

  return consolidated;
}

async function main() {
  const bucket = await ensureBucketExists(BUCKET_NAME);

  console.log("Starting genetic file import...");
  console.log({
    BUCKET_NAME,
    LIMIT,
    BATCH_SIZE,
    PARTICIPANT_SOURCE,
    INPUT_PARTICIPANT_JSON: PARTICIPANT_SOURCE === "existing" ? INPUT_PARTICIPANT_JSON : "(n/a - fetching fresh)"
  });

  let participants;
  let participantSourcePath;

  if (PARTICIPANT_SOURCE === "existing") {
    participants = await loadParticipantsFromBucket(bucket, INPUT_PARTICIPANT_JSON);
    participantSourcePath = INPUT_PARTICIPANT_JSON;

    console.log(
      `Loaded ${participants.length} participants from gs://${BUCKET_NAME}/${INPUT_PARTICIPANT_JSON}`
    );
  } else {
    participants = await fetch23andMeParticipants(LIMIT, {
      batchSize: BATCH_SIZE
    });

    console.log(`Participants found: ${participants.length}`);

    const participantOutputPath = `participantList/participants_${LIMIT}.json`;

    await bucket.file(participantOutputPath).save(
      JSON.stringify(participants, null, 2),
      { contentType: "application/json" }
    );

    console.log(
      `Saved raw participant JSON to gs://${BUCKET_NAME}/${participantOutputPath}`
    );

    participantSourcePath = participantOutputPath;
  }

  let savedCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  let unauthorizedCount = 0;
  let profiledCount = 0;
  let profileFailedCount = 0;

  const updatedParticipants = [];
  const unauthorizedFailures = [];

  for (const participant of participants) {
    // Kick off the profile fetch so it overlaps with the file download. Never throws.
    const profilePromise = fetchProfileSafe(participant.id);

    try {
      if (!participant?.downloadUrl) {
        skippedCount++;

        console.warn(`Skipping ${participant?.id}: no downloadUrl`);

        updatedParticipants.push(
          { ...makeNullBuildParticipant(participant, "no downloadUrl"), ...(await profilePromise) }
        );

        continue;
      }

      const allowedExtensions = ["txt", "zip"];
      const extension = String(participant.filenameExtension || "").toLowerCase();

      // Skip known non-TXT/ZIP files, but allow unknown/null URLs to be inspected.
      if (extension && !allowedExtensions.includes(extension)) {
        skippedCount++;

        console.warn(
          `Skipping ${participant.id}: unsupported filenameExtension=${participant.filenameExtension}`
        );

        updatedParticipants.push(
          { ...makeNullBuildParticipant(participant, `unsupported filenameExtension=${participant.filenameExtension}`), ...(await profilePromise) }
        );

        continue;
      }

      console.log(`Processing ${participant.id}`);
      console.log(`Download URL: ${participant.downloadUrl}`);
      console.log(`File extension from metadata: ${participant.filenameExtension}`);

      const loaded = await load23andMeFileCloud_unknwn(
        participant.downloadUrl,
        participant.id
      );

      const loadedExtension = String(
        loaded.filenameExtension || ""
      ).toLowerCase();

      // ZIP files should be extracted to TXT by the loader.
      // Therefore, the final loaded file should be txt.
      if (loadedExtension !== "txt") {
        skippedCount++;

        console.warn(
          `Skipping ${participant.id}: downloaded unsupported file=${loaded.filename}, extension=${loaded.filenameExtension}`
        );

        updatedParticipants.push(
          { ...makeNullBuildParticipant(participant, `downloaded unsupported file=${loaded.filename}, extension=${loaded.filenameExtension}`), ...(await profilePromise) }
        );

        continue;
      }

      const dataToSave = getDataToSave(loaded);

      if (!dataToSave) {
        throw new Error("Downloaded TXT is empty or unsupported");
      }

      if (typeof dataToSave === "string" && !dataToSave.trim()) {
        throw new Error("Downloaded TXT is empty");
      }

      if (Buffer.isBuffer(dataToSave) && dataToSave.length === 0) {
        throw new Error("Downloaded TXT buffer is empty");
      }

      // For ZIPs, loaded.filename is the extracted inner .txt name.
      // For direct .txt files, it's the original filename.
      // Save under <id>_<numericDownloadId>_<filename>
      const savedFilename = makeSavedFilename(
        participant.id,
        loaded.filename,
        participant.downloadUrl
      );

      const outputPath = `geneticFiles/${savedFilename}`;

      await bucket.file(outputPath).save(dataToSave, {
        contentType: "text/plain"
      });

      const sizeMB = getSizeMB(dataToSave);

      const { profile, profileError } = await profilePromise;

      updatedParticipants.push({
        ...participant,
        profile,
        profileError,
        innerFilename: loaded.innerFilename || participant.innerFilename || null,
        valid23File: loaded.valid23File,
        matchedLineValid23File: loaded.matchedLineValid23File,
        genomeBuild: loaded.genomeBuild,
        genomeBuildFiles: [
          {
            downloadUrl: participant.downloadUrl || null,
            filename: loaded.filename || null,
            gcsPath: outputPath,
            gcsfilename: savedFilename,
            sizeMB,
            matchedLine: loaded.matchedLineGenomeBuild
          }
        ]
      });

      savedCount++;

      if (profileError) {
        profileFailedCount++;
      } else {
        profiledCount++;
      }

      console.log(`Saved ${savedCount}: gs://${BUCKET_NAME}/${outputPath}`);
      console.log({
        id: participant.id,
        genomeBuild: loaded.genomeBuild,
        matchedLine: loaded.matchedLineGenomeBuild
      });
    } catch (err) {
      failedCount++;

      const httpStatus = err.status ?? null;
      const finalUrlAtFailure = err.finalUrl || participant.finalUrl || null;
      const requestedUrl = err.requestedUrl || participant.downloadUrl || null;
      const failureSource = err.source || null;

      const isUnauthorized = httpStatus === 401;

      if (isUnauthorized) {
        unauthorizedCount++;
      }

      console.error(
        `FAILED ${participant?.id}: ${err.message}` +
        (httpStatus ? ` [status=${httpStatus}]` : "") +
        (failureSource ? ` [source=${failureSource}]` : "") +
        (finalUrlAtFailure ? ` [finalUrl=${finalUrlAtFailure}]` : "")
      );

      if (isUnauthorized) {
        unauthorizedFailures.push({
          id: participant.id,
          requestedUrl,
          finalUrl: finalUrlAtFailure,
          httpStatus,
          source: failureSource,
          errorMessage: err.message
        });
      }

      const { profile, profileError } = await profilePromise;

      if (profileError) {
        profileFailedCount++;
      } else {
        profiledCount++;
      }

      updatedParticipants.push({
        ...participant,
        profile,
        profileError,
        valid23File: false,
        matchedLineValid23File: null,
        genomeBuild: null,
        genomeBuildFiles: [],
        httpStatusDownloadAttempt: httpStatus,
        finalUrlAtFailure,
        requestedUrlAtFailure: requestedUrl,
        failureSource,
        processingNote: `FAILED: ${err.message}`
      });
    }
  }

  const dateStamp = getDateStamp();

  // ---------------------------------------------------------------------------
  // FLAT with_build output (no profile): same per-file records as
  // with_build_and_profile, but with profile/profileError stripped off.
  // ---------------------------------------------------------------------------
  const withBuildOnly = updatedParticipants.map((r) => {
    const { profile, profileError, ...rest } = r;
    return rest;
  });

  const withBuildOutputPath =
    `updatedParticipantsList/participants_${LIMIT}_with_build_${dateStamp}.json`;

  await bucket.file(withBuildOutputPath).save(
    JSON.stringify(withBuildOnly, null, 2),
    { contentType: "application/json" }
  );

  console.log(
    `Saved with_build (no profile) JSON to gs://${BUCKET_NAME}/${withBuildOutputPath}`
  );

  const updatedParticipantOutputPath =
    `updatedParticipantsList/participants_${LIMIT}_with_build_and_profile_${dateStamp}.json`;

  await bucket.file(updatedParticipantOutputPath).save(
    JSON.stringify(updatedParticipants, null, 2),
    { contentType: "application/json" }
  );

  console.log(
    `Saved updated participant JSON to gs://${BUCKET_NAME}/${updatedParticipantOutputPath}`
  );

  // ===========================================================================
  // CONSOLIDATED OUTPUTS (one record per participant, keyed by id).
  // Both derive from the same updatedParticipants array:
  //   * consolidated_with_build              -> per-file build info, NO profile
  //   * consolidated_with_build_and_profile  -> same, plus hoisted profileError/profile
  // ===========================================================================
  const consolidatedBuild = consolidateById(updatedParticipants, false);
  const consolidatedBuildOutputPath =
    `updatedParticipantsList/participants_${LIMIT}_consolidated_with_build_${dateStamp}.json`;

  await bucket.file(consolidatedBuildOutputPath).save(
    JSON.stringify(consolidatedBuild, null, 2),
    { contentType: "application/json" }
  );

  console.log(
    `Saved consolidated (build) JSON to gs://${BUCKET_NAME}/${consolidatedBuildOutputPath} ` +
    `(${consolidatedBuild.length} participants)`
  );

  const consolidatedBuildProfile = consolidateById(updatedParticipants, true);
  const consolidatedBuildProfileOutputPath =
    `updatedParticipantsList/participants_${LIMIT}_consolidated_with_build_and_profile_${dateStamp}.json`;

  await bucket.file(consolidatedBuildProfileOutputPath).save(
    JSON.stringify(consolidatedBuildProfile, null, 2),
    { contentType: "application/json" }
  );

  console.log(
    `Saved consolidated (build+profile) JSON to gs://${BUCKET_NAME}/${consolidatedBuildProfileOutputPath} ` +
    `(${consolidatedBuildProfile.length} participants)`
  );

  const unauthorizedOutputPath = `runReports/unauthorized_401s_${LIMIT}_${dateStamp}.json`;

  await bucket.file(unauthorizedOutputPath).save(
    JSON.stringify(unauthorizedFailures, null, 2),
    { contentType: "application/json" }
  );

  console.log(
    `Saved 401 failures (${unauthorizedFailures.length}) to gs://${BUCKET_NAME}/${unauthorizedOutputPath}`
  );

  const reportOutputPath = `runReports/import_report_${LIMIT}_${dateStamp}.json`;

  const report = {
    bucketName: BUCKET_NAME,
    dateStamp,
    participantSource: PARTICIPANT_SOURCE,
    participantSourcePath,
    totalParticipants: participants.length,
    saved: savedCount,
    failed: failedCount,
    skipped: skippedCount,
    unauthorized401s: unauthorizedCount,
    profiled: profiledCount,
    profileFailed: profileFailedCount,
    uniqueParticipants: consolidatedBuild.length,
    withBuildJson: withBuildOutputPath,
    updatedParticipantJson: updatedParticipantOutputPath,
    consolidatedBuildJson: consolidatedBuildOutputPath,
    consolidatedBuildProfileJson: consolidatedBuildProfileOutputPath,
    unauthorizedFailuresJson: unauthorizedOutputPath
  };

  await bucket.file(reportOutputPath).save(
    JSON.stringify(report, null, 2),
    { contentType: "application/json" }
  );

  console.log(`Saved report to gs://${BUCKET_NAME}/${reportOutputPath}`);
  console.log("Run complete.");
  console.log(report);
}

main().catch(err => {
  console.error("FATAL ERROR:");
  console.error(err);
  process.exit(1);
});