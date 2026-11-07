# Tax split (CGST / SGST) and round-off on invoices

## Purpose
Two optional ways of presenting an invoice's money, chosen by the hospital in Administration → Settings → Invoices. Both are **off** by default, so nothing changes for a hospital that does not switch them on.

- **Split tax:** each line's tax is shown and calculated as two equal halves, CGST and SGST.
- **Round-off:** the invoice total is rounded to the nearest whole rupee and the difference is shown as a round-off line.

> **Not a tax opinion.** Whether GST applies to a hospital's services at all (many clinical services are exempt), which lines are taxable, and whether bills should be rounded are for the hospital's accountant. These switches only change how an invoice is calculated and printed. The review brief is `docs/reviews/gst-tax.md`; no review has been done.

## Rules
- **Settings:** `INVOICE_TAX_SPLIT` and `INVOICE_ROUND_OFF` (per facility). They apply to invoices **created after** the change.
- **Each invoice keeps the rule it was created with.** The two switches are recorded on the invoice (`taxSplit`, `roundsToRupee`) and can never change afterwards, in the application or in the database. Editing a draft, applying a discount or issuing it uses the invoice's own rule, not the current setting. An issued invoice therefore never changes under a different rule.
- **Split tax:** for each line, half = `round(net × tax% ÷ 200)` to the paisa, tax = 2 × half, CGST = SGST = half. Each half is rounded on its own so the two are always exactly equal; the result can differ by a paisa from the unsplit tax of the same line. The database refuses a line on a splitting invoice whose tax is not an even number of paise.
- **Round-off:** total = `round(subtotal − discount + tax)` to the whole rupee, 50 paise and above rounding up. The round-off (between −0.50 and +0.50) is stored on the invoice and the database checks `total = subtotal − discount + tax + round-off`, that the round-off is within 50 paise, that it exists only on an invoice that rounds, and that such an invoice's total is a whole number of rupees. Payments, balance, receipts, refunds and credit notes all use the rounded total, so a patient pays exactly the printed total.
- **Where it applies:** invoices made from the billing screen, and invoices raised from operational sources (the pharmacy sale and the final bill of an admission). Pharmacy prices are still treated as MRP-inclusive: the pharmacy line is `quantity × selling price`, so a medicine bill only gains the round-off. The pending-charge amounts shown on an admission before it is billed are estimates calculated without the split; the invoice decides.
- **Printing:** an invoice that splits shows CGST and SGST columns per line and CGST and SGST totals instead of one Tax total; an invoice that rounds shows a Round off line.

## Not built
- **IGST and place of supply** (selling to a recipient in another state), reverse charge, composition-scheme rules, GST credit-note number series and GSTR exports.
- **E-invoicing (IRN and QR code).** It needs registration with the government's invoice registration portal through an approved provider, credentials for it, and a legal decision on whether the hospital's turnover requires it. Nothing is sent anywhere.
- Round-off when a credit note or refund is raised: credit notes are amounts the cashier chooses, so they are not rounded for the cashier.

## Audit and permissions
No new permissions. Changing the settings is `ADMIN_SETTINGS` (audited as any setting). Invoices are audited as before.

## API
`GET /invoices/:id` now also returns `taxSplit`, `roundsToRupee`, `roundOff`, `cgstTotal`, `sgstTotal` and, per line, `cgstAmount` and `sgstAmount` (null when the invoice does not split).

Tests: `billing/billing-tax.spec.ts`.
