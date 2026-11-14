# Who bills and who collects

* **Pharmacy generates the bill but does not collect payment.** Dispensing issues a PHARMACY bill (`ISSUED`, nothing paid) and tells the pharmacist it has gone to the Cashier. The dispense request accepts no payment lines (an unknown field is refused), and the built-in Pharmacist role holds no `PAYMENT_CREATE`, `CASHIER_SHIFT_MANAGE`, `INVOICE_CREATE` or `INVOICE_ISSUE`. The pharmacist can still read bills (`INVOICE_READ`) and print them.
* **All payments are collected through the Cashier module** (Billing screen), including pharmacy bills. Billing shows a banner with the number of pharmacy bills waiting for payment, a bill-type filter (OPD, Pharmacy, Admission, Other) and the existing status filter. `GET /invoices?kind=PHARMACY&outstanding=true` lists them.
* **The Cashier manages the whole payment lifecycle**: opening and closing the cash shift, receiving payments (split tender allowed), receipts, and refunds after pharmacy returns or credit notes (`PAYMENT_REFUND`).
* Medicines charged to an admitted patient are added to the admission bill and paid at discharge, as before.

Existing hospitals: migration `20261030120000_pharmacy_bills_cashier_collects` removes those four permissions from the built-in Pharmacist role and records a `SYSTEM_ROLE_PERMISSIONS_CHANGED` audit event. A hospital that gave them to a custom role keeps that choice.
* **Only billing staff and administrators raise the final IPD bill.** The route `POST /admissions/:id/discharge/final-invoice` needs the permission `IPD_FINAL_BILL`, held by the Cashier and Administrator roles (migration `20261031100000_ipd_final_bill_permission`; hospital-made roles that could create and issue bills keep it). Reception can issue and collect OPD and desk bills (`INVOICE_ISSUE`, `PAYMENT_CREATE`) but is refused (403) on the final IPD bill, and the Generate final bill button is hidden for it.

## Cancelling a paid bill (decision 6 Nov 2026)

Cancelling a bill that has received money needs two people on purpose: the **Cashier** gives the money back (Refund, with the transaction reference for UPI, card or bank), then the **Manager** cancels the bill (`INVOICE_CANCEL`) or issues a credit note (`INVOICE_ADJUST`). No single built-in role holds both `PAYMENT_REFUND` and `INVOICE_CANCEL`, so one login cannot cancel an invoice and take the cash out. A hospital that wants one person to do both can give a custom role both permissions under Administration.

## The Billing role (missed billing)
A **Billing** role raises the final IPD bill and reviews the "done but not billed" flags ([missed-billing.md](missed-billing.md)). Payments, refunds and cash shifts stay with the Cashier; discounts, cancellations and write-offs stay with the Manager.
