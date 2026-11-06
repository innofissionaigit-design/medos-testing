# Telemedicine

## Purpose
Lets a doctor consult a patient by video. A booked appointment is made a video consultation; at the time, the doctor and the patient each open the same video room from MedOS. The consultation, prescription and bill are the appointment's normal visit, so nothing about clinical documentation or billing is different.

MedOS does not carry the video. The hospital chooses a video service (for example one it hosts itself) and enters its address as a template in Administration → Settings (`TELECONSULT_VIDEO_URL`), with `{room}` where each consultation's room name goes, for example `https://video.example.org/{room}`. Until that is set, video consultations cannot be made. The room name is random and different for every consultation (`medos-` plus 32 random characters) and is never shown in any list.

## Workflow
1. Reception books the appointment as usual, then presses **Make video** on the appointment (Appointments page). Only a booked, upcoming appointment can be made a video consultation, once.
2. The patient sees it in the patient app under their coming-up appointments, marked "video consultation".
3. From 15 minutes before the time (until 90 minutes after it), the doctor presses **Start call** on Video consultations; the patient presses **Join video call** in the app. The patient must tick that they agree to a video consultation the first time; the agreement and the time are recorded and cannot be changed.
4. The doctor ends the call. The visit's notes, prescription and bill are done on the normal visit.
5. Before the call starts, the front desk can cancel it with a reason; the appointment stays and can be made a video consultation again.

## Who may do what
Only the appointment's own doctor can join as the doctor. Other doctors, nurses and reception cannot, even with the link to the page. The patient must be signed in to the patient app with the mobile number registered to that patient. A cancelled, missed or finished appointment, or a call outside the time window, cannot be joined.

## Permissions
`TELE_READ` (see video consultations), `TELE_MANAGE` (make and cancel; reception and administrator), `TELE_CONDUCT` (join and end; doctors). A doctor sees only their own video consultations; the front desk sees all.

## Audit events
`TELECONSULT_CREATED`, `TELECONSULT_DOCTOR_JOINED`, `TELECONSULT_PATIENT_JOINED` (with whether consent was given then), `TELECONSULT_ENDED`, `TELECONSULT_CANCELLED`.

## Database rules
A video consultation must match its appointment (same patient, doctor, facility and time) and there is only one live one per appointment. It is never deleted, cannot move to another appointment, patient, doctor or time, and cannot be completed unless it started. The patient's consent and the join times cannot be changed or removed. The patient cannot be recorded as joined without consent.

## API
Staff: `GET /teleconsults`, `POST /teleconsults`, `POST /teleconsults/:id/join|end|cancel`. Patient app: `POST /patient-portal/teleconsults/:id/join` (with `{ "consent": true }` the first time); the appointment list in the patient app carries the video details.

## Known limitations and things to decide
- **The video service is the hospital's responsibility.** A public video service with an unguessable room name is not private: anyone who has the link can enter. Prefer a service the hospital hosts, with a waiting room or authentication.
- No recording, chat, file sharing or screen sharing inside MedOS; no automatic reminder messages with the link; no joint waiting room (the doctor and patient meet when both are in the room).
- The patient must have the mobile number registered; a patient without one cannot join from the app.
- Telemedicine practice rules (patient identity check, advice limits for certain medicines, record of the consultation mode) are for the hospital to apply. See `docs/backlog.md`.

## Video consultations on the visit and the printed prescription
The visit screen shows a **Consulted by video** badge for any visit whose appointment has a video consultation that was not cancelled. The printed prescription adds the line **Consultation: Consulted by video** only when the patient actually joined the call (a video consultation that was booked but never took place is not printed as one).
