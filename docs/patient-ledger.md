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

## The insurer's share
Part of a bill may be the insurer's to pay. When an insurer has authorised an amount (an approved claim, or an approved cashless pre-authorisation) and has not yet paid it, that amount is not the patient's debt. The statement keeps every entry and the running **account balance** as above, and adds:
- `totals.insurerShare`: what insurers have authorised on this patient's bills and not yet paid, never more than those bills still owe. A claim counts against the bill it was submitted with, or the bills of the visit it was opened for (an inpatient final bill). A rejected, closed or settled claim adds nothing; money the insurer has paid is already on the bill as a payment.
- `totals.patientBalance`: the account balance less the insurer's share. This is what the patient owes (positive) or what the hospital holds for the patient (negative).
- `position`: `PATIENT_OWES`, `HELD_FOR_PATIENT`, `AWAITING_INSURER` (the patient is settled and only the insurer's share is outstanding) or `SETTLED`, now worked out from the patient balance.

The screen shows the patient balance with its badge, and, when there is one, the insurer's authorised share awaited and the account balance. This is the same rule the discharge checklist uses for the patient liability check of the final billing stage (docs/discharge-stages.md).

Example: a ₹22,800 inpatient bill, insurer authorised ₹15,000, ₹7,800 paid from the advance: account balance ₹15,000, insurer's share ₹15,000, patient balance ₹0, *patient settled, awaiting the insurer*.

Tests: `appointments/booking-changes.spec.ts`; the insurer's share: `discharge/discharge.spec.ts` ("final billing").
