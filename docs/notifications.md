# Notifications (in-app, live)

A bell in the top bar tells staff that something needs them, without refreshing a screen. It is for staff; patients are not notified here (patient push messages are in `backlog.md`).

## What notifies whom

| Event | Who is told | Opens |
|---|---|---|
| A critical lab result is verified or amended | The doctor of that visit | LIS → Pathology |
| A critical radiology finding is signed or amended | The doctor of that visit | LIS → Radiology |
| A patient joins a doctor's queue | That doctor | OPD queue |
| A prescription is signed | Pharmacy staff who may dispense (`PHARMACY_DISPENSE`) | Pharmacy |
| A pharmacy bill is issued | Cashiers (`PAYMENT_CREATE`) | Billing |
| A booking is made by another system or a voice bot (API key), or a patient asks for an appointment in the patient app | Reception (`APPOINTMENT_CREATE`) | Appointments |
| A booking is cancelled automatically because its fee was not paid | Reception (`APPOINTMENT_CANCEL`) | Appointments |

Only active staff of the facility are told. API keys (bots) and switched-off logins never are. A critical result also appears as a red banner at once.

## What a notification contains

A type, what it points at (for example "QueueEntry" and its id), a time and whether it was read. **No patient name, number or clinical text**: the wording is fixed per type and the screen it opens applies the reader's own permissions. Each person sees only their own, for the facility they are working in.

## How it works

* The notification is written in the **same database transaction** as the event, so it cannot be lost or sent for something that did not happen. The same event never notifies the same person twice (`dedupeKey`).
* The **live channel** is server-sent events (`GET /api/v1/notifications/stream`, through the web app's proxy). It only says "the unread count or newest notification changed"; the browser then fetches the list.
* **Instant:** when the transaction that wrote a notification **commits**, the API tells that person's open streams on the same server straight away (`afterCommit` in `common/after-commit.ts`; nothing is sent if the transaction rolls back). The bell, the tab title and a small pop-up update within a fraction of a second.
* **Safety net:** each stream also looks at the caller's own notifications every 3 seconds, which covers an event committed by *another* API server (ADR-012, amended). No extra software or database connection is needed.
* If the stream is not open the bell **asks every 20 seconds** instead. A stream closes after 10 minutes and the browser reconnects, which re-checks the session. If the server refuses a connection (expired session, too many streams) the browser would give up for good, so the bell reconnects by itself, waiting longer each time up to 30 seconds. At most 5 streams per person per API server.
* The web app's proxy marks the stream `no-transform` / `X-Accel-Buffering: no` so compression or a reverse proxy cannot hold it back, and it cancels the API call when the browser closes the stream.
* The tab title shows the unread count. A new notification also pops up for a few seconds (red and longer for a critical result).
* A person's read notifications older than 90 days are removed when they open the list.

## API (all `/api/v1`, the caller's own only)

| Method | Path | |
|---|---|---|
| GET | `/notifications?unread=true&page=&pageSize=` | List with `meta.unread` |
| GET | `/notifications/unread-count` | |
| POST | `/notifications/:id/read` | Someone else's or a made-up id is "not found" |
| POST | `/notifications/read-all` | |
| GET | `/notifications/stream` | Server-sent events: `notify` and `ping` |

No special permission is needed to read your own notifications.

## Data

Table `Notification` (migration `notifications`): tenant, facility, recipient, type, entity type and id, dedupe key, created and read times. Tenant row-level security like every tenant table; a composite foreign key keeps the recipient and facility in the same hospital.

## Adding an event

Call `NotificationsService.notifyPermission(tx, [permission], {...})` (or `notify` for one person) inside the transaction that causes the event, add the type to the enum and to `KINDS` in `apps/web/src/components/notifications.tsx`, and add its Bengali and Hindi text.

## Tests

`apps/api/src/modules/notifications/notifications.spec.ts`: the right people only; no names in the payload; one notification per event; another person's, another hospital's, malformed and unauthenticated access refused; inactive people skipped; repeats refused by the database; the live stream over a real connection, including that a new notification reaches an open stream within 1.5 seconds with the periodic check switched off (so only the push at commit can have delivered it). `apps/api/src/common/after-commit.spec.ts`: hooks fire after commit, not on failure, not across overlapping transactions.

## Known limitations

* Medication-due and low-stock alerts are not notifications yet.
* The instant push reaches only streams open on the **same API server** that committed the event; with several API servers the others notice within about 3 seconds. Closing that gap needs PostgreSQL LISTEN/NOTIFY or Redis (ADR-012).
* A reverse proxy in front of the web app must not buffer `text/event-stream` (nginx honours `X-Accel-Buffering: no`; other proxies need the equivalent setting).
* Notifications are not sent by email or SMS (email is planned: `backlog.md`).
* One stream per browser tab.
