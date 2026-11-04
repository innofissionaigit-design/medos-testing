# OPD consultation paid before the visit starts

Optional rule for hospitals that collect the consultation fee at Reception: an OPD visit cannot start until the OPD consultation bill has been **paid in full**.

## Switching it on

Administration → Settings → "OPD visit payment" (`OPD_FEE_BEFORE_VISIT`, off by default). While it is off, visits start as before.

## At Reception

1. Open the patient and click **New bill**.
2. Add **OPD consultation** (a price-list service of the Consultation category) and click **Create bill**. From a patient's page the bill is issued at once, so the payment can be taken on the next screen.
3. Take the payment (cash, UPI or card; split allowed). The bill becomes **Paid**.
4. Back on the patient's page, **Start OPD visit** is now available. It checks the patient in and adds them to the doctor's queue.

Until then the patient's page shows what to do: "create the bill", or "the consultation bill is waiting for payment, due ₹…" with a **Take payment** link, and **Start OPD visit** stays disabled. The server enforces the same rule for every way of starting a visit (the Start OPD visit button, the walk-in screen, and checking in a booked appointment), so it cannot be bypassed from another screen.

## The rules

* The bill must be an **OPD bill of this patient, issued today, fully paid, with an OPD consultation line**. A paid bill for something else (an ECG, a dressing) does not count, a part-paid bill does not count, and an old bill does not count.
* **One paid bill starts one visit.** The visit and its bill are recorded together (`VisitConsultationBill`, a final record), so the same bill can never start a second visit, even if two visits are started at the same moment: one succeeds and the other is refused with nothing left behind.
* **Not held up:** an emergency check-in, a follow-up visit, and a booked appointment that carries a booking fee (that fee is the payment).
* The refusal is `CONSULTATION_PAYMENT_REQUIRED` with a plain message.
* `GET /api/v1/patients/:id/consultation-payment` tells the screen where the patient stands: `NOT_REQUIRED`, `NEEDS_BILL`, `NEEDS_PAYMENT` (with the bill and the amount due) or `PAID`.

## Permissions

Reception creates the bill, issues it and takes the payment: the **Receptionist** role now includes `INVOICE_ISSUE` (it already had `INVOICE_CREATE` and `PAYMENT_CREATE`). A migration adds it for existing hospitals and records the change in the audit trail. Reception still cannot give discounts, cancel bills or refund.

## Reports and the Cashier

The consultation bill is an ordinary OPD bill: it is on the Cashier's Billing screen, in the day's collections and in the patient's account statement.
