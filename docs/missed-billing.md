# Missed billing: "done but not billed"

## Purpose
MedOS compares what happened with what was billed and lists the gaps for a billing person to look at. It only points. The screen and the report say **possible missed income**, never "lost money", because some flags will turn out to be fine. Nothing is billed, changed or cancelled by this check.

## The flags
| Flag | What it means | Amount shown |
|---|---|---|
| Test advised but not billed | A test the doctor advised is still unbilled after a waiting period (24 hours by default, `graceHours`). Cancelled visits are left out. | The price-list price, when the test is matched to the price list |
| Test done but its bill was cancelled | A sample was taken, or a scan done, and the bill that had the test was cancelled | The price-list price |
| Medicine given out but not on a bill | A pharmacy dispense with no bill or a cancelled bill; or medicine issued from a ward store to an admitted patient with no charge on the admission | The dispense total (none for a ward issue) |
| Bed night not charged | A night in a bed with no bed charge. For a patient still in the ward, today is not yet due. A bed charge removed on purpose (voided) counts as dealt with. | The daily rate of the bed used that night |
| Consultation completed with no fee | An OPD visit that ended with no consultation fee on any live bill | none (the fee depends on the doctor and the visit) |
| Package item billed again | An item the insurer's package already covers (an implant or consumable the package includes, or an item it lists) billed on a bill outside the claim, for example a supplementary bill | The line amount |
| Charge after the final bill, still unbilled | A charge added after the final bill that is not yet on a bill | Quantity x price plus tax |

The flags are worked out from the records each time and are not stored. A period is at most 92 days (default: the last 30), in the hospital's time zone, and each kind shows up to 200 flags, so a busy period should be viewed in shorter parts.

## Workflow
1. **Missed billing** in the menu (Billing, Manager and Administrator). Choose the dates, the kind of flag and whether to show what is still to look at, what has been decided, or everything. The top shows the number of flags, the possible missed income (flags with no known amount are counted separately), and a button per kind.
2. **Look** opens the visit, admission, bill or patient the flag is about.
3. **Decide** records one of three answers with a reason, kept with the person's name:
   * *It is fine, nothing more to bill* (reason of 5+ characters), for example a free follow-up;
   * *It has been billed* (5+), say where;
   * *We chose not to bill it* (10+), the hospital gives the money up on purpose.
4. A decided flag leaves the "still to look at" list and stays under "already decided". **A decision is made once and cannot be changed or removed.** If the record changes later (a bill is added), the flag simply disappears or stays decided.

## Who does what
The new built-in role **BILLING** raises the final bill and reviews the flags. It does not take payments, refunds or shifts (the Cashier), and cannot discount or cancel (the Manager). A hospital that wants someone else to review gives them `MISSED_BILLING_READ` / `MISSED_BILLING_REVIEW` through a custom role.

## Permissions
`MISSED_BILLING_READ` sees the report; `MISSED_BILLING_REVIEW` decides. Held by Billing, Manager and Administrator. Migration `20261123090000_missed_billing_review` gives the role and permissions to existing hospitals and records a `SYSTEM_ROLE_PERMISSIONS_CHANGED` audit event.

## API
`GET /billing/missed-income?from=&to=&type=&status=OPEN|REVIEWED|ALL&graceHours=`; `POST /billing/missed-income/reviews` `{flagKey, decision, reason}`. A decision is checked against the record first (the flag must really exist in the caller's hospital), so another hospital's flag, or something that is not a gap, answers 404; the same flag twice answers 409.

## Audit events
`MISSED_BILLING_REVIEWED` (flag kind, decision, patient, amount).

## Database
`MissedBillingReview` (tenant and facility scoped, row-level security, unique per flag, append-only by trigger).

## Known limitations
* Some flags have no amount (consultation fee, ward medicine); they are counted but not added up.
* The package check only looks at bills of the same patient and visit that are outside the claim; it does not recalculate what the insurer pays.
* A test advised at the OPD and never billed may simply not have been done here; that is for the billing person to decide.
* A flag already decided cannot be reopened.
* Notifications of new flags and a daily digest are not built; the screen is looked at on demand.
