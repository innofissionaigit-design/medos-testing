# Doctor payouts

## Purpose

The doctor share ledger (`docs/earnings-and-reports.md`) says what each doctor has earned from the money collected. This module records paying that money out: a voucher for each payment, with tax deducted at source, a statement for each doctor, and a reversal for a voucher made by mistake. It records the payout; it does not move money, and it is not part of a cashier's shift.

## What is owed

For one doctor: **everything the ledger has earned for them** (the sum of their ledger lines, so refunds already lower it) **less everything paid out** (the gross share on every voucher, a reversal counting as a negative amount). A payout can never be more than what is owed, and two payouts made at the same moment cannot pay the same earnings twice (one is refused).

## Screens

* Administration → Earnings split → **Doctor payouts** (administrator): each doctor's earned, paid out, tax deducted and still owed; **Pay…** (share to pay, tax percentage, how paid, reference, note; the screen shows what the doctor receives); **Statement**; the list of vouchers with **Print** and **Reverse…**.
* Reports → **My payout statement** (a doctor): their own account for a date range. A doctor can never ask for another doctor's.

## Vouchers

* A voucher has a number (`DPV-2026-000001`), the doctor, the **share paid** (gross), the **tax deducted at source** (a percentage of the share, rounded to the paisa, default from the setting `DOCTOR_PAYOUT_TDS_PERCENT`, 0 to 30, changeable for one payout), the **net** the doctor receives, how it was paid (cash, UPI, card, bank transfer, other) and a reference (needed unless it is cash).
* The voucher prints as HTML or PDF (`GET /api/v1/print/doctor-payouts/:id`) with signature lines for the doctor and for whoever paid. Every print is audited, and a second print is stamped DUPLICATE COPY.
* A voucher is **never edited or deleted** (the database forbids it). A mistake is undone with a **reversal**: a new voucher that mirrors the original with every amount negated, with a reason. A voucher can be reversed once; a reversal cannot be reversed. What the doctor is owed goes back up by the gross amount, and a correct payout can then be made.

## Statement

`GET /api/v1/earnings/statement?practitionerId&from&to` (up to 366 days, the facility's days; default this month): owed at the start of the range, each ledger line earned (money received for a visit, or reduced by money given back), each voucher paid (share, tax, net) and each reversal, and owed at the end. Amounts are the doctor's share before tax; the voucher lines also show the tax and what was received.

## API and permissions

| Call | Permission |
| --- | --- |
| `GET /earnings/payouts/balances`, `GET /earnings/payouts`, `GET /earnings/payouts/:id`, `GET /earnings/statement` | `EARNINGS_CONFIGURE`, `REPORT_READ` or `REPORT_FINANCE` |
| `POST /earnings/payouts` (header `Idempotency-Key` required), `POST /earnings/payouts/:id/reverse` (same header) | `EARNINGS_CONFIGURE` |
| `GET /earnings/my-statement`, `GET /reports/earnings/my-statement` | `REPORT_MY_PRACTICE` (a doctor, linked to their own doctor record) |

Doctors, nurses, pharmacists and reception cannot read other doctors' balances or vouchers. Another hospital's voucher or doctor answers 404.

## Audit and integrity

* Audit events: `DOCTOR_PAYOUT_PAID` (number, doctor, gross, tax percentage, tax, net, method, owed after) and `DOCTOR_PAYOUT_REVERSED`. No patient details are involved.
* The database refuses a voucher whose net is not gross less tax, a tax above the share, a payment that is not positive, a reversal that does not mirror exactly one payment voucher of the same doctor, a doctor of another hospital or facility, and any edit or delete.

## Known limitations

* It records a payout; paying through a bank file, a yearly tax-deducted-at-source certificate and the doctor's PAN are not built (`docs/backlog.md`).
* Tax is one percentage of the share; thresholds and section rules are the hospital's accountant's to apply when choosing the percentage.
* The share comes only from OPD and in-patient bills of the visit's doctor (see the ledger's own limitations).
