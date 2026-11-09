# Booking an appointment against a doctor's schedule

## Purpose
How the front desk books a patient into a free time of a doctor, what the server guarantees when several people book at once, and what the booking API expects. Related: `docs/wards-and-doctors.md` (weekly schedules), `docs/duplicate-booking.md`, `docs/booking-fee.md`.

## On the screen
Appointments → **Book**: choose the patient, the doctor and the date, then one of the **free times** (taken and past times are greyed out), then **Book**. The patient must already be registered (Patients first). The times come from the doctor's weekly schedule (Administration → Doctors and departments).

- The appointment takes the **length of that slot** (a 30-minute session gives 30-minute appointments, a 10-minute one gives 10). Before this was fixed the screen always asked for 15 minutes, which in 10-minute slots also used up the next slot.
- If someone else takes the time first, the screen says so, refreshes the free times and asks for another.
- Pressing **Book** again after a lost answer (a slow network) returns the first booking instead of failing as "already booked": each exact request carries its own Idempotency-Key.

## What the server guarantees
- **Only free times.** A booking must lie inside one of the doctor's sessions on that weekday, in the facility's time zone, or it is refused (`SLOT_UNAVAILABLE`, 409). The screen offers only the slot starts that are still free. A doctor whose schedule was never saved is open at any time; one whose saved schedule has no sessions cannot be booked.
- **No double booking, even at the same instant.** Bookings for one doctor, and for one patient, take a database lock in a fixed order, and the database itself refuses an overlap with an exclusion constraint, so even a request that skipped the application could not double-book. Adjacent times are fine; cancelled and no-show appointments free their time. Of 12 simultaneous requests for one slot exactly one succeeds and the rest get `SLOT_UNAVAILABLE`. One patient also cannot hold two live appointments at the same time, even with different doctors.
- **Overbooking is deliberate.** Only a person with `APPOINTMENT_OVERBOOK`, with a reason, can book outside the sessions or on a taken time (audited as `APPOINTMENT_OVERBOOKED`). The regular slot stays protected. On the screen it is the tick box "Book outside the free times (exception, needs a reason)" in the Book dialog, with a time, minutes and the reason; it appears only for people who hold the permission. No built-in role has it: an administrator adds it to a trusted custom role. A patient still cannot be in two appointments at the same time.
- Booking in the past is refused (a few minutes of grace). Another hospital's or facility's doctor or patient is "not found". A possible duplicate booking (same patient, same doctor or department and day) needs a deliberate override (`docs/duplicate-booking.md`).
- The tenant, facility and department come from the signed-in session and the doctor's record, never from the request.

## API
`GET /practitioners/:id/availability?date=YYYY-MM-DD` returns the day's slots with `available`. `POST /appointments` with `patientId`, `practitionerId`, `startAt` (ISO time with offset) and optionally `durationMinutes` (5 to 240; left out, it is the slot length, or 15 minutes for a doctor with no schedule). Send an `Idempotency-Key` header to make a retry safe: the same key and request returns the first booking (200, `Idempotent-Replayed: true`); the same key with a different request is refused. Outside systems should book only the start times that availability returns: the server accepts any start inside a session that does not overlap another booking, so a start between slot times is allowed and would use up two slots. Rescheduling (`PATCH /appointments/:id`) follows the same rules.

## Audit and permissions
`APPOINTMENT_CREATE` to book, `APPOINTMENT_READ` to look, `APPOINTMENT_OVERBOOK` to overbook. Audit: `APPOINTMENT_CREATED`, `APPOINTMENT_OVERBOOKED`, `APPOINTMENT_DUPLICATE_OVERRIDDEN`.

## Known limitations
The server does not insist that a start is exactly on a slot time (the screen only offers slot starts; a bot that books in between wastes part of a slot). The screen does not register a new patient while booking. The free-time list is read when opened, so a time taken a moment later is only discovered when booking (and then refreshed). No waiting list for a full doctor.

Tests: `modules/appointments/appointments.spec.ts` (double booking, 12 parallel requests, database constraint, overbooking, schedules, slot length), `modules/appointments/booking-changes.spec.ts`.
