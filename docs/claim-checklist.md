# Claim documents checklist

## Purpose
A claim to an insurer must not be sent with a document missing. Each insurer has a list of documents it requires; a claim cannot be sent until every one is attached, or a manager has said it is not needed for that one claim, with a reason.

## Workflow
1. **Set what each insurer needs.** Insurance claims, Insurers and TPAs, **Required documents**. Add a document by name (for example "Discharge summary") for all claims, only cashless claims, or only reimbursement claims. A requirement is switched off, never deleted. Adding a name again switches it back on.
2. **Attach documents to the claim** as before (Claim, Documents). A document counts when its name matches a requirement, whatever the capitals or extra spaces. A removed document counts as missing again.
3. **The claim shows "Documents the insurer needs"**: each one is *attached*, *not needed* (waived) or *missing*, and says what is still missing.
4. **Sending is blocked** while anything is missing: `POST /claims/:id/submit` answers `409 CLAIM_DOCUMENTS_MISSING` with the list. This holds for the main claim and for a top-up claim, and nothing is sent.
5. **A manager can say one document is not needed on this claim** (`POST /claims/:id/checklist/waive`, a reason of 10+ characters). It is kept with the manager's name and cannot be changed or removed. Only before the claim is sent.

An insurer with no required documents holds nothing back.

## Permissions
`CLAIM_READ` sees the list and a claim's checklist. `CLAIM_MASTERS` changes an insurer's required documents. **`CLAIM_DOCUMENT_WAIVE`** (new; Manager and Administrator) waives one document on one claim. `CLAIM_MANAGE` still attaches and removes documents.

## Audit events
`INSURER_REQUIRED_DOCUMENT_ADDED`, `INSURER_REQUIRED_DOCUMENT_REMOVED` (switched off), `CLAIM_DOCUMENT_WAIVED` (document and reason).

## Database rules
A required document is unique per insurer, name (any capitals) and claim type; it cannot be deleted or renamed, only switched on or off. A waiver needs a reason of 10+ characters, is unique per claim and document, and can never be changed or deleted. Both tables are tenant-scoped with row-level security. Migration `20261120090000_claim_document_checklist`.

## API
`GET|POST /claims/insurers/:insurerId/required-documents`, `POST /claims/required-documents/:id/active`, `GET /claims/:id/checklist`, `POST /claims/:id/checklist/waive`.

## Known limitations
- Matching is by document name; a scan with a differently worded name must be re-labelled to count.
- The checklist is checked when a claim is sent (and again if it is re-sent); it does not look at what is inside a document.
- The checklist screens are in English; Bengali and Hindi labels are not added yet.
