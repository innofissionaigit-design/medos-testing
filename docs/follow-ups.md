# Follow-up management

A follow-up is an ordinary appointment of type `FOLLOW_UP`, linked to the OPD consultation that ordered it. It is not a
separate scheduling system: booking, conflict detection, working hours, overbooking rules, rescheduling, cancellation,
check-in, the OPD queue and completion all use the existing appointment module (CLAUDE.md §8, §22).

## Statuses

The appointment status machine is unchanged. For follow-ups the UI shows `BOOKED` as **Scheduled**.

| Shown | Stored | Reached by |
|---|---|---|
| Scheduled | `BOOKED` | booking or rescheduling |
| Checked in / Waiting / In consultation | `CHECKED_IN` / `WAITING` / `IN_CONSULTATION` | reception check-in, then the OPD queue |
| Completed | `COMPLETED` | the doctor completes the visit |
| Cancelled | `CANCELLED` | cancellation with a reason (3–240 characters) |
| No-show | `NO_SHOW` | marked once the appointment time has arrived |

Completed, cancelled and no-show are final. The same rules are enforced by a database trigger (`medos_appointment_guard`).

## Who can do what

| Action | Permission | Roles |
|---|---|---|
| Schedule a follow-up from a consultation | `FOLLOWUP_SCHEDULE`, **and** being the doctor who saw the patient in that consultation | Doctor |
| See a consultation's follow-ups | `APPOINTMENT_READ` or `CONSULTATION_READ` | Doctor, Receptionist, Administrator |
| Reschedule / mark no-show / check in | `APPOINTMENT_UPDATE` (+ `QUEUE_MANAGE` to check in) | Receptionist |
| Cancel | `APPOINTMENT_CANCEL` | Receptionist |
| Patient appointment history, reminder history | `APPOINTMENT_READ` | Doctor, Receptionist, Administrator |
| Reminder settings | `ADMIN_SETTINGS` | Administrator |

The patient always comes from the consultation, never from the request. The follow-up may be assigned to another doctor
at the facility (for example a specialist); it then appears in that doctor's schedule.

