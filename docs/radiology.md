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

## Images
The radiographer attaches images to a study: **PNG or JPEG** (a key image or screenshot from the modality) or **one DICOM file** (a single slice), up to **10 MB** each and **20 per study**. The bytes go to the same file storage as patient documents (local disk or S3) after the same virus scan; the content is checked against its declared type (a DICOM file must have "DICM" after its 128-byte preamble). Opening an image is audited (`RAD_IMAGE_VIEWED`); a wrong image is removed with a reason (5+ characters): it stops showing but stays on the record, and nothing is ever deleted (database rule). Anyone who may read radiology can open the images of the studies they may see (a doctor only for their own visits).
- **Viewer:** click an image on the study screen (Radiology) or on the visit page (Images next to the report). PNG and JPEG open with zoom, pan, rotate, invert, brightness and contrast. A DICOM slice is read in the browser (uncompressed 8 or 16 bit grayscale, Implicit or Explicit VR Little Endian) and shown with its own window and level, adjustable. Compressed DICOM (JPEG, JPEG 2000, RLE), colour DICOM and big-endian files cannot be shown here and say so; they can be downloaded and opened in a full DICOM viewer. A multi-frame file shows its first frame.
- It is a viewer for looking, **not a diagnostic workstation**: no measurements, no hanging protocols, no comparison with earlier studies, no 3D or MPR, no calibrated display. The signed report and the original study are what a diagnosis rests on.
- **Not built:** a DICOM server (PACS) that receives studies from the scanner, whole CT or MRI series, DICOM compression, and a viewer licence review for a full diagnostic viewer.
- API: `POST /rad/studies/:id/images?filename=&description=` (raw body, `image/png`, `image/jpeg` or `application/dicom`), `GET /rad/studies/:id/images`, `GET /rad/images/:id/content`, `POST /rad/images/:id/remove`. Audit events: `RAD_IMAGE_ADDED`, `RAD_IMAGE_VIEWED`, `RAD_IMAGE_REMOVED`, `RAD_IMAGE_REJECTED`.

## Permissions
`RAD_READ`, `RAD_PERFORM`, `RAD_REPORT`. Roles: `RADIOGRAPHER` (read, perform), `RADIOLOGIST` (read, report). Doctors, nurses, managers and administrators can read.

## Audit events
`RAD_STUDY_PERFORMED`, `RAD_IMAGE_ADDED/VIEWED/REMOVED`, `RAD_REPORT_SIGNED`, `RAD_REPORT_AMENDED`, `RAD_CRITICAL_FINDING`, `RAD_CRITICAL_ACKNOWLEDGED`, `DOCUMENT_PRINTED`.

## Database rules
Report versions are append-only, follow one another without gaps, and an amendment needs its reason. A study only moves forward, one version at a time, and cannot be deleted or moved. A study must belong to a billed radiology test of the same patient, visit and facility.

## API
`GET /rad/worklist`, `POST/GET /rad/orders/:id/study`, `POST /rad/studies/:id/report|amend|acknowledge`, `GET /rad/critical`, `GET /encounters/:id/radiology`, `GET /print/radiology-reports/:testOrderId`.

## Known limitations
No PACS (no DICOM server receiving studies from the scanner), no whole-series storage, no diagnostic viewer (see Images); no report templates or structured measurements; no preliminary/addendum workflow beyond amendment. See `docs/backlog.md`.
