# Patient app

## Purpose
A phone-first page for patients at `/patient`. A patient signs in with a code sent to the mobile number the hospital has on record, then sees their appointments, signed visits and prescriptions, lab and radiology reports, and bills, and can ask for an appointment. It is a web app that works on any phone browser; a native app store app is not part of this work.

## Installing it on a phone
The page can be installed on a phone's home screen so it opens like an app, with its own icon and no browser bars: on Android (Chrome) an **Install** button appears at the bottom of the page; on an iPhone the page says to tap Share, then Add to Home Screen. It is a web app, not an app-store app: publishing to Google Play or the Apple App Store needs developer accounts, store review and a wrapper, which are not part of this work. A small service worker serves a plain "you are offline" page when there is no connection. It stores **nothing** of the patient's: no pages, no data, no API answers, so records are never kept on the phone by the app and never shown from an old copy. Files: `apps/web/public/patient/` (manifest, icons made by `scripts/make-patient-icons.mjs`, `sw.js`, `offline.html`).

## Sign-in
1. The patient enters the hospital code and their mobile number. The answer is always "a code is on its way if this number is registered", whoever asks, so the form cannot be used to find out who is a patient.
2. A six-digit code goes by SMS through the hospital's message provider (the same provider as prescription links). It works for 5 minutes, allows 5 wrong tries, works once, and only a keyed hash is stored. One number can ask for 3 codes in 15 minutes.
3. The correct code opens a session of 12 hours. The token is kept in an httpOnly cookie of its own by the web server and is never shown to page JavaScript. Only a hash is stored in the database. The patient can sign out, which ends the session.
4. Everything is off until the hospital switches on the setting `PATIENT_PORTAL_ENABLED` (Administration → Settings). Switching it off ends every session at once.

Nothing is logged: not the code, not the token, not the full number.

## Whose records
A session is for a mobile number, and the code only proves the person holds the phone. Every request names the patient and the server checks the number owns that patient; another number's patient, another hospital's patient or an invented id all give "not found". Patient tokens open no staff route and staff tokens open no patient route.

**Shared numbers.** When one patient is registered on the number, the code is enough. When several are (a family sharing a phone), the switcher lists them by first name only, and each person must confirm **their own date of birth** before their records, appointments, bills or requests open (`POST /patient-portal/unlock`). Confirming one person opens nobody else. Until then the API answers `403 PROFILE_LOCKED` for every route that names that patient, including appointment requests and joining a video call.
- A correct answer returns a signed proof tied to that session and patient (valid 2 hours, useless after sign-out or in another session). The web gateway keeps proofs in an httpOnly cookie and forwards them; the page never sees them.
- Five wrong answers for a patient within an hour lock confirming for that patient (`429`), across sessions, so signing in again does not reset the count. Every try is audited (`PATIENT_APP_UNLOCK_FAILED`, `PATIENT_APP_PROFILE_UNLOCKED`).
- A patient with only an estimated age (no date of birth) cannot be confirmed on a shared number; the app tells them to ask the front desk to add one.

## What they see
- **Appointments**: coming up and earlier.
- **Visits and prescriptions**: only signed notes; diagnosis, advice and the signed prescription's medicines. Drafts are never shown.
- **Reports**: verified lab reports with ranges and flags, signed radiology reports. A report with a critical value is held back until the doctor has acknowledged it, and the patient is told "a report needs your doctor to look at it first".
- **Bills**: issued invoices with total, paid and to-pay, and receipts. There is no online payment: the patient pays at the counter.
- **Appointment requests**: preferred day, time of day, optional doctor, reason. Up to 3 can wait at once; the patient can cancel a waiting one. The front desk sees them on the Appointments page, books the appointment as usual, and answers (booked or declined with a reason the patient can read).

## Permissions and audit
Patients have no permissions or roles. The front desk uses `APPOINTMENT_READ` to see requests and `APPOINTMENT_CREATE` to answer them. Audit events: `PATIENT_APP_SIGNED_IN`, `PATIENT_APP_SIGNED_OUT`, `PATIENT_APP_PROFILE_UNLOCKED`, `PATIENT_APP_UNLOCK_FAILED`, `APPOINTMENT_REQUESTED`, `APPOINTMENT_REQUEST_CANCELLED`, `APPOINTMENT_REQUEST_ANSWERED` (patient actions have no staff user; the metadata says `actor: PATIENT`).

## Database rules
Codes cannot be deleted, reused or have their wrong tries reduced. Sessions cannot be deleted, revived after sign-out or moved to another number. Appointment requests cannot be deleted or changed once answered or cancelled. All three tables use row-level security.

## API
Sign-in: `POST /patient-portal/auth/code`, `POST /patient-portal/auth/verify`. With a patient token: `POST /patient-portal/unlock` (`{ patientId, dateOfBirth }`), `GET /patient-portal/me|doctors`, `GET /patient-portal/appointments|visits|reports|bills|appointment-requests?patientId=`, `POST /patient-portal/appointment-requests`, `POST /patient-portal/appointment-requests/:id/cancel`, `POST /patient-portal/logout`. Staff: `GET /appointment-requests`, `POST /appointment-requests/:id/answer`.

## Known limitations
Installable web page (above), not a store app; no push notifications; SMS code only (the provider must be connected); no online payment, no direct booking (a request, answered by the front desk), no downloads or PDFs of reports and prescriptions yet; records of a patient who was merged into another are not shown; the hospital is the tenant's first active facility; old codes and sessions are kept (no clean-up job yet). Telemedicine is a separate item. See `docs/backlog.md`.
