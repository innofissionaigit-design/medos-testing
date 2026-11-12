# Procedures, implants and consumables

## Purpose
An admitted patient may have a procedure (an operation or a minor procedure). MedOS keeps a small record of it: what was planned, that it was performed, which **implants** and **consumables** were used, and that the coordinator has **finalised** it. Every step puts the right charge on the admission, so nothing used in theatre is missed from the final bill, and the discharge stage **OT / procedure** (see [discharge-stages.md](discharge-stages.md)) stays pending until every procedure is finalised.

This is a deliberately small record, not a theatre management system: it has no theatre scheduling, anaesthesia record, operation notes, instrument counts or sterile supply tracking. Those remain in the backlog.

## Who does what
| Role | Can | Permission |
|---|---|---|
| Doctor, RMO | plan a procedure; cancel a planned one | `PROCEDURE_PLAN` |
| **OT / procedure coordinator** (`OT_COORDINATOR`) | mark a procedure performed, record and remove implants and consumables, finalise | `PROCEDURE_MANAGE` (also holds `PROCEDURE_PLAN`, `PROCEDURE_READ`) |
| Nurse, doctor, RMO, coordinator | see the procedures of an admission | `PROCEDURE_READ` |

A doctor sees only their own patients' procedures (the usual data scope); the RMO and the coordinator see the whole ward.

## Flow
1. **Plan.** Discharge tab → *Procedures, implants and consumables* → choose a procedure **from the price list** (a service of category *Procedure*), optionally a date and time and a surgeon. Planning charges nothing. (`POST /admissions/:id/procedures`)
2. **Perform.** The coordinator presses *Mark performed*. The procedure's own charge (price-list price and tax) is posted to the admission. (`POST /procedures/:id/perform`)
3. **Record implants and consumables.** Each is a price-list item, so its price is the hospital's; recording it posts its charge. An **implant** needs its serial or lot number; a consumable's is optional. An item recorded in error is **removed with a reason**: its charge is voided and the row stays for the record. Items can be recorded while the procedure is planned or performed. (`POST /procedures/:id/items`, `POST /procedures/:id/items/:itemId/remove`)
4. **Finalise.** The coordinator confirms the procedure, its implants and its consumables are all recorded and charged. The procedure must be performed, and every active item and the procedure itself must have a live charge. **After this nothing about it can change**, in the application or in the database. (`POST /procedures/:id/finalise`)
5. **Cancel.** A procedure that is only *planned* can be cancelled with a reason; anything recorded against it is taken off the bill. A performed procedure cannot be cancelled: remove what was recorded in error, then finalise. (`POST /procedures/:id/cancel`)

`GET /admissions/:id/procedures` lists them with their items, amounts and who did each step.

## Rules
- Charges are posted to the admission only while it is current and its **final bill has not been issued**; after that the record takes no changes. An item already on a bill cannot be removed here: billing raises a credit note.
- Two people performing or finalising the same procedure at the same moment cannot both succeed (the row is locked); the charge is posted once.
- A finalised or cancelled procedure, and its items, are protected by database triggers; rows are never deleted.
- Every step is in the audit log: `PROCEDURE_PLANNED`, `PROCEDURE_PERFORMED`, `PROCEDURE_ITEM_RECORDED`, `PROCEDURE_ITEM_REMOVED`, `PROCEDURE_FINALISED`, `PROCEDURE_CANCELLED`.
- Row-level security keeps each hospital's procedures apart.

## Data
Tables `Procedure` and `ProcedureItem` (migration `20261109190000_procedures`), the new `OT_PROCEDURE` discharge step, the `OT_COORDINATOR` role and the three permissions. The demo seed adds the user `otcoord1`, three procedures, two implants and two consumables to the price list.

## Not built (backlog)
Theatre bookings and a theatre calendar, anaesthesia record, operation notes and consent, instrument and swab counts, drawing implants and consumables from the **OT stock location** (today they are billed from the price list), implant stickers and registers, and a surgeon's share of the procedure fee.
