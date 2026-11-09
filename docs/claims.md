# Insurance claims

## Purpose
Tracks money owed by insurers, TPAs and government schemes. A claim follows one issued invoice from pre-authorisation to settlement. Money the insurer pays is posted on the invoice, so the invoice and the claim never disagree.

## Entities
- **Insurer**: name and kind (insurer, TPA, government scheme, corporate); can be made inactive, never deleted.
- **Policy**: a patient's policy with an insurer: number, member id, validity dates, sum insured. A claim needs a policy that is active and valid today.
- **Claim**: patient, policy, optional visit, kind (cashless or reimbursement), the amounts, and the status.
- **Timeline** and **settlements**: append-only records of every step and every receipt of money.

## Workflow and states
`DRAFT → PREAUTH_PENDING → PREAUTH_APPROVED → SUBMITTED ⇄ QUERY → APPROVED → SETTLED`, with `REJECTED` (the insurer said no) and `CLOSED` (withdrawn or written off, with a reason) as other ends.

1. A claim is started for a patient and a policy. A cashless claim may first ask for pre-authorisation (an amount, then the insurer's approved amount or rejection reason). A reimbursement claim goes straight to submission.
2. Submitting attaches one issued invoice and the amount claimed (never more than the invoice is worth). An invoice can have only one live claim; it is free again when the claim is rejected or closed.
3. The insurer may raise a query; the reply resubmits the claim.
4. The insurer approves (up to what was claimed) or rejects (with their reason).
5. Money received is recorded against an approved claim with the bank reference and date. Each receipt is posted as a bank-transfer payment on the invoice in the same transaction, which also updates the invoice's paid amount and status. Several part payments are allowed; the claim becomes SETTLED when the approved amount has arrived. A receipt cannot exceed what is still approved or what the invoice still owes.
6. A claim can be closed with a reason (for example, the balance is written off). Finished claims (rejected, settled, closed) cannot move again.

## Permissions
`CLAIM_READ`, `CLAIM_MANAGE` (policies and the steps), `CLAIM_SETTLE` (record money received), `CLAIM_MASTERS` (insurers). Role: `CLAIMS_OFFICER` has all four. Administrators can read and set up insurers; managers, cashiers and reception can read.

## Audit events
`INSURER_CREATED/UPDATED`, `POLICY_ADDED`, `POLICY_STATUS_CHANGED`, `CLAIM_CREATED`, `CLAIM_PREAUTH_REQUESTED/APPROVED/REJECTED`, `CLAIM_SUBMITTED`, `CLAIM_QUERY_RAISED`, `CLAIM_RESUBMITTED`, `CLAIM_APPROVED`, `CLAIM_REJECTED`, `CLAIM_SETTLEMENT_RECEIVED`, `CLAIM_CLOSED`.

## Database rules
Claims, insurers and policies are never deleted. The timeline and settlements are append-only. Amounts keep their order (approved ≤ claimed; received ≤ approved). A finished claim cannot change status; money received cannot be taken back; a claim cannot move to another patient. One live claim per invoice. Settlements are only accepted on an approved claim and cannot add up to more than approved.

## API
`GET/POST /claims/insurers`, `PUT /claims/insurers/:id`, `GET/POST /patients/:id/policies`, `PUT /policies/:id`, `GET /claims`, `GET /claims/summary`, `POST /claims`, `GET /claims/:id`, `POST /claims/:id/preauth|preauth-decision|submit|query|resubmit|decision|settlements|close`, `GET /print/claims/:id`. Settlements need an `Idempotency-Key`.

## Documents
Supporting documents (discharge summary, policy card, ID proof, investigation reports, final bill, prescription, or anything else the insurer asks for) are attached to the claim in the claim's window. PNG, JPEG or PDF, up to 5 MB each and 30 per claim, checked against their declared type and virus-scanned like patient documents. The claims officer (`CLAIM_MANAGE`) adds and removes them while the claim is open; anyone with `CLAIM_READ` can open them. Opening a document is audited (`CLAIM_DOCUMENT_VIEWED`) because it is access to a patient's record. A wrong document is removed with a reason (5+ characters): it stops showing but stays on the record, and nothing is ever deleted. A rejected, settled or closed claim keeps its documents and takes no more (checked by the service and by the database). The documents are **kept with the claim; nothing is sent to the insurer**.
API: `POST /claims/:id/documents?filename=&label=` (raw body), `GET /claims/:id/documents`, `GET /claim-documents/:id/content`, `POST /claim-documents/:id/remove`. Audit events: `CLAIM_DOCUMENT_ADDED`, `CLAIM_DOCUMENT_VIEWED`, `CLAIM_DOCUMENT_REMOVED`, `CLAIM_DOCUMENT_REJECTED`. Tests: `claims/claims.spec.ts`.

## Known limitations
No electronic submission to insurers or TPAs (portals, ABDM or NHCX): it needs each payer's gateway and credentials, and documents and forms are handed over outside MedOS; no rate cards or package pricing per insurer; no room-rent cap or per-claim limit (co-pay percentage and deductible only); the deductible already used is entered by hand and is not updated from settled claims; no TDS on insurer payments; one invoice per claim. See `docs/backlog.md`.

## Co-pay and deductible
A policy can carry a **co-pay percentage** (what the patient pays of the covered amount), a **deductible** (a fixed amount the patient bears first) and the **deductible already used** this policy year (entered by hand). A policy with neither a percentage nor a deductible has no rule, and the claimed amount is entered by hand as before.

**Calculation** (`calculateCopay`, exact decimals): the deductible still to be met comes off the invoice first (never more than the invoice); the co-pay percentage applies to what is left, rounded to the paisa, half up; the claim is the remainder, never more than the sum insured. The patient's share is whatever the insurer is not asked for, so the two always add up to the invoice (after credit notes).

**At submission** the calculated amount is the default. `POST /claims/:id/copay-preview` (`{ invoiceId }`) shows the breakdown without saving. `submit` may leave `claimedAmount` out to use it; a different amount needs `overrideReason` (10+ characters). The claim keeps a snapshot (calculated amount, patient share, percentage and deductible applied, override reason), so later changes to the policy never alter it. A resubmit that moves the amount away from the calculation also needs a reason. If the patient's share covers the whole bill (`409 INVALID_STATE`) there is nothing to claim.

**Policy rule:** `POST /patients/:id/policies` accepts `copayPercent`, `deductible`, `deductibleUsed`; `PUT /policies/:id/copay` changes or removes it (`copayPercent: null`, deductible 0). Used cannot exceed the deductible. Permission `CLAIM_MANAGE`.

**Audit:** `POLICY_COPAY_CHANGED` (before and after); `CLAIM_SUBMITTED` / `CLAIM_RESUBMITTED` metadata carries the percentage, deductible, calculated amount and any override with its reason.

**Screens:** the policy form has Patient pays %, Deductible and Deductible already used; the submit step shows the breakdown and pre-fills the amount; the printed claim form shows what the patient pays.

**Database:** migration `20261103090000_claims_copay` adds the columns with check constraints (percent 0–100, amounts not negative, override reason at least 10 characters).
