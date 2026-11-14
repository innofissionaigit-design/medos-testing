# Discharge flow: making going home faster

The stage-by-stage clearance (nursing, pharmacy, billing, insurance, summary, exit, bed turnover) is in [discharge-stages.md](discharge-stages.md). This page covers the time side: who is holding a patient up, for how long, and who is told.

**Firm rule.** Only the doctor says a patient is fit to go home (`MEDICALLY_FIT`, permission `ADMISSION_DISCHARGE`) or signs the summary (`CONSULTATION_SIGN`). Nothing here decides either. Without the doctor's record, no clock runs and nobody is "waiting". The planned date is a plan, not a decision.

## What was already there (see discharge-stages.md)
Checklist of stages with a responsible team; automatic checks of pending lab tests and unbilled charges; "not ready" blockers; pharmacy returns and credits; exit confirmation; bed turnover with minutes to ready; a turnaround report.

## What this adds

| # | Requirement | Where |
|---|---|---|
| 1 | Planned going-home date | `PUT /admissions/:id/discharge-plan` (`ADMISSION_DISCHARGE`). One per admission; each change audited (`DISCHARGE_PLAN_SET`) |
| 2-3 | Checklist when the doctor says fit, with owner and deadline; each person sees their own | `GET /admissions/:id/discharge-flow` (`items`: stage, owner team, deadline, state, blockers, `mine`); `GET /discharge-flow/my-work` |
| 4 | 2-hour clock | Starts at the doctor's "fit to go" record, stops at confirmed departure (or discharge for an absconded patient). Reminder at 90 minutes to whoever holds the pending stage's permission (and the treating doctor for the summary); at 120 to the department head; at 150 to the administrator |
| 5 | Insurer's separate clock | `POST /admissions/:id/discharge-flow/insurer-bill-sent` (`CLAIM_MANAGE`) starts it; it stops at the insurer's answer (claim approved, settled, rejected or closed). Reminder at 60, insurance desk head at 120, administrator at 180 |
| 6 | Screen of everyone waiting | `GET /discharge-flow/board`: longest wait first, bed, pending stages and their reasons; `insurerWaiting` lists insurers yet to answer |
| 7 | Automatic checks | Already the lab / charges / pharmacy / OT / insurance / billing reconciliation; shown as each item's `blockers` |
| 8 | Reason when stuck | `POST /admissions/:id/discharge-flow/delay` with a fixed reason (waiting for insurance, family arranging money, summary not written, ...). Append-only; the newest stands. Only for a stage that is actually pending; "Other" needs words |
| 9 | Bill preview; final bill only when ready; late charge on a separate small bill | `GET /admissions/:id/discharge/bill-preview` (charges waiting, bills issued, "not ready yet" list; reads only). The final bill is refused until the required steps are cleared. A charge added after it (`POST /admissions/:id/charges`, `CHARGE_CREATE`) waits as pending and is billed by `POST /admissions/:id/discharge/supplementary-invoice` (`IPD_FINAL_BILL`) on its own issued invoice, numbered 1, 2, 3 per admission (`SupplementaryBill`). The final bill is never altered |
| 10-11 | Medicine returns; exit pass and bed turnaround | Already built (pharmacy stage, `DISCHARGE_DEPARTURE_CONFIRM`, bed turnover) |
| 12 | Family sheet | `GET /admissions/:id/discharge-flow/family-sheet?lang=en\|hi\|bn`. Plain words, who is handling each item, the reason. No amounts, no diagnosis, never the staff's free-text note |
| 13 | Management report | `GET /reports/ipd/discharge-flow?from=&to=`: average minutes to leave, share inside the target, share who left before noon (hospital timezone), delays by reason, by department, slowest stages, insurer response time |

## Configuration (Administration → Settings)
`DISCHARGE_TARGET_MINUTES` (120), `DISCHARGE_REMINDER_MINUTES` (90), `INSURER_TARGET_MINUTES` (120), `INSURER_REMINDER_MINUTES` (60). The administrator is told one further interval after the department head: the gap between reminder and target, at least 15 minutes.

## Who is told
No role names in code. Reminder: holders of the permission of the pending stage (charges review and final billing: the billing team, `IPD_FINAL_BILL`; the summary: the treating doctor and holders of `CONSULTATION_VERIFY`, the RMO). Each person gets one notification per patient per level, however many of their steps are pending. Department head: holders of `DISCHARGE_ESCALATE_DEPT` (the Manager role by default) who also work that stage, or every such holder if none does. Administrator: holders of `DISCHARGE_ESCALATE_ADMIN` (the Administrator role). A hospital can give either permission to its own roles. Notifications are the in-app ones (`DISCHARGE_REMINDER`, `DISCHARGE_ESCALATION`); they hold no patient name.

The background job (`DischargeFlowWorker`, same polling as the other workers) sends each level once per stage. The ledger `DischargeAlert` has a unique key on (admission, clock, level, stage), so a second run or second server sends nothing twice. Audit: `DISCHARGE_ALERT_SENT`.

## Late charges and supplementary bills
While a late charge is unbilled, the billing stage is pending ("N late charge(s) not yet billed: generate a supplementary bill") and the discharge cannot complete (a doctor's waiver of the billing stage is the only way past it, as for any unbilled charge). Once billed, what is owed on the supplementary bills counts as patient liability in final billing and as a patient receivable in post-discharge; the billing stage clears itself when they are paid. Audit: `SUPPLEMENTARY_INVOICE_CREATED`. Two cashiers pressing the button at once produce one bill (the admission is locked). Migration `20261118090000_supplementary_bill`; the record is append-only.

## Data (migration `20261117090000_discharge_flow`)
`DischargePlan` (editable, audited), `DischargeDelay`, `InsurerBillSend` and `DischargeAlert` (append-only by trigger), all tenant-scoped with row-level security. Audit events: `DISCHARGE_PLAN_SET`, `DISCHARGE_DELAY_REASON_RECORDED`, `INSURER_BILL_SENT`, `DISCHARGE_ALERT_SENT`.

## Known limitations
- The owner of an item is a team (the permission holders), not one named person; there is no individual assignment.
- Reminders are in-app notifications only: no SMS, WhatsApp or email.
- The board evaluates each waiting patient in turn and is capped at 50 patients.
- Screens: **Going home** in the menu (waiting board, my work, insurer replies, report), and a "Going home" card at the top of an admission's Discharge tab (planned date, clock, checklist, reasons, insurer clock, family sheet). Labels are translated into Hindi and Bengali (the family sheet has its own wording). Not yet checked in a browser or covered by a Playwright test.
- A late charge can be posted by the cashier or nurse screen (service charges). Medicines dispensed or issued from a ward store, and procedure records, are still refused after the final bill (their own rules: a counter sale, or a credit note for returns); they do not yet flow to a supplementary bill.
- Supplementary bills are the patient's own to pay: the insurer's authorised share covers the final bill only, and a claim is not re-filed for a supplementary bill.
