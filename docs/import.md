# Bulk data import (CSV)

For go-live and data migration. Administration → **Data import**. Needs the `DATA_IMPORT` permission (administrators; add it to a custom role if someone else should do it).

## What can be imported

| Kind | Creates | Same checks as |
|---|---|---|
| `services` | Service price list entries | Admin → Price list |
| `medicines` | Medicine list | Pharmacy masters |
| `opening-stock` | Opening stock batches (medicines must already exist) | Pharmacy opening stock |
| `patients` | Patients, with MRN and optional legacy ID | Patient registration |

Every row is saved by the same service the screens use, so an import can never create data the app would refuse.

## How it works

- `POST /api/v1/imports/:kind` with the file as the raw body (`Content-Type: text/csv`, UTF-8, comma-separated, at most 2000 rows and 5 MB). `GET /api/v1/imports/:kind` describes the columns.
- **Preview by default.** Nothing is saved unless `dryRun=false`. The screen shows "Check the file", then "Import N rows".
- Rows with problems are reported by row number and never imported; good rows still import. Fix the file and upload it again.
- **Safe to repeat.** Existing price codes, medicines and stock batches are skipped (never changed, never added twice); patients carry an idempotency key per file and row, and a legacy ID already imported is skipped.
- **Patients: no merging, no silent duplicates.** A row that looks like an existing patient, or like an earlier row in the file, is skipped and the MRN it resembles is named. Patients who only share a mobile number (families) are skipped unless "import patients who only share a mobile number" is chosen; those are saved with the same recorded duplicate override as the screen.
- Messages shown for failed rows never echo the values typed (no patient details in previews or logs).
- One import of a kind per hospital at a time on an instance (`409 IMPORT_IN_PROGRESS` otherwise).

## Audit

One `DATA_IMPORT_COMPLETED` event per committed import: kind, file SHA-256, row counts. No row contents. Each created record is also audited by the service that created it. Previews write nothing.

## Known limitations

- Dates are `YYYY-MM-DD` or `DD/MM/YYYY`; money has no thousands separators.
- Patients are matched for duplicates by the existing rules; very large legacy lists should be loaded in files of ≤2000 rows.
- Updating existing records, patient merge and advance payments are not part of the import (see `docs/backlog.md`).
