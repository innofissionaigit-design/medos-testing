# ADR-013: Email through a queue (outbox) and a worker, with consent checked twice

**Status:** Accepted.

## Context
Hospitals want to email patients (appointment, receipt, "report ready"). Email is slow and unreliable, patients' agreement matters under the DPDP Act, and a medical record must not leak through an email. The system already queues reminders and payment links through workers (ADR-009 style), has no Redis, and may run several API servers.

## Decision
1. **A queue, not a call.** Workflows only write a row to `EmailOutbox` in their own transaction. A worker sends later (`FOR UPDATE SKIP LOCKED`, retries with back-off, gives up after 5). A failing provider never breaks a booking or a payment.
2. **Consent is checked when queueing and again when sending.** A patient who withdraws between the two is skipped. A withdrawal is always respected; whether "no answer" means yes or no is the hospital's setting (`EMAIL_REQUIRE_CONSENT`, default: needs agreement).
3. **No clinical content in any email**, no attachments, no mobile or record number. "Report ready" says only that a report is ready.
4. **A provider interface** with a log-only default and one generic HTTP provider (the same shape as the existing message provider, with the same outside-address safety checks). Real services connect through a small adapter.
5. **Wording is data.** Built-in English, Bengali and Hindi text in code; a hospital's own wording in `EmailTemplate`, with a fixed list of placeholders per email so a template cannot reach other data.
6. **Masked addresses** in the log and lists; sizes and shapes enforced by database constraints as well as the API.

## Alternatives considered
* **Send inside the request:** simpler, but one slow provider slows every booking, and a failure would have to roll back or lose the email.
* **SMTP built in (a package such as nodemailer):** familiar, but a new dependency the project does not have; deferred.
* **Redis or a job library:** a new service to run and secure (ADR-009).
* **Attach the receipt or report as a file:** convenient, but spreads clinical and financial documents through email; deferred until there is a secure-link design.
* **A mailbox or inbox in MedOS:** a different product; out of scope.

## Consequences
* An email goes out within about a minute, not instantly.
* Delivery depends on the hospital's email service and DNS records; the system cannot check those.
* The legal default for "no answer" is a pending decision (`reviews/pending-decisions.md`); the safe default is "needs agreement".
