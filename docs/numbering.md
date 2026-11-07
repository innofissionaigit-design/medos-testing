# Numbering (Administration → Settings → Number formats)

## Purpose
Every record people quote has a readable number: patient MRN, OPD visit, admission, invoice, receipt, prescription, credit note, refund, purchase, pharmacy sale, stock transfer, doctor payout, lab and radiology numbers, insurance claim, employee. This is the one engine that issues them, and the screen where an administrator (`ADMIN_SETTINGS`) sets how they look. Each facility has its own formats and counters.

## How a number is issued
A number is taken **inside the same database transaction** as the record that uses it, by one atomic "insert or add one" statement. So:
- two people saving at the same moment never get the same number (tested with parallel requests);
- if the save fails, the number is given back (no gaps from failed work);
- numbers are never made from `count + 1`.

A successful response for an invoice, admission or MRN means the number is stored with it.

## Format
A pattern is text with tokens: `{SEQ}` (required, the running number, padded with zeros to the chosen digits), `{YEAR}` (calendar year), `{FY}` (Indian financial year, `2026-27`, 1 April to 31 March) and `{FACILITY}` (the facility code). Letters, digits and `- / _ .` are allowed, up to 60 characters. Defaults, for example: MRN `{FACILITY}-{SEQ}`, invoice `INV-{YEAR}-{SEQ}`, receipt `RCT-{YEAR}-{SEQ}`, prescription `RX-{YEAR}-{SEQ}`, OPD visit `OPD-{YEAR}-{SEQ}`, admission `ADM-{YEAR}-{SEQ}`.

**Restarts**: never; every January (calendar year, the pattern needs `{YEAR}`); or every April (financial year, the pattern needs `{FY}`, and `{FY}` is only allowed with this choice). The facility's own time zone (Asia/Kolkata by default) decides when midnight is, so 00:30 on 1 April is already the new financial year.

## Rules that keep numbers safe
- **A number is never issued twice.** Changing a format affects new records only; issued numbers never change. The counter for each period is kept separately, so when the restart rule is changed (say yearly to never) the new counter **continues from the highest number used so far** instead of starting at 1 again. (Before this was added, switching from "every year" to "never" with `{YEAR}` in the pattern could re-issue `INV-2026-000001`.)
- **Continue an old series**: setting "Start from" raises the counter so the next number is at least that (for example to carry on from a paper register or another system). It can only move forward. The screen shows the next number that will be issued for every format.
- **MRN must contain `{FACILITY}`** so MRNs stay unique across facilities.
- **Bills that carry GST** (invoice, credit note, pharmacy sale) follow the GST rule for a tax invoice number: **at most 16 characters, only letters, digits, `-` and `/`**. The server checks the longest number the format can produce (for example `INV/{YEAR}/{SEQ}` with 7 digits is exactly 16) and refuses a longer one with the reason. Other records have no such limit.
- Only people with `ADMIN_SETTINGS` can change formats. Every change is audited (`NUMBER_SEQUENCE_CONFIG_CHANGED`: old and new pattern, a changed restart rule, and a raised next number).

## API
`GET /number-sequences` (each format with `nextNumber` and an `example`), `PUT /number-sequences/:type` with `pattern`, `padding`, `resetPolicy` (`NEVER`, `YEARLY`, `FINANCIAL_YEAR`) and optional `nextNumber`. Migration `20261104150000_number_sequence_financial_year` adds the financial-year option.

## Known limitations
The financial year always starts on 1 April. Changing a format does not renumber anything already issued. A format cannot be reset by hand to a lower number (by design). Several parallel series for one record type (for example one invoice series per department or per counter) are not supported.

Tests: `modules/numbering/numbering.spec.ts` (formatting, parallel load, rollback, yearly and financial-year restarts, restart-rule changes, continuing a series, GST limits, permissions, isolation).
