# Patient account statement (ledger)

Patient page → **Account statement (ledger)**; API `GET /patients/:id/ledger` (`INVOICE_READ`). Built on the fly from the ledger tables (never stored), so it always agrees with them. Includes merged duplicate records of the same patient. Facility-scoped.

| Entry | Debit (patient owes more / money paid out) | Credit (money in / charge taken back) |
|---|---|---|
| Bill issued (including a cancellation charge) | total | |
| Bill cancelled | | the charge reversed (total less credit notes) |
| Credit note | | amount |
| Payment received (cash, UPI, card, …) | | amount |
| Bill paid from the patient's advance | 0 | 0 (memo: no money moved) |
| Refund paid out | amount paid out | |
| Refund returned to the advance | 0 | 0 (memo) |
| Advance or booking fee received | | amount |
| Advance or booking fee given back (for example after a cancelled booking) | amount | |

**Balance** after each entry = debits − credits. Positive: the patient owes the hospital. Negative: the hospital holds the patient's money (an advance or booking fee not yet used or given back). Zero: settled.

Example: a booking fee of ₹300 is paid, the booking is cancelled late with a 50% charge, the rest is given back:

| Entry | Debit | Credit | Balance |
|---|---|---|---|
| Booking fee received | | 300 | 300 held |
| Cancellation charge bill | 150 | | 150 held |
| Paid from advance (memo) | | | 150 held |
| Booking fee given back (appointment cancelled) | 150 | | 0 |

Tests: `appointments/booking-changes.spec.ts`.
