# Decisions waiting for a reviewer

MedOS records and enforces what is below as **provisional defaults**. None has been approved by the reviewer who owns it. Each row says what is implemented, who must decide, and what would change. Do not treat any default as compliant, correct or safe until its row is closed with a named reviewer and a date.

## G6: tax (reviewer: chartered accountant / GST practitioner; brief: [gst-tax.md](gst-tax.md))

| # | Decision needed | Implemented default | If the reviewer disagrees |
|---|---|---|---|
| T1 | Rounding: per line, half-up, 2 decimals, invoice total = sum of lines | As stated | Change `computeLine`/`computeTotals` (`billing.domain.ts`); issued invoices are immutable, so a change applies to new invoices only |
| T2 | Round-off of the bill total to the rupee | **None** | New field on invoice and print; affects totals and balances (financial-integrity change, needs its own plan) |
| T3 | CGST/SGST/IGST split, place of supply, reverse charge | **Not built.** Tax is one amount per line | New tax-breakup model, hospital state setting, rules for odd paise |
| T4 | Which services are taxable and at what rate | Whatever the hospital enters per service (`taxPercent`) | Master-data change only |
| T5 | HSN/SAC: format and when it is mandatory | Optional 4 to 8 digit code on services and medicines, copied onto each invoice line when billed, printed in an extra column only when present. Medicine and service codes are not validated against any official list. Charges on an admission that came from medicine sales carry no code | Tighten validation, make mandatory, add per-line rules |
| T6 | Medicine pricing: MRP-inclusive, GST recorded for reporting | As stated; selling price may not exceed MRP (checked in the API and by a database constraint) | Change `dispensing.service.ts` and the pharmacy bill layout |
| T7 | E-invoicing (IRN/QR), GSTR exports, credit-note numbering series | **Not built** | Separate project |
| T8 | Whether discount applies before or after tax; per line or per invoice | Per line, before tax | `computeLine` |

## G14: data protection (reviewer: lawyer; brief: [data-protection.md](data-protection.md))

| # | Decision needed | Implemented default | If the reviewer disagrees |
|---|---|---|---|
| D1 | Reminders: opt-in or opt-out | **Opt-out** (`REMINDERS_REQUIRE_CONSENT` = off): sent unless the patient withdrew. Hospital can switch to opt-in in Settings | Flip the default in `settings.service.ts` |
| D2 | Which consent purposes exist; notice wording and versions | Two purposes (privacy notice acknowledged, appointment reminders); free-text notice version | Add or rename purposes (enum migration); build notice management |
| D3 | Form of consent (verbal, written, digital) and what proof is needed | All three accepted; no attachment of a signed form | Add file attachment, require method per purpose |
| D4 | Data-request types, answer deadlines, who may handle them | Four types; due date informational; `PRIVACY_MANAGE` held by Administrator | Types and deadlines; role assignment |
| D5 | Erasure vs retention of clinical and financial records | Records are never deleted; an erasure request is logged and its outcome recorded, nothing is erased | A retention and anonymisation design (needs the legal answer first) |
| D6 | Retention periods and what happens at expiry | **No schedule, no job** | Retention settings and a reviewed job |
| D7 | Breach notification content, deadlines and recipients | Draft checklist in [../privacy.md](../privacy.md) | Replace with the approved procedure |
| D8 | Children and guardians | Guardian fields exist on the patient; consent is recorded against the patient only | Guardian-as-consenter model |
| D9 | Staff access: break-glass reason, access reviews | Audit log only | Reason prompt and a review report |
| D10 | Fiduciary/processor roles, data-processing agreement, hosting location | Not decided; not a software question | Contract and hosting decisions |

## Clinical safety (reviewer: clinician and clinical-safety officer; brief: [clinical-safety.md](clinical-safety.md))

No engineering change was made for this review. Open decisions: class-level allergy matching, whether dose-range and interaction checks are mandatory, override reasons for allergy warnings, amendment alerts after dispensing, downtime procedure. Until the reviewer rules, the behaviour is as described in the brief (name-only matching, no dose or interaction checks).

## Penetration test and accessibility

No engineering changes pending a result. Open: MFA, password policy, lockout thresholds, session management (security); contrast, screen-reader and keyboard findings (accessibility).

## How to close a row

Record the reviewer's name and date, the decision, and the change made (or "accepted as is"), here and in [../certification.md](../certification.md).
