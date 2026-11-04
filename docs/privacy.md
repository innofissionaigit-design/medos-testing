# Privacy records: consent and data requests

**What this is.** Tools to *record* what patients agreed to, withdrew, or asked for, and to make reminders respect that. **What it is not:** legal compliance. Which consents a hospital needs, what the notice must say, how long records must be kept, and how a request must be answered are legal questions that have not been reviewed (see [reviews/pending-decisions.md](reviews/pending-decisions.md)). Nothing here is, or may be described as, DPDP Act compliance.

Code: `apps/api/src/modules/privacy/` (service, controller, `consent.ts`), tests in `privacy.spec.ts`; migration `20261029100000_privacy_consent_and_hsn`.

Rollback script (destroys the new records; written but not run): `packages/database/rollback/20261029100000_privacy_consent_and_hsn.down.sql`.

## Entities

| Entity | Purpose | Rules |
|---|---|---|
| `PatientConsent` | One row per decision: purpose, GRANTED or WITHDRAWN, method (verbal, written, digital), the notice version the patient saw, an optional note, who recorded it and when | **Append-only**: a database trigger refuses updates and deletes. The current state of a purpose is its newest row; the full history is always available. |
| `PatientDataRequest` | A request about the patient's data: ACCESS, CORRECTION, ERASURE or GRIEVANCE, with details, received date, optional due date, status, outcome | Never deleted (trigger). A closed request must carry its outcome, closing time and closer (check constraints). Logging or even completing an ERASURE request **does not erase anything**; any change to records is a separate, deliberate action. |

Both tables are hospital-scoped (`tenantId`, composite foreign key to the patient, row-level-security policy) and carry the same isolation tests as every other tenant table.

Consent purposes today: `PRIVACY_NOTICE_ACKNOWLEDGED` and `APPOINTMENT_REMINDERS`. They are the two the product can act on; the list is expected to change after the legal review.

## Workflows

**Consent** (front desk, doctor's desk; patient record screen or API): record a decision with `POST /patients/:id/consents`; read it with `GET /patients/:id/consents` (current state plus history). Recording the state a purpose is already in is refused (`CONSENT_UNCHANGED`, 409). Concurrent identical requests leave one record (advisory lock).

**Reminders and consent.** A reminder SMS is planned and sent only if:
- the patient has **not withdrawn** `APPOINTMENT_REMINDERS`; and
- if the patient has no record on file, the hospital setting `REMINDERS_REQUIRE_CONSENT` allows it (default **off**: remind unless the patient objects; **on**: only patients who agreed).

Withdrawing cancels that patient's pending reminders immediately (count in the audit event). The worker re-checks at send time and marks a reminder SKIPPED ("The patient has not agreed to reminders") if consent was withdrawn after it was planned. Which default is lawful is a pending legal decision; the setting lets the hospital choose without code changes.

**Data requests.** Front desk logs a request (`POST /patients/:id/data-requests`). A privacy manager works the list (`GET /privacy/requests`, filter by status or patient, oldest first, with an overdue flag when the due date has passed) and moves each through its states with `PATCH /privacy/requests/:id` (requires the current `version`; a stale one is refused).

State transitions:

```
OPEN ──► IN_PROGRESS ──► COMPLETED
  │            └───────► REJECTED
  ├─────────────────────► COMPLETED
  └─────────────────────► REJECTED
```

COMPLETED and REJECTED are final (log a new request to reopen the matter) and need an outcome of at least 5 characters.

## Permissions

| Action | Permission | Roles that have it by default |
|---|---|---|
| Read a patient's consent | `PATIENT_READ` | all clinical and front-desk roles |
| Record consent, log a data request | `PATIENT_UPDATE` | Receptionist |
| List and work data requests | `PRIVACY_MANAGE` (new) | Administrator (existing hospitals receive it through the migration) |

## Audit events

`CONSENT_GRANTED`, `CONSENT_WITHDRAWN` (purpose, method, notice version, reminders cancelled; the free-text note is not copied), `DATA_REQUEST_CREATED` (type), `DATA_REQUEST_UPDATED` (from, to; request text and outcome are not copied), `SETTING_CHANGED` for `REMINDERS_REQUIRE_CONSENT`.

## Known limitations (all pending or not built)

- **Screens are basic.** The patient record has a "Privacy and consent" card (record or withdraw agreement, show history, log a data request); Administration has a "Privacy" tab (list, work and close requests) and the reminder-consent switch in Settings. There is **no consent step in the registration form**, no printed notice, and the screens were type-checked and linted but not exercised in a browser or covered by Playwright tests.
- No consent notice text or versioning workflow beyond a free-text version label; no languages.
- Consent applies to reminders only. Nothing else in the system checks consent.
- No child/guardian consent handling, no nominee rights, no automatic deadlines for answering requests (the due date is informational).
- No retention schedule, anonymisation or erasure tooling, and no breach-notification tooling (a draft checklist below is documentation only).
- No reports on consent coverage or request turnaround.

## Draft breach-response checklist (for the legal review; not approved)

1. Contain: revoke affected sessions and tokens (`/auth` logout all, rotate secrets), isolate affected systems, preserve logs and the database state.
2. Record: time found, what data and how many patients and hospitals, how it happened, who found it. Audit events and request ids (`AuditEvent.requestId`) help.
3. Assess: whether personal data was accessed or lost, and whether it was encrypted (backups are AES-256-GCM encrypted; see [backup.md](backup.md)).
4. Notify: who must be told (the hospital as fiduciary, the regulator, affected patients), by when, and in what words: **to be decided by the legal review**.
5. Remediate, then review: fix the cause, add a test, update this checklist.