## API

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/v1/encounters/:id/follow-ups` | Book a follow-up: `{ startAt, durationMinutes?, practitionerId?, notes? }` |
| GET | `/api/v1/encounters/:id/follow-ups` | Follow-ups ordered by this consultation |
| GET | `/api/v1/patients/:id/appointments` | The patient's appointments at this facility, newest first (paginated) |
| GET | `/api/v1/appointments?type=FOLLOW_UP&date=…&practitionerId=…` | A doctor's follow-ups for a day |
| GET | `/api/v1/appointments/:id/reminders` | Reminder history of one appointment |
| PATCH / POST | `/api/v1/appointments/:id`, `…/cancel`, `…/no-show`, `…/check-in` | Existing appointment routes |

Every appointment view now includes `followUpOfEncounterId` and `followUpOfVisit` (`{ encounterNumber, startedAt }`).

## Integrity

- `Appointment.followUpOfEncounterId` references the consultation. Database rules: only `FOLLOW_UP` appointments may be
  linked (`appointment_follow_up_type`); the consultation must be the same patient's and in the same tenant and facility
  (`medos_follow_up_link`, `medos_same_scope`); the link never changes once made.
- Conflicts are the existing exclusion constraints: a doctor cannot hold two live non-overbooked appointments at once,
  and a patient never holds two live appointments at once. Concurrent bookings serialise on advisory locks.
- Audit: `FOLLOW_UP_SCHEDULED` (with the consultation id), plus the existing `APPOINTMENT_*` events. A cancellation's
  audit record says how many pending reminders it cancelled.

## Reminders

### Lifecycle

| Event | Effect on reminders |
|---|---|
| Follow-up booked | One `PENDING` reminder per configured offset whose send time is still in the future |
| Rescheduled | Pending reminders → `CANCELLED`; new ones planned for the new time |
| Cancelled, no-show, checked in | Pending reminders → `CANCELLED` |
| Sent | `SENT`, with the provider's message id |
| Appointment moved/closed, time passed, or patient has no mobile at send time | `SKIPPED`, with the reason |
| Delivery failure | Retried after 5 and 10 minutes; the third failure is `FAILED` |

The database allows only one pending reminder per appointment and offset, and settled reminders (sent, failed,
cancelled, skipped) can no longer be changed or deleted.

A background worker in each API instance polls for due reminders. Each reminder is claimed with `FOR UPDATE SKIP LOCKED`
in its own short transaction, so several instances never send the same one, and it is checked against the appointment
again just before sending. Delivery is at-least-once: if the process dies after the gateway accepted a message but
before the commit, that reminder can be sent again.

The message is short and contains no patient name or clinical information:

> Reminder: your follow-up with Dr. *Name* at *Facility* is on Tue, 27 Oct, 10:30 am. Please bring your previous prescription.

### Facility settings (Administration → Settings)

| Key | Default | Meaning |
|---|---|---|
| `FOLLOWUP_REMINDERS_ENABLED` | `true` | Plan reminders for new and rescheduled follow-ups |
| `REMINDERS_REQUIRE_CONSENT` | `false` | `false`: remind unless the patient has withdrawn reminder consent; `true`: remind only patients with a recorded agreement. A withdrawal always stops reminders. Legal default pending: [reviews/pending-decisions.md](reviews/pending-decisions.md) (D1), [privacy.md](privacy.md) |
| `FOLLOWUP_REMINDER_OFFSETS_MINUTES` | `[1440]` | Minutes before the appointment (15 minutes to 7 days, up to 5 values). The settings page edits this in hours. |

Changes apply to follow-ups booked or rescheduled afterwards; already-planned reminders keep their times.

### Environment

| Variable | Default | Meaning |
|---|---|---|
| `REMINDER_PROVIDER` | `log` | Delivery provider. `log` is the only built-in one (see below). |
| `REMINDER_WORKER_ENABLED` | `true` | Run the reminder worker in this API instance (always off under `NODE_ENV=test`). |
| `REMINDER_POLL_SECONDS` | `60` | How often the worker looks for due reminders (10–3600). |

### No gateway is configured: what `log` does

The default `log` provider **does not send anything**. It marks each due reminder as sent and writes a structured log
line (`reminder_logged_not_sent`, with the reminder id and a masked number). The reminder history in the app labels these
"log only" and warns that no SMS gateway is configured.

### Sending real SMS

1. **Choose an Indian SMS gateway** (any provider with an HTTP API).
2. **DLT registration** (TRAI rule for commercial SMS in India): register the hospital as a principal entity with an
   operator's DLT portal, register a sender ID (header), and register the reminder text above as a *transactional /
   service-implicit* template with its variables. Messages that do not match a registered template are blocked. If you
   change the text in `reminderText()` (`apps/api/src/modules/follow-ups/reminders.service.ts`), re-register it.
3. **Implement the provider** in `apps/api/src/modules/follow-ups/reminder.provider.ts`: a class implementing
   `ReminderProvider` whose `send({ to, text, reminderId })` calls the gateway and returns `{ providerMessageId }`.
   It must throw on any failure (the worker retries), use a request timeout well under 30 seconds, and never log the
   message text or the full number. Add it to `createReminderProvider()` and to the `REMINDER_PROVIDER` enum in
   `apps/api/src/common/config.ts`, and read its credentials from environment variables (never from code).
4. **Configure** the API: `REMINDER_PROVIDER=<name>` plus the gateway's variables (typically an API key, the DLT
   principal entity id, sender id and template id), held in the secret manager.
5. **Check consent and retention** with the data-protection review (DPDP Act 2023, REMINDER.md): patients' mobile
   numbers are used for reminders.
6. **Test** with one internal number, then watch `reminders_processed` / `reminder_delivery_failed` logs and the
   reminder history screen.
