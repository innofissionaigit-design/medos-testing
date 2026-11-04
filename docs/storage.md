# Patient file storage

Patient photos and scanned documents (PNG, JPEG or PDF, up to 5 MB) are stored as bytes outside the database; PostgreSQL keeps only the
record (`PatientFile`: who uploaded it, its type, size and status). The bytes go through one small interface
(`apps/api/src/modules/documents/storage.service.ts`) with two drivers, chosen by `STORAGE_DRIVER`.

| | `local` (default) | `s3` |
|---|---|---|
| Where | `STORAGE_DIR` on the API machine (`/data/files` in the container, on the `medos-files` volume) | any S3-compatible bucket |
| API instances | **exactly one**: a second instance would not see the first one's files | any number |
| Backups | back up the folder or volume together with the database | the bucket's own versioning and replication |
| Use for | development, a single-server pilot | staging and production |

Keys are `<hospital id>/<file id>`, both server-generated UUIDs. Every key is checked before any driver sees it, so a file name or any
user input can never reach a path or a bucket key. Objects are written once and never overwritten.

## Using an S3-compatible store

Works with AWS S3, Cloudflare R2, Ceph, SeaweedFS and similar. (MinIO also speaks S3, but it is AGPL-licensed, which the project's [licence policy](dependencies/licenses.md) lists as stop-and-report; have that reviewed before choosing it.) Set:

| Variable | Meaning |
|---|---|
| `STORAGE_DRIVER=s3` | switch driver (the API refuses to start if `S3_BUCKET` or `S3_REGION` is missing) |
| `S3_BUCKET`, `S3_REGION` | required |
| `S3_ENDPOINT` | leave unset for AWS; set for R2, Ceph, SeaweedFS… (for example `https://<account>.r2.cloudflarestorage.com`) |
| `S3_FORCE_PATH_STYLE` | `true` for most self-hosted stores (addresses `endpoint/bucket/key`) |
| `S3_PREFIX` | optional folder inside the bucket, ending with `/` (for example `medos/prod/`) |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | set both, or neither to use the machine's own credentials (for example an AWS IAM role, which is the better choice on AWS). Both also accept the `_FILE` form ([deployment.md](deployment.md)). |
| `S3_SSE`, `S3_KMS_KEY_ID` | `AES256`, or `aws:kms` with a key, to have the store encrypt every object |

**Bucket setup that MedOS cannot do for you:** keep the bucket private (block all public access); give the API's credentials only
`s3:PutObject` and `s3:GetObject` on `<bucket>/<prefix>*` (it never lists, deletes or changes anything); turn on bucket versioning and a
lifecycle policy that fits your record-retention rules; use a separate bucket for each environment; require TLS.

**Behaviour to know about.** The SDK is asked for checksums only where the protocol requires them, because the newer default is
rejected by several S3-compatible stores. A temporary store error is retried up to three times; after that the upload fails with a
plain error (no store details are returned) and no `PatientFile` record is created, so there is never a record without its bytes. If the
bytes are stored but the record cannot be saved, the object stays in the bucket unreferenced: harmless, and removable by a
periodic comparison of the bucket against the table.

## Moving existing files from disk to a bucket

Files already stored with `local` are not moved automatically. To switch an environment that already has files, copy the folder into
the bucket under the same keys (the folder layout *is* the key layout: `<STORAGE_DIR>/<hospital id>/<file id>`), for example
`aws s3 sync <STORAGE_DIR>/ s3://<bucket>/<prefix>`, check a few files in the app, and only then change `STORAGE_DRIVER`.

## What has and has not been tested

The driver is tested against a small fake S3 server written for the tests, and through the real API (upload, download, a failing
store). That covers request signing, write-once uploads, encryption headers, retries, missing objects, access errors and the safe-download
headers. **It has not been run against a real bucket or a real S3-compatible server**: do one upload, one download and one removal check against your
real store before relying on it.
