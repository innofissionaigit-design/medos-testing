# Data-protection and legal review brief (DPDP Act 2023; spec gap G14)

**Ask:** tell us what MedOS and its operators must do to handle patient data lawfully in India, and what we must change. Engineering does not certify compliance and has not had this reviewed.

## What data MedOS holds

Patient demographics (name, date of birth or age, gender, mobile, address, optional photo), identifiers (MRN and others), clinical records (vitals, diagnoses, allergies, consultations, prescriptions, nursing notes, medication administration, discharge summaries), uploaded documents (PNG, JPEG, PDF), billing and payment records, staff accounts, audit logs, and appointment-reminder data (mobile numbers).

## Controls that exist

- **Isolation:** every record carries a hospital id, enforced in application code and by PostgreSQL row-level security (`docs/rls.md`). Cross-hospital access is tested.
- **Access:** permission-based roles enforced on the server; facility-level access; sign-ins rate-limited; refresh tokens revocable; inactive users blocked.
- **Audit:** important reads and writes create audit events (who, what, when, request id); the audit table is append-only (database rule, tested after restore).
- **Integrity:** signed clinical content and issued invoices are not overwritten; corrections keep history; no hard deletes of clinical or financial records (removed files are hidden, not erased).
- **Encryption:** passwords hashed (scrypt, ADR-009); backups encrypted (AES-256-GCM). HTTPS and disk or database encryption are deployment responsibilities (`docs/backup-runbook.md`) and are not verified here.
- **Logs:** structured, without passwords, tokens or clinical payloads.

## Gaps we know about

1. **Consent:** an append-only consent record now exists (API, a card on the patient record, no registration-form step): two purposes, method, notice version label, history kept, and reminders honour it (withdrawal cancels pending reminders; opt-in versus opt-out is a hospital setting, default opt-out). There is no notice text management, no other purpose checks consent, and which purposes and defaults are lawful is the open question. See [../privacy.md](../privacy.md).
2. **Patient rights:** a request log now exists (API, patient record button, Administration screen): access, correction, erasure or grievance, with status, due date and outcome, never deleted. It tracks requests only; it does not retrieve, correct or erase anything. No nominee rights; breach notification is only a draft checklist in [../privacy.md](../privacy.md).
3. **Retention:** no retention schedule and no deletion or anonymisation job. Clinical and financial records are never deleted by design; the legal minimum and maximum periods are undefined. Backups hold data for as long as the backup retention (`BACKUP_KEEP`, bucket lifecycle).
4. **Children and people lacking capacity:** no special handling.
5. **Roles:** who is the Data Fiduciary and who the Data Processor (hospital, software provider, hosting provider)? No data-processing agreement template exists.
6. **Hosting location and cross-border transfer:** not decided.
7. **Staff access:** broad "read patient" for clinical roles; no break-glass reason capture and no access-review report beyond the audit log.
8. **Reminders** are sent through a configured provider; provider, content and opt-out are not defined here.
9. **Medical-records rules** (record keeping, patient access to records) that apply to hospitals separately from DPDP.

## Questions

1. What notice and consent must be captured at registration, for which purposes, and in which languages?
2. What are the retention periods per record type, and may signed clinical records ever be erased or only anonymised?
3. What must the breach-response process contain, and who must be notified?
4. What contract terms are required between hospital and software or hosting provider?
5. Is the audit log itself personal data needing the same rules?
6. Must reminders require explicit opt-in?

## Expected deliverable

A gap list with the legal basis, required product changes (so we can scope them), required policy documents for hospitals, and what you did not cover.
