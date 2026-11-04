# Booking payment link and automatic cancellation

Builds on the booking fee (`booking-fee.md`). When a booking carries a fee, the patient can be sent a payment link on WhatsApp with a deadline; if the fee is still unpaid at the deadline, the appointment is cancelled automatically.

> **Placeholder.** The WhatsApp message is **not sent** and the link does **not open a payment page** yet. Delivery goes through a log-only provider (`PAYMENT_LINK_PROVIDER=log`) that records the message and writes a log line. The deadline and the automatic cancellation are real and tested. Until a real provider is connected, staff collect the fee with *Take fee* before the deadline.

## Configuration (Administration → Settings → Appointment booking fee)

| Setting | Meaning |
|---|---|
| `BOOKING_PAYMENT_LINK_ENABLED` | Create a payment link and deadline for fee-bearing bookings (default off). Needs the booking fee to be on. |
| `BOOKING_PAYMENT_WINDOW_MINUTES` | Minutes the patient has to pay after booking, 15 to 10080 (default 60). Never later than the appointment time. |

Environment: `PAYMENT_LINK_PROVIDER` (only `log`), `PAYMENT_LINK_BASE_URL` (default `https://pay.example.invalid/booking`, deliberately not a real address).

## How it works

1. **Booking** (fee-bearing appointments only, see `booking-fee.md`): a `BookingPaymentLink` is created in the same transaction with an unguessable token, the fee amount and `dueBy`. No link, and so **no deadline**, is created when the feature is off, the patient has no mobile number, or the patient has withdrawn consent for messages (the same rule as follow-up reminders). Those appointments simply wait for the fee.
2. **Sending:** the worker (`PaymentLinkWorker`, every `REMINDER_POLL_SECONDS`, off in tests) sends each link once. A failed send is retried after 5 and 10 minutes; the third failure is final, but the deadline still stands. The message has the doctor, facility, time, fee, window and link; no patient name or clinical detail.
3. **Settled early:** *Take fee* (paid) closes the link as `PAID`; *Skip fee* or a manual cancel / no-show closes it as `CANCELLED`. Closed links are never reopened (database trigger).
4. **Deadline passed:** the worker claims the link with `FOR UPDATE SKIP LOCKED`, locks the appointment and **re-checks** it: only an appointment that is still `BOOKED`, with its fee unpaid and not skipped, is cancelled (`cancelReason` "Booking fee not paid in time", link `EXPIRED`, pending reminders cancelled). Anything paid, skipped or cancelled a moment earlier is left alone. Several API instances never cancel the same booking twice.
5. **Audit:** `APPOINTMENT_AUTO_CANCELLED` with **no actor** (the system decided), the reason, the fee, what was paid, `dueBy` and the link id. The Appointments list shows the countdown ("Pay by … or this appointment is cancelled automatically") and, after the fact, "Cancelled automatically: the booking fee was not paid in time".

## Connecting a real WhatsApp provider

Implement `PaymentLinkProvider.send()` (`appointments/payment-link.provider.ts`), add its name to `PAYMENT_LINK_PROVIDER`, and register it in `createPaymentLinkProvider`. It must throw on failure, finish inside the transaction timeout, and never log message text or full phone numbers. WhatsApp business messages need pre-approved templates; the text is built in `paymentLinkText()`. Two pieces still need building for real payments: a payment page behind `PAYMENT_LINK_BASE_URL/<token>`, and a confirmation callback that records the payment by calling the same take-fee path as the cashier (idempotent, so a repeated callback cannot charge twice).

## Known limitations

- Message delivery and the payment page are placeholders (above).
- One deadline per appointment, set at booking; rescheduling does not restart it.
- Whether a payment-link message needs the patient's consent beyond the existing reminder consent is a legal question (`docs/reviews/pending-decisions.md`); today a withdrawn patient gets no link and no deadline.

Tests: `appointments/payment-link.spec.ts`.
