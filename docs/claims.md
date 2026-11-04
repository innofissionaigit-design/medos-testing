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

## Known limitations
No electronic submission to insurers or TPAs (portals, ABDM or NHCX); no document attachments; no rate cards or package pricing per insurer; no co-pay or deductible calculation (the claimed amount is entered by the claims officer); no TDS on insurer payments; one invoice per claim. See `docs/backlog.md`.
