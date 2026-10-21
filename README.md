# 23andme_data from the PGP

## `index.js`

`index.js` runs the PGP 23andMe data collection and annotation workflow. It retrieves participant file records, downloads TXT files or extracts TXT content from ZIP archives, and uses the PGP SDK to check the file format and identify the genome build from header information.

The script also retrieves participant profiles and records download failures, unsupported formats, and missing build information. Results are exported as both flat file-level lists and consolidated participant-level lists.

## `geneticFiles/`

`geneticFiles/` stores the downloaded or extracted genetic TXT files. Filenames combine the participant ID, PGP download ID, and source filename to distinguish multiple uploads from the same participant:

```text
geneticFiles/<participant_id>_<download_id>_<filename>.txt
```

Each saved file is linked to its metadata through `genomeBuildFiles`, which records its storage path, filename, size, and matched genome-build header.

Saving a file and passing the 23andMe format check are tracked separately through `valid23File`.

## Run summary

The supplied `participants_1020_consolidated_with_build_and_profile_07102026_2053.json` contains:

| Measure | Count |
| --- | ---: |
| Unique participants | 885 |
| File records | 1,018 |
| Participants with multiple file records | 76 |
| File records with saved genetic-file paths | 900 |
| Failed file records | 46 |
| Skipped unsupported file records | 72 |
| Saved files passing the 23andMe format check | 856 |
| Saved files flagged `valid23File: false` | 44 |

Genome-build annotations among the 900 saved file records were:

| Genome build | Files |
| --- | ---: |
| Build 37 | 623 |
| Build 36 | 257 |
| Undetermined | 20 |

The failed records include 12 HTTP 401 responses and three HTTP 404 responses. Profile objects are present for all 885 consolidated participant records.

These counts come from the supplied JSON; the `1020` filename label is not the number of unique participants or file records in that output.

## Metadata and reports

- `participantList/`: original file-level records retrieved from PGP.
- `updatedParticipantsList/`: annotated flat lists and consolidated participant lists.
- `runReports/`: processing counts, output paths, and HTTP 401 failure details.

The principal combined output is:

```text
participants_<LIMIT>_consolidated_with_build_and_profile_<STAMP>.json
```

Each consolidated record contains the participant ID, profile URL, file count, nested file/build metadata, and participant-level `profile` and `profileError` fields. This stage provides the collected genetic files and associated metadata for subsequent analysis.
