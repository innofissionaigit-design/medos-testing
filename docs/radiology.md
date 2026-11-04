# Radiology

## Purpose
Runs the imaging department's reporting: a billed radiology test (X-ray, ultrasound, CT, MRI, mammography) is performed, then reported and signed by a radiologist. It sits on the existing test orders: the doctor advises a scan, the cashier bills it, and then it reaches radiology.

## Workflow
1. A billed radiology test appears on the Radiology work list as "Waiting for scan".
2. The radiographer records that the scan was done: type of scan, body part and optional clinical notes. The study gets an accession number (`RAD-{YEAR}-{SEQ}`). One study per test.
3. The radiologist writes the findings and impression and signs. A finding that needs the doctor straight away is marked critical.
4. A signed report is never edited. A correction is an amendment with a reason (5+ characters) against the current version; every version is kept and the printout says "AMENDED REPORT".
5. A critical finding stays on the critical list until the doctor of the visit acknowledges it. Amending to critical asks again; amending to non-critical clears it.
6. The doctor sees the report on the visit page; the report prints (HTML or PDF), reprints are stamped DUPLICATE COPY.

## Permissions
`RAD_READ`, `RAD_PERFORM`, `RAD_REPORT`. Roles: `RADIOGRAPHER` (read, perform), `RADIOLOGIST` (read, report). Doctors, nurses, managers and administrators can read.

## Audit events
`RAD_STUDY_PERFORMED`, `RAD_REPORT_SIGNED`, `RAD_REPORT_AMENDED`, `RAD_CRITICAL_FINDING`, `RAD_CRITICAL_ACKNOWLEDGED`, `DOCUMENT_PRINTED`.

## Database rules
Report versions are append-only, follow one another without gaps, and an amendment needs its reason. A study only moves forward, one version at a time, and cannot be deleted or moved. A study must belong to a billed radiology test of the same patient, visit and facility.

## API
`GET /rad/worklist`, `POST/GET /rad/orders/:id/study`, `POST /rad/studies/:id/report|amend|acknowledge`, `GET /rad/critical`, `GET /encounters/:id/radiology`, `GET /print/radiology-reports/:testOrderId`.

## Known limitations
No image storage or viewer (PACS) and no DICOM; no report templates or structured measurements; no preliminary/addendum workflow beyond amendment. See `docs/backlog.md`.
