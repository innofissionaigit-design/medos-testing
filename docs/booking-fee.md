# Appointment booking fee (with a skip for special cases)

A fee asked for when an appointment is booked, off by default. Staff with the right permission can skip it in a special case, with a reason that is recorded.

## Configuration (Administration → Settings → Appointment booking fee)

| Setting | Meaning |
|---|---|
| `BOOKING_FEE_ENABLED` | Ask for a fee on new bookings (default off). |
| `BOOKING_FEE_AMOUNT` | The fee in rupees, at most 2 decimals; 0 means no fee. |
| `BOOKING_FEE_SKIP_REASONS` | The reasons staff can choose when skipping (default: Emergency, Staff or family, Free camp, Referral, Financial hardship). |

Settings are per facility. Changing them affects appointments booked **afterwards**: each appointment keeps the fee it was booked with (`Appointment.bookingFee`, fixed by a database trigger).

## Which bookings carry a fee

Ordinary appointments (consultation, procedure) booked from Appointments. **Not** follow-ups booked from a consultation, and not walk-ins.

## How it works

1. Booking records the fee on the appointment. The Appointments list shows "Booking fee ₹300 · ₹300 to pay".
2. **Check-in is blocked** (`BOOKING_FEE_PENDING`, with the amount due) until the fee is **paid** or **skipped**. Booking, rescheduling and cancelling are not blocked.
3. **Paying:** a cashier (`PAYMENT_CREATE`) uses *Take fee* on the Appointments list. The built-in Cashier role can open that list for this (read only, `APPOINTMENT_READ`; it still cannot book, change, cancel or check in: migration `20261107100000_cashier_reads_appointments`). Reception can take the fee too. The payment must cover what is due. It is recorded as an **advance tied to the appointment** (see `advance-payments.md`): split tenders, receipt number, shift cash, idempotency and the printed advance receipt all work as for any advance, and the patient can use it against the visit's bill. If the appointment is cancelled the fee stays the patient's advance and can be given back.
4. **Skipping:** a user with `BOOKING_FEE_SKIP` (Administrator, Manager and Receptionist by default; add it to any custom role) uses *Skip fee…*, picks one of the configured reasons (checked on the server against the setting, whatever case is typed) and may add a note. Only before check-in, only where a fee applies and is not already paid; once skipped it cannot be undone or changed (database trigger).

## Audit and report

- `BOOKING_FEE_SKIPPED`: who, the fee, the reason and note, the patient id. Fee payments are audited as `ADVANCE_RECEIVED` with `bookingFeeFor`.
- **Reports → Booking fees skipped** (`GET /reports/booking-fee-skips`, `REPORT_READ` or `REPORT_FINANCE`): count, fees not collected, a summary by reason, and every skip with date, patient, fee, reason, note and who skipped it.

## API

| | |
|---|---|
| `GET /booking-fee/config` | enabled, amount and skip reasons (any signed-in user) |
| `POST /appointments/:id/booking-fee` | take the fee (`PAYMENT_CREATE`; `Idempotency-Key` required) |
| `POST /appointments/:id/booking-fee/skip` `{ reason, note? }` | skip (`BOOKING_FEE_SKIP`) |

Appointment responses carry `bookingFee`, `feeStatus` (`NOT_REQUIRED`, `PENDING`, `PAID`, `SKIPPED`), `feePaid`, `feeDue` and `feeSkip`.

## Cancelling a booking whose fee was paid

Healthcare practice: the fee is the patient's money until a service or a charge is due, so cancelling never silently keeps it.

| Setting | Meaning |
|---|---|
| `BOOKING_FEE_FREE_CANCEL_HOURS` | Cancelled at least this many hours before the appointment (default 24): no charge. |
| `BOOKING_FEE_CANCEL_CHARGE_PERCENT` | Later than that: this share of the fee (default 0 = always free) becomes a cancellation charge. |

On cancel, a charge (if any) is an **issued bill** "Appointment cancellation charge" paid from that booking's fee in the same transaction (audit `BOOKING_CANCELLATION_CHARGED`). The rest stays the patient's money: the Appointments list shows "booking fee ₹X held for the patient, to give back", and a cashier (`PAYMENT_REFUND`) uses **Give back fee** (an advance refund, a debit in the patient's ledger: `patient-ledger.md`). Rescheduling (moving later or earlier, never into the past) keeps the fee as it is.

## Payment link and automatic cancellation

Optionally the patient gets a payment link (a placeholder for now) with a deadline, and an unpaid booking is cancelled automatically: see `booking-payment-link.md`.

## Known limitations

- One hospital-wide amount per facility; no per-doctor or per-department fee yet (`docs/backlog.md`).
- The fee is not added to the visit's bill automatically: the cashier uses *Use advance* on the bill.
- An appointment booked before the feature was switched on has no fee.

Tests: `appointments/booking-fee.spec.ts`.
