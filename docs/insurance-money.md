# Insurance money: packages, top-up cover and payments (the "done but not billed" check is in [missed-billing.md](missed-billing.md))

Builds on [claims.md](claims.md). That page covers a claim's steps from pre-authorisation to settlement; this one covers what insurers owe, what they actually paid, and the cover and package rules that decide it. Migration `20261119090000_insurance_money`.

## What it does (Part B of the brief)

| # | Requirement | How |
|---|---|---|
| 1 | List of insurers, TPAs and schemes | Already there: `Insurer` (insurer, TPA, government, corporate), made inactive, never deleted |
| 2 | Patient cover | Policy: number, validity, sum insured, co-pay %, deductible, **entitled room** (`roomEntitlement`) and **room rent limit per day** (`roomRentLimit`) |
| 3 | Two insurers on one patient | Policy `tier` is `PRIMARY` or `TOPUP`. A top-up needs a valid main policy with another insurer. `POST /claims/:id/topup` starts the top-up claim from the main claim; it covers the same invoice. The top-up asks for the invoice less what the main insurer pays (its approved amount once decided, otherwise what it was asked for) and less items nobody covers, under its own co-pay rule and sum insured. **When the main approval changes, a top-up still waiting for its insurer is updated** (`CLAIM_TOPUP_UPDATED`). **The main insurer is settled first:** a top-up receipt is refused (`PRIMARY_NOT_SETTLED`) until the main claim is settled, closed or rejected |
| 4 | Price lists per insurer | Already there: `InsurerRate` per insurer and service; the estimate uses it |
| 5 | Packages | `InsurerPackage` has `includesImplants` and `includesConsumables` (both true by default), `inclusions`, `exclusions`, and `exclusionNote`. **A package that leaves implants or consumables out must say so** (note of 10+ characters; also a database check). `GET /claims/:id/package-lines[?invoiceId=]` marks each charge **inside the package** or **extra**: implants and consumables are inside unless the package says otherwise; a charge whose words match a listed exclusion is extra |
| 6 | Approval before treatment, and increases | Already there: pre-authorisation, enhancement requests |
| 7 | Estimate for the family | `POST /insurance/estimates` (`CLAIM_READ`): lines, days, room rate, optional package. Shows what the main insurer pays, what the top-up pays, and what the family pays. Room above the policy's rent limit, items marked not covered, and amounts above the insurer's rate are the family's. Kept as `ClaimEstimate`, never edited; `GET /insurance/estimates/:id` |
| 8 | Three-way split | `GET /claims/:id/split`: main insurer, top-up insurer, patient; always adds up to the bill |
| 9 | Claim tracking, documents checklist | Done: statuses, and a required-documents checklist per insurer that stops a claim being sent (docs/claim-checklist.md) |
| 10 | What the insurer cut, and why | `POST /claims/:id/cuts`: category (item not covered, room rent too high, patient co-pay, above the insurer's rate, deductible, other) and amount, by hand. The parts cannot add up to more than claimed less approved. The room-rent cut is entered by hand |
| 11 | All the money insurers pay | See below |
| 12 | Reports | `GET /reports/insurance/ageing`, `/rejections`, `/late-payers`, `/owed` |

## Money received (item 11)
- **One payment, matched to claims:** `POST /insurance/payments` (`CLAIM_SETTLE`, needs an `Idempotency-Key`): insurer, bank reference, date, total, and a line per claim (cash, optional tax deducted at source, and whether it is the insurer's last word on that claim). Each line is posted like any receipt on the claim's invoice, in the same transaction. A line cannot exceed what its claim is owed. A reference is never recorded twice for an insurer.
- **Overpayment:** cash over a claim's balance, and cash matched to no claim, is recorded as an overpayment (`InsurerOverpayment`). Its refund is tracked in parts (`POST /insurance/overpayments/:id/refunds`); the overpayment itself is never edited.
- **Short payment:** a line marked final that leaves a claim short of its approved amount raises a **follow-up task** for the insurance desk (`GET /insurance/follow-ups`, `POST .../done`).
- **Write-off:** `POST /claims/:id/write-offs` asks, with a reason of 10+ characters; one waits at a time. A **manager** (`CLAIM_WRITEOFF_APPROVE`, never the person who asked, also enforced by the database) approves or refuses with `POST /insurance/write-offs/:id/decision`. An approved write-off comes off what is owed; when nothing is left the claim closes. An approved claim that still has money owed can no longer simply be closed (`WRITEOFF_REQUIRED`). A claim that is partly written off closes (not "settled") once the rest arrives, because SETTLED means every approved rupee arrived.
- **Never edited:** payments, receipts, refunds, cuts and estimates cannot be updated or deleted (database triggers). A write-off or follow-up is decided or done once.
- **The running record:** `GET /claims/:id/ledger`, `GET /insurance/ledger` and `/insurance/ledger/:insurerId` show **claimed, approved, received (cash and TDS), cut (explained and not), written off, still owed, awaiting decision and refund due**, worked out from the records so it can always be rebuilt.

## Reports
- **Old claims:** claims waiting for a decision or not fully paid, by days since they were sent (0-30, 31-60, 61-90, 90+), per insurer, with the oldest 50.
- **Why claims are rejected:** the reasons insurers gave, counted, with amounts and insurers; and what insurers cut, by reason.
- **Who pays late:** per insurer, days from approval to the money arriving (average and slowest) and how much is overdue beyond `slaDays` (default 30).
- **What each insurer still owes:** the ledger per insurer.

## Permissions and audit
`CLAIM_READ` sees; `CLAIM_MANAGE` records cuts, asks for write-offs and starts top-ups; `CLAIM_SETTLE` records payments and refunds; **`CLAIM_WRITEOFF_APPROVE`** (new; Manager and Administrator) approves a write-off. Reports: `REPORT_READ` or `REPORT_FINANCE`. Audit: `CLAIM_TOPUP_CREATED/UPDATED`, `CLAIM_CUT_RECORDED`, `INSURER_PAYMENT_RECORDED`, `INSURER_OVERPAYMENT_RECORDED`, `INSURER_REFUND_RECORDED`, `CLAIM_FOLLOWUP_RAISED/DONE`, `CLAIM_WRITEOFF_REQUESTED/APPROVED/REFUSED`, `CLAIM_ESTIMATE_GIVEN`.

## Screens
**Insurance money** (what insurers owe, record a payment, follow-ups, write-offs, overpayments, reports) and **Estimate** are in the menu. A claim's window has a **Money** panel (ledger, three-way split, cuts, write-off request, top-up claim, inside/extra marking). The policy form has the kind (main or top-up), entitled room and rent limit; the package form has the implants and consumables switches and the open note.

## Discharge billing
The discharge billing stage uses the main insurer's claim, and counts the top-up insurer's awaited share as the insurer's too, so a patient with a top-up is not asked to pay what the top-up will pay. Supplementary bills remain the patient's own.

## Known limitations
- **Room-rent cuts are entered by hand,** as the brief says; the system does not work out the insurer's proportionate deduction. The estimate treats the room above the limit as the family's, which is a simplification of how insurers actually apportion it.
- A top-up covers the **main invoice only** (not further invoices that join the main claim), and is updated only while it waits for its insurer (submitted or under query).
- The estimate is not tied to a later admission or claim.
- The follow-up for an overpayment is raised only when the overpaid money is one claim's excess; money matched to no claim is tracked in the overpayments list.
- MedOS records what insurers say; it does not read an insurer's reply or send anything to one (see claims.md).
