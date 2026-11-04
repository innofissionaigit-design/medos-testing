# GST / tax review brief (spec gap G6)

**Ask:** confirm whether MedOS computes tax, rounds and prints invoices in a way that is correct and acceptable for an Indian hospital, or list what must change. Engineering has implemented what is below and has **not** had it reviewed.

## What exists today

- All money is decimal (`decimal.js`, 28 digits; database `Decimal(12,2)`); never floating point. Rounding is **half-up to 2 decimals**.
- **Per line:** `gross = round(quantity x unit price)`; `discount` is a rupee amount per line (not exceeding gross); `net = gross - discount`; `tax = round(net x tax% / 100)`; `line total = net + tax`. Invoice totals are the **sum of the rounded line values**: no invoice-level rounding and no round-off line to the nearest rupee.
- Tax % is stored per line, taken from the service price list or entered for free-price lines. The server computes everything; client totals are ignored. Tax is shown as one amount per line and in total.
- **HSN/SAC (added 2026-10-29):** services and medicines can hold an optional 4 to 8 digit code. It is copied onto each invoice line when the line is billed (a snapshot, so later master changes never alter an issued invoice) and printed in an extra column only when at least one line has a code. Codes are not checked against any official list, and medicine charges added to an admission carry no code.
- **There is no CGST/SGST/IGST split, no place-of-supply logic, no reverse charge, no e-invoice (IRN/QR) and no GSTR export.**
- **Medicines:** prices are treated as **MRP-inclusive of GST**. The pharmacy bill is exactly `quantity x selling price`; the medicine's GST component is recorded for reporting only. Each batch stores MRP, purchase price and selling price. The selling price may not exceed the MRP (checked by the API and by a database constraint; tested).
- Issued invoices are immutable; changes use credit notes, refunds or reversals. Credit notes reduce the invoice; there is no separate GST credit-note number series (a question below).
- Numbering: invoices, receipts and credit notes use a transactional, concurrency-safe sequence per hospital (format configurable). The load test found no duplicates or gaps (`docs/load-test.md`).
- Print templates carry hospital name, address, GST number (configurable per facility) and footer.

## Questions for the reviewer

1. Are healthcare services supplied by the hospital exempt, and if some lines are taxable (for example high-tariff rooms or non-clinical services), is "tax % per service" a sufficient model?
2. Is it acceptable to round **per line** and sum, rather than rounding the invoice total? Is a round-off to the nearest rupee required or expected on printed bills?
3. For medicines sold MRP-inclusive: must the pharmacy invoice show taxable value and the GST split per line (CGST/SGST), HSN, batch and expiry? What mandatory invoice fields are we missing?
4. Which fields are mandatory for a B2C hospital bill versus a bill to a registered person? Is e-invoicing applicable at the turnover of 10 to 150-bed hospitals?
5. Credit notes and refunds: what document and numbering rules apply, and when must GST be reversed?
6. Advances and deposits for admissions, package pricing and discounts: any GST treatment we must model?
7. Should discount be applied before or after tax, and per line or per invoice?

## How to inspect

- Code: `apps/api/src/modules/billing/billing.domain.ts` (`computeLine`, `computeTotals`), `billing.spec.ts`, `pharmacy/dispensing.service.ts`, and the print templates.
- Walk the OPD flow on staging and print the invoice, receipt and pharmacy receipt.

## Expected deliverable

A list of required changes with the rule or notification each is based on, a statement of what is acceptable as is, and what you did not review.
