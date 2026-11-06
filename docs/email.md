# Email

Email from the hospital to its patients: an appointment is booked or cancelled, a report is ready, and a receipt that staff choose to send. Administrators reword the emails, test them, read the delivery log and keep a do-not-email list. It is **not** a mailbox: MedOS sends email, it does not receive or read it.

## What is sent

| Email | When | Contains |
|---|---|---|
| Appointment booked | An appointment is booked in advance (not a walk-in) | Patient's first name, doctor, date and time, facility |
| Appointment cancelled | By staff, by the patient, or automatically for an unpaid booking fee | The same |
| Report ready | A laboratory or radiology report is released (the first version only) | First name and facility. **Never a test name, a value or a finding** |
| Payment receipt | Staff press **Email receipt** on a bill that has been paid | First name, bill number, amount paid |
| Test email | An administrator sends one to check that email works | A line of text |

No email carries clinical content, an attachment, a mobile number or a record number. A report email tells the patient to collect it or use the patient app.

## When an email is queued

All of these must hold, checked when the event happens **and again just before sending**:

1. Email is switched on for the facility (`EMAIL_ENABLED`, off by default).
2. The patient has an email address on the record (Patient → Edit, or at registration).
3. The patient has agreed to email (the consent **Appointment, receipt and report emails** on the patient's privacy card), or the hospital has chosen "email unless the patient objects" (`EMAIL_REQUIRE_CONSENT` off). **A patient who withdrew is never emailed.** Which setting is right is a legal decision recorded in `reviews/pending-decisions.md`.
4. The address is not on the do-not-email list.

If a check fails the email is simply not queued (or, at send time, marked **skipped** with the reason). A test email needs no patient.

## How it is sent

Screens and workflows only **queue** an email, in their own database transaction (a row in `EmailOutbox` holding the finished subject and text). A background worker sends it every `EMAIL_POLL_SECONDS` (30 s). A slow or failing email provider therefore never slows down or breaks a booking or a payment.

* Safe on several API servers: due emails are claimed with `FOR UPDATE SKIP LOCKED`, so each is sent once.
* A failure is retried up to 5 times with growing delays (1, 2, 4, 8 minutes, at most 1 hour), then marked **failed**. Staff can try it again from the log.
* The same event never emails the same address twice (a `dedupeKey` such as `APPOINTMENT_BOOKED:<appointment id>`). Pressing Email receipt again for the same amount does nothing.
* The error kept in the log is a short, safe sentence: never the provider's raw reply, the address or the text.

## Connecting an email service

Set on the server (docs/deployment.md, `.env.example`):

| Setting | Meaning |
|---|---|
| `EMAIL_PROVIDER` | `log` (default: emails are recorded, nothing is sent; the log says "not really sent") or `http` |
| `EMAIL_API_URL` | The hospital's email service. https in production; a private or internal address is refused |
| `EMAIL_API_KEY` (or `EMAIL_API_KEY_FILE`) | Sent as a bearer token |
| `EMAIL_FROM_ADDRESS` | The sender address your email service has verified. SPF, DKIM and DMARC are set in DNS, not in MedOS |
| `EMAIL_TIMEOUT_MS`, `EMAIL_WORKER_ENABLED`, `EMAIL_POLL_SECONDS` | Timeout, worker on/off, how often it looks |

With `http`, each email is one POST: `{ "from": {"email","name"}, "to": [{"email"}], "replyTo", "subject", "text", "html", "reference" }`. Any 2xx answer means accepted; the provider's id is read from `id`, `messageId` or `data.id`. A service that wants another shape (Amazon SES, SendGrid, an SMTP relay) needs a small adapter in front of it. SMTP is not built in because it needs a new software package (backlog).

## Settings (Administration → Email, or Settings API)

`EMAIL_ENABLED`, `EMAIL_REQUIRE_CONSENT`, `EMAIL_FROM_NAME` (default: the facility name), `EMAIL_REPLY_TO`, `EMAIL_LANGUAGE` (English, Bengali or Hindi). Settings are per facility and need `ADMIN_SETTINGS`.

## Wording

Each email has built-in wording in English, Bengali and Hindi. An administrator can change the subject and text of any email in any language; the change applies to emails queued afterwards. Placeholders are written `{name}`; only the ones listed for that email are allowed, and unknown ones, stray brackets and a multi-line subject are refused. "Use built-in wording" removes the change. Every edit is audited by template and language, not by its words.

## Permissions

| Permission | Allows |
|---|---|
| `EMAIL_MANAGE` | Wording, test email, retry or cancel an email, the do-not-email list (Administrator) |
| `EMAIL_LOG_READ` | Read the delivery log, wording and do-not-email list (Administrator) |
| `INVOICE_READ` | Email a receipt from a bill |
| `ADMIN_SETTINGS` | The settings above |

Existing hospitals get the two new permissions on their Administrator role through a data migration, with an audit event.

## API (all `/api/v1`)

`GET /email/status` · `GET /email/templates` · `PUT|DELETE /email/templates/:key/:language` · `POST /email/templates/:key/:language/preview` · `POST /email/test` · `GET /email/outbox` · `POST /email/outbox/:id/retry|cancel` · `GET|POST /email/suppressions` · `DELETE /email/suppressions/:id` · `POST /invoices/:id/email-receipt`.

## Audit events

`EMAIL_TEMPLATE_SAVED`, `EMAIL_TEMPLATE_RESET`, `EMAIL_TEST_QUEUED`, `EMAIL_RETRIED`, `EMAIL_CANCELLED`, `EMAIL_SUPPRESSION_ADDED`, `EMAIL_SUPPRESSION_REMOVED`, `RECEIPT_EMAIL_QUEUED`; consent changes are audited as for any consent (`CONSENT_GRANTED`, `CONSENT_WITHDRAWN`). Each email's own record is the outbox row.

## Data

`Patient.email` (checked for shape); `EmailOutbox` (rendered subject and text, status, attempts, a safe last error, the provider's id); `EmailTemplate` (a hospital's own wording, versioned); `EmailSuppression`. All three tables have tenant row-level security; the outbox links to the patient through a same-hospital trigger. The worker finds hospitals with emails due through `medos_tenants_with_due_emails`.

## Privacy and safety

* The list and log show a masked address (`a***@example.org`). Logs never contain addresses, subjects or text.
* Subjects are one line; addresses are plain; sizes are bounded (database constraints as well as the API). Template values have line breaks removed and are HTML-escaped.
* The email provider's address is checked like every outside address (no private networks, https in production).
* Test emails are limited to 5 an hour per person.

## Tests

`apps/api/src/modules/email/email.spec.ts`, plus checks in the lab, radiology and booking-payment-link specs: off by default; permissions; consent, withdrawal, missing address and suppression; the worker (two at once, retries, give-up, re-check at send time); wording (placeholders, header injection, reset, other hospitals untouched); the log (masking, retry and cancel, other hospitals refused); test email limits; receipts; and that no email contains a mobile number, record number or clinical text.

## Known limitations

* Not tested against a real email service: only against a local stand-in.
* No SMTP, no attachments (a printed receipt or PDF is not attached), no bounce or unsubscribe webhooks from the provider (a bounced address is added to the do-not-email list by hand), no patient language preference (one language per facility), no per-person choice of which emails to receive.
* Appointment moved (rescheduled) does not email; it is a later item.
* A person who only reads the log (`EMAIL_LOG_READ`, without `EMAIL_MANAGE`) is not shown the Email tab yet.
