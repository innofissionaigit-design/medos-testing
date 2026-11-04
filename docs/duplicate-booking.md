# Duplicate bookings

A booking is stopped (`409 DUPLICATE_BOOKING_SUSPECTED`) when **this patient**, or a patient who **looks like the same person**, already has a live booking (booked, checked in, waiting or in consultation) that is:

| Rule | Meaning |
|---|---|
| `SAME_DOCTOR` | with the same doctor, and not yet over (any date) |
| `SAME_DEPARTMENT_SAME_DAY` | with another doctor of the same department, on the same day |

"Looks like the same person" uses the patient duplicate rules (`patient.domain.ts`) **without the mobile number**, because the case this catches is the same person registered twice with a different number: a similar name with the same date of birth, or a similar name with the same gender and an age within two years.

Checked on: booking (`POST /appointments`), walk-in / Start OPD visit (`POST /appointments/walk-in`) and moving a booking (`PATCH /appointments/:id`, the booking itself is left out). Not checked: follow-ups booked from a consultation (a planned repeat), cancelled, no-show and completed bookings.

The response lists the clashing bookings (patient, MRN, doctor, time, rule). Staff with `DUPLICATE_OVERRIDE` (receptionists by default) can **book anyway** by sending `duplicateOverride: { reason }`; that is audited as `APPOINTMENT_DUPLICATE_OVERRIDDEN` with the reason and the clashing bookings. Without the permission the answer is 403.

To fix the cause, merge the two patient records (`patient-merge.md`).

Tests: `appointments/booking-changes.spec.ts`.
