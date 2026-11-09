# Advance payments (deposits)

Money taken before it is billed, for example before a planned admission or surgery. Patient page → **Advance payments** → *Take an advance*; on an unpaid bill → **Use advance**.

## Model

- An advance is the hospital's liability to the patient, not income. It is kept apart from invoices and receipts in four append-only tables (database triggers refuse edits and deletes): `AdvanceDeposit` (with `AdvanceTender` lines, so a split such as ₹500 cash + ₹700 UPI is one receipt), `AdvanceUse` and `AdvanceRefund`. **Balance = amount − uses − refunds**, and a database trigger refuses to overdraw it.
- **Using** an advance pays an issued invoice through an ordinary receipt (method `OTHER`, reference `ADV-<advance receipt number>`) whose payment line carries `Payment.advanceUseId`. Invoice totals, statuses and receipts therefore work exactly as before; nothing about issued invoices changes.
- Several advances can fund one bill (oldest first, in one receipt). Rows are locked, so two cashiers cannot spend the same money (the second gets `INSUFFICIENT_ADVANCE`).
- **Giving back** unused advance: only up to the balance and only by a method it was received through; cash needs the cashier's open shift; non-cash needs a reference. Reason is required.

## Reports and the cash drawer

Money is counted when it comes in or goes out, never twice: the daily collections report, payment-mode summary, shift summary and expected cash include advances when they are **taken** and **given back**, and exclude payments funded by an advance (`advanceUseId` set). Credit notes are unchanged.

## API

| | |
|---|---|
| `POST /patients/:id/advances` | take (`PAYMENT_CREATE`; `Idempotency-Key` required) |
| `GET /patients/:id/advances`, `GET /advances/:id` | read (`INVOICE_READ`) |
| `POST /invoices/:id/advances` `{ amount }` | pay a bill from advance (`PAYMENT_CREATE`) |
| `POST /advances/:id/refunds` | give back (`PAYMENT_REFUND`) |

Audit: `ADVANCE_RECEIVED`, `ADVANCE_APPLIED`, `ADVANCE_REFUNDED`. A patient's advances include those taken on a merged duplicate; a merged duplicate cannot take new ones.

## When a bill paid from an advance is refunded or cancelled

A refund **by method "other"** first puts the advance-funded part back into the advance it came from (newest use first, never more than that use took), and only the rest is paid out. If all of it goes back to the advance, no reference is needed and no money leaves the drawer. The refund row records the part returned (`Refund.advanceReturned`) and an `AdvanceReturn` row restores each advance's balance (balance = received − used + returned − given back). Reports and the cash drawer leave the returned part out of money paid out. The usual rules still apply: an issued bill is refundable only above what it still owes (issue a credit note first), and cancelling a paid bill takes the refund of everything received.

## Printed receipt

`GET /print/advance-receipts/:id` (`?format=pdf` for PDF), from **Print receipt** on the patient's advance list. It shows the tender lines, the note, a plain statement that this is an advance and not a payment for a bill, and the position when printed (used, returned, given back, balance held). Printing is audited and a second print is stamped DUPLICATE COPY, like other documents.

## Advance section on the printed invoice

`GET /print/invoices/:id` (HTML and PDF) has an **Advance** section when the bill had an advance set against it or the patient still holds one: a table of each advance used on this bill (advance receipt number, date received, what it was for such as "Booking fee", amount received, amount set against this bill and the total), a note that the amount is already counted in "Paid", and the position (used on this bill, advance still held for the patient across all bills). A bill with no advance and a patient holding none prints exactly as before. Test: `print/print.spec.ts`.

## Known limitations

- Advances are per facility; they cannot be used at another facility of the same hospital.
- Not linked to an admission automatically; the cashier applies the advance to the final bill.
- A refund by "other" cannot be split between "back to the advance" and "paid out" by choice: the advance part always goes first.

Tests: `billing/advances.spec.ts`.
