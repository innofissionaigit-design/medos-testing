# Telemedicine

## Purpose
Lets a doctor consult a patient by video. A booked appointment is made a video consultation; at the time, the doctor and the patient each open the same video room from MedOS. The consultation, prescription and bill are the appointment's normal visit, so nothing about clinical documentation or billing is different.

MedOS does not carry the video. The hospital chooses a video service (for example one it hosts itself) and enters its address as a template in Administration → Settings (`TELECONSULT_VIDEO_URL`), with `{room}` where each consultation's room name goes, for example `https://video.example.org/{room}`. Until that is set, video consultations cannot be made. The room name is random and different for every consultation (`medos-` plus 32 random characters) and is never shown in any list.

## Workflow
1. Reception books the appointment as usual, then presses **Make video** on the appointment (Appointments page). Only a booked, upcoming appointment can be made a video consultation, once.
2. The patient sees it in the patient app under their coming-up appointments, marked "video consultation".
3. **Telling the patient.** When the appointment is made a video consultation the patient gets an email (if email is on and they agreed; `docs/email.md`) saying when it is and how to join from the patient app, and, `TELECONSULT_REMINDER_MINUTES` (default 10) before the time, a text message (if reminders are on and they agreed). Neither contains the video room's address. Cancelling the video consultation stops the pending reminder.
4. **Fee (optional).** Each doctor can have their own video fee (Administration, Doctors and departments, Edit: *Video fee*; empty means the hospital's, 0 means free for that doctor). Without one, `TELECONSULT_FEE_AMOUNT` is used. When the fee is above 0 it is put on the appointment as its booking fee when it is made a video consultation (once; an appointment that already has a fee keeps that fee, and a fee, once set, is fixed). It is taken, skipped and given back exactly like a booking fee (`docs/booking-fee.md`). With `TELECONSULT_PAY_BEFORE_JOIN` on, neither the doctor nor the patient can join until it is paid or skipped (`BOOKING_FEE_PENDING`); the patient app tells the patient what is due and where to pay.
5. **Waiting room.** From 15 minutes before the time (until 90 minutes after it) the patient presses **I am here** in the app, after agreeing to a video consultation (the agreement, its wording version `TELE-1` and the time are recorded and cannot be changed). The doctor gets a notification and the Video consultations screen shows **patient is waiting**. The patient's page shows a Join button as soon as the doctor starts; the patient is never given the room's link before the doctor has started.
6. **Identity check.** The doctor presses **Start call**, says how they confirmed who the patient is (knows the patient, photo ID shown on camera, signed in to the patient app, other) and presses **Confirm and start**. Who confirmed it, when and how is recorded and cannot be changed; rejoining needs no second check.
7. The doctor ends the call. The visit's notes, prescription and bill are done on the normal visit.
8. **Moving the appointment.** If the appointment is rescheduled to another time with the same doctor, a video consultation that has not started moves with it (the join window and the text reminder follow). If it is moved to another doctor, the video consultation is cancelled with the reason "moved to another doctor" and can be made again. A call already in progress is not changed.
9. Before the call starts, the front desk can cancel it with a reason; the appointment stays and can be made a video consultation again.

## Who may do what
Only the appointment's own doctor can join as the doctor. Other doctors, nurses and reception cannot, even with the link to the page. The patient must be signed in to the patient app with the mobile number registered to that patient. A cancelled, missed or finished appointment, or a call outside the time window, cannot be joined.

## Permissions
`TELE_READ` (see video consultations), `TELE_MANAGE` (make and cancel; reception and administrator), `TELE_CONDUCT` (join and end; doctors). A doctor sees only their own video consultations; the front desk sees all.

## Audit events
`TELECONSULT_CREATED`, `TELECONSULT_FEE_SET`, `TELECONSULT_RESCHEDULED`, `TELECONSULT_PATIENT_WAITING` (with whether and which consent wording was given), `TELECONSULT_IDENTITY_CHECKED` (with the method), `TELECONSULT_DOCTOR_JOINED`, `TELECONSULT_PATIENT_JOINED`, `TELECONSULT_ENDED`, `TELECONSULT_CANCELLED`.

## Database rules
A video consultation must match its appointment (same patient, doctor, facility and time) and there is only one live one per appointment. It is never deleted, cannot move to another appointment, patient, doctor or time, and cannot be completed unless it started. The patient's consent (with its wording version), the arrival and join times and the identity check cannot be changed or removed. A booking fee can be added to a booked appointment that has none (a video fee), once, before check-in; any other change is refused. The patient cannot be recorded as joined without consent.

## API
Staff: `GET /teleconsults`, `POST /teleconsults`, `POST /teleconsults/:id/join` (the first time with `{ "identityMethod": "KNOWN_PATIENT" | "PHOTO_ID_SHOWN" | "APP_SIGN_IN" | "OTHER" }`), `POST /teleconsults/:id/end|cancel`. Patient app: `POST /patient-portal/teleconsults/:id/arrive` and `/join` (with `{ "consent": true }` the first time; `join` answers `WAITING_FOR_DOCTOR` until the doctor has started); the appointment list in the patient app carries the video details.

## Known limitations and things to decide
- **The video service is the hospital's responsibility.** A public video service with an unguessable room name is not private: anyone who has the link can enter. Prefer a service the hospital hosts, with a waiting room or authentication.
- No recording, chat, file sharing or screen sharing inside MedOS. MedOS does not carry the video itself: building its own video service (media servers, TURN relays, scaling) is a separate project, so the hospital connects a service it trusts, preferably one it hosts, in the settings (`docs/backlog.md`).
- The waiting room is MedOS's own (arrival, doctor started); the video service's lobby is not used or controlled.
- The patient pays at the counter: the patient app cannot take payment, because that needs an account with a payment gateway (the payment page in `booking-payment-link.md` is a placeholder). No email says the appointment was moved.
- Home care and connected remote monitoring are not built (`docs/backlog.md`).
- Joining from the app needs the mobile number registered to the patient: that is how the app knows it is the right person, so it is deliberately not relaxed.
- The patient must have the mobile number registered; a patient without one cannot join from the app.
- Telemedicine practice rules (patient identity check, advice limits for certain medicines, record of the consultation mode) are for the hospital to apply. See `docs/backlog.md`.

## Video consultations on the visit and the printed prescription
The visit screen shows a **Consulted by video** badge for any visit whose appointment has a video consultation that was not cancelled. The printed prescription adds the line **Consultation: Consulted by video** only when the patient actually joined the call (a video consultation that was booked but never took place is not printed as one).
