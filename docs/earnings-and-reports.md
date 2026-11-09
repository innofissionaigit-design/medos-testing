# Booking reports and the earnings split

## Purpose

Two views of the same numbers: how many bookings there were, how many were cancelled, no-shows, how many were booked and consulted, how much money came in for them, and how that money is shared between the hospital and each doctor.

| View | Who | Where | Permission |
| --- | --- | --- | --- |
| Bookings and earnings by doctor | Administrator, manager, accountant | Reports → "Bookings and earnings by doctor" | `REPORT_READ` or `REPORT_FINANCE` |
| My bookings and earnings | A doctor | Reports → "My bookings and earnings" | `REPORT_MY_PRACTICE` |

The doctor view is built from the signed-in user's own doctor record. It accepts no doctor id, so a doctor can never ask for another doctor's numbers, and it never shows the hospital's share. A user who is not linked to an active doctor record gets a clear refusal.

## What is counted

By appointment date in the facility's time zone (ranges up to 93 days):

* **Booked**: appointments made in advance. **Walk-ins**: visits registered at the desk.
* **Cancelled**, **no-show**, **consulted** (visit completed), **booked and consulted** (a booking that ended as a completed visit), **still open**.
* **Collected**: money actually received for the visit's OPD invoices (paid minus refunded), including a booking fee that was applied from an advance, plus any cancellation charge raised for a cancelled booking. Unpaid bills add nothing until they are paid.
* **Doctor share** and **hospital share**: collected, split by the rule in force on the visit day. Only completed visits, and cancelled bookings that carried a charge, earn anything.

## Which bills count

Only OPD bills that are **tied to the visit** count (the bill's visit, `encounterId`). **Billing → New bill** ties the bill automatically: when the patient has an OPD visit that started today (in the facility's time zone) and was not cancelled, the bill is added to it, and the screen says so ("This bill will be added to today's visit OPD-… · Dr …"). If the patient has several visits today, the most recent one is used. The visit may still be open or already completed, since the Cashier often bills after the consultation.

A patient with no visit today gets a stand-alone bill as before; it is **not** counted in these reports or in the doctor share ledger. Bills made before this was added are not tied to any visit and are not counted either (the rule is `apps/web/src/lib/visit-for-bill.ts`).

## Setting the split (Administration → Earnings split)

Permission `EARNINGS_CONFIGURE` (administrator). Managers can read the rules.

| Mode | The doctor gets |
| --- | --- |
| Percentage | a percentage of the amount collected |
| Fixed | a fixed amount for each consulted visit, never more than was collected |
| Fixed plus percentage | the fixed amount plus a percentage, never more than was collected |

* One **default** rule applies to every doctor; a **doctor-specific** rule beats the default.
* A rule has a start date. The newest rule that had started by the visit day is used, so adding a rule never changes what earlier visits earned.
* Cancellation charges follow only the percentage part (a fixed amount is for a consulted visit).
* Rules are never edited or deleted: the database forbids it, and each new rule is audited (`EARNINGS_RULE_CREATED`). With no rule, the doctor's share is zero.
* Amounts use decimal arithmetic with two places.

## Commission or fixed value (Administration → Earnings split → "How doctors are paid")

Each hospital chooses how its doctors are paid. The choice is the facility setting `EARNINGS_MODEL`, changed by `EARNINGS_CONFIGURE` (administrator) and audited like any setting.

| Choice | New rules must be | Meaning |
| --- | --- | --- |
| Commission | Percentage | the doctor gets a percentage of what is collected |
| Fixed value | Fixed amount | the doctor gets a set amount for each visit, never more than was collected |
| Either (default) | any of the three | chosen for each doctor; this is how the hospital worked before the choice existed |

* The choice only limits **new** rules. Rules already saved stay as history, and a rule of the other kind that is still in force keeps being used until a fitting rule is added (the screen says so).
* The patient's bill never changes. Commission and fixed value decide how the money collected is shared between the doctor and the hospital.

## The doctor share ledger

Every time money is received or given back on a visit's consultation (OPD) or in-patient (IPD) bills, one line is added to the doctor share ledger (`DoctorShareEntry`), in the same transaction as the payment or refund.

* The line is the difference between what the doctor should have earned from everything now collected on the visit and what earlier lines already gave. Money received gives a positive line; a refund gives a negative line. Collected = doctor + hospital on every line.
* **Final bill:** the in-patient final bill is an IPD bill, so what is paid on it is counted like any other payment, in as many parts as it is paid.
* **Deposits (advances):** money taken as an advance counts for nobody. It counts when it is **applied to a bill** (the payment line of that bill), and it stops counting when part of it goes back into the advance through a refund. The visit view shows how much of the collection came from the advance.
* Pharmacy bills, test bills, registration and booking fees, and credit notes do not move the ledger (a credit note moves no money; the refund that follows it does).
* A visit keeps the rule its first line used, so a rule added later never changes what the visit has already earned. A visit whose doctor has no rule gets no lines.
* Lines are never edited or deleted (the database forbids it), and each carries the bill, the doctor, the rule and the three amounts. Each line is audited as `DOCTOR_SHARE_POSTED` with amounts only, no patient details.
* Two payments on one visit at the same moment are serialised on the visit, so the same difference is never posted twice.

Where it shows: the bill (Billing → open a bill) has a **Doctor share** card for people with `EARNINGS_CONFIGURE`, `REPORT_READ` or `REPORT_FINANCE`, with what was billed, collected, paid from the advance, what the doctor gets and what the hospital keeps; Administration → Earnings split has the **Doctor share ledger** for any 1–93 days, with totals for each doctor.

## API

* `GET /api/v1/reports/bookings/by-doctor?from&to` and `GET /api/v1/reports/bookings/my?from&to`
* `GET /api/v1/earnings/rules`, `POST /api/v1/earnings/rules`
* `GET /api/v1/earnings/model`, `PUT /api/v1/earnings/model` (`{ "model": "COMMISSION" | "FIXED_VALUE" | "BOTH" }`)
* `GET /api/v1/earnings/ledger?from&to&practitionerId`
* `GET /api/v1/earnings/visits/:encounterId` (bills, advance used, collected, doctor share, hospital net, ledger lines)

Permissions: change the model or add rules `EARNINGS_CONFIGURE`; read the model, the ledger and a visit's share `EARNINGS_CONFIGURE`, `REPORT_READ` or `REPORT_FINANCE`. Doctors, nurses, pharmacists and reception cannot read the ledger. Another hospital's visit answers 404.

## Known limitations

* The split does not move money. Paying a doctor out of what the ledger says they earned is recorded as payout vouchers (`docs/doctor-payouts.md`); payroll is out of scope for MLP-1.
* The ledger counts OPD and IPD bills of a visit. The booking report above still works from the appointment's own collection (including booking fees and cancellation charges), so its figures can differ from the ledger for visits that had a booking fee.
* The ledger starts when a visit's first payment is received after a rule exists; payments taken before then are included in that first line (the difference rule) but have no line of their own.
* An IPD visit is shared with the admitting consultant only. Splitting one admission between several doctors is not supported.

## Exporting a report

"Download CSV" first records the export in the audit trail (`REPORT_EXPORTED`: who, which report, the dates, the number of rows; never the rows themselves) and only then saves the file. If the record cannot be written the file is not saved. Each person can only record, and so export, the reports they may open (`POST /reports/export-log`). Spreadsheet formulas in the data are neutralised in the file (`apps/web/src/lib/csv.ts`).
