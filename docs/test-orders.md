# Tests the doctor advised: to the Cashier for billing, and visible to the Pharmacy

## Purpose

When a doctor signs a prescription, everything on it reaches the people who act on it: the **medicines** go to the Pharmacy queue (as before), and the **tests** (laboratory, imaging, cardiology, other procedures) go to the **Cashier**, who bills them from the price list and collects the payment. The Pharmacy also sees the tests on the same prescription so it has the whole picture. A handwritten picture reaches both desks too: the Pharmacy reads the medicines off it, the Cashier reads the tests.

MedOS does not run a laboratory or radiology department in this release (LIMS, radiology and PACS are out of scope for MLP-1). A test order is a billing and visibility record; carrying out the test and reporting its result stay outside MedOS for now (see `docs/backlog.md`).

## Flow

**Digital prescription**

1. The doctor writes the tests in the consultation (laboratory, imaging, cardiology, other procedures) and signs.
2. Signing creates one **test order** for each distinct test (a test written twice is one order). Each is matched to the hospital's price list by name or code, ignoring case and extra spaces. A test that matches nothing is still ordered, with no price yet; the Cashier then chooses a price-list item or types the price.
3. The Cashier's screen (Billing → *Tests the doctors advised*) lists each visit with the patient, doctor, the tests and their prices, and the total with tax.
4. The Cashier presses **Bill … and collect**: one issued bill is created at the price-list prices (the server works out every amount) and the Cashier lands on the bill to take the payment (cash, UPI, card, split payments, as for any bill). A test with no price-list match needs the Cashier to either choose a price-list item or **type its price** (and tax, default 0) first (409 `TEST_NEEDS_PRICE` otherwise). A typed price is billed under the doctor's own wording of the test.
5. A test the patient will not have done here is taken off with a reason (**Not needed**). Billed tests cannot be taken off; they are reversed through the bill like any other charge.
6. If the doctor **amends** the consultation, a test taken out and not yet billed is cancelled and a new test is ordered. A billed test is never changed.

**Handwritten prescription**

1. The doctor uploads the picture (the existing flow). It appears in the Cashier's list with every page.
2. The Cashier opens the pages and **types each test the doctor wrote**. A test on the price list can be picked (its price and tax are used); any other test is added with a price the Cashier types (and a tax rate, default 0). The Cashier marks each test's kind (laboratory, imaging, cardiology, procedure) and bills them. Or presses **No tests on this prescription**. Either way the picture leaves the list.
3. Pictures the Pharmacy sent back as unusable are not shown to the Cashier.

**Pharmacy**: in Pharmacy → Prescription queue, opening a prescription shows *Tests the doctor advised (billed at the Cashier, not here)*.

**Doctor**: `GET /encounters/:id/test-orders` shows where each test stands, with the bill number once billed.

## The Cashier's one view per patient

Billing → *Prescriptions for billing* shows **one card per patient** with everything the doctor sent for that patient, digital and handwritten together, newest visit first:

* **Medicines** prescribed on screen and the medicines of a handwritten prescription once the doctor approved them, with the dosage, days and how much the pharmacy has given ("with the pharmacy", "partly given", "given").
* **Handwritten prescriptions**: the pictures, whether the pharmacy has dealt with the medicines, and whether the tests have been read.
* **Lab tests and other investigations**, whether typed by the doctor or read off a handwritten picture: kind, price, billed or not, and the bill number.
* **Bills** for the medicines (made by the pharmacy) and for the tests, each with its total, what is still to collect and a *Collect* button.
* The card header totals: tests to bill, handwritten prescriptions to read, medicines with the pharmacy, and the amount to collect.

Tests are billed from the same card (*Bill the tests*, or *Read the tests off the handwritten prescription*). The pharmacy still gives and bills the medicines; the Cashier collects every payment. A patient leaves the list when nothing is open: no test to bill, no picture to read, no medicine waiting and nothing to collect. Prescriptions older than 30 days are not listed unless a test is still waiting to be billed.

**Collect total.** When a patient has bills still to collect, the card shows **Collect total ₹…**. It opens a form listing those bills (all ticked; untick any to leave it out), the total, and how the patient pays: one way or several (cash, UPI, card, bank transfer, other; UPI, card and bank payments need a reference). The Cashier presses *Collect*; the money is spread over the ticked bills oldest first, **each bill gets its own receipt** (printable from the confirmation), and a payment smaller than the total settles the earliest bills and leaves the rest to collect. Paying more than the total is refused. It is one all-or-nothing step: if anything is refused, no money is taken on any bill. A repeated click or network retry cannot take the money twice (the form carries a one-time key), and two cashiers collecting the same bills at once take it once.

`GET /cashier/prescriptions` (`TEST_BILL`) returns this view. It shows medicine and test names and quantities only, never the diagnosis or the consultation note, and respects the doctor and department limits in `docs/data-access.md`.

## Editing the tests for billing

The doctor's test order is a record of what the doctor asked for and **is never edited**. What the Cashier bills is kept in separate **billing lines** (table `TestBillingLine`), one per test, with who made each change.

On a patient's card, each visit has an **Edit tests** button. In edit mode the Cashier can, for the digital prescription and the handwritten prescription alike:

* change a test's **name**, **kind**, **quantity** (1 to 99) and **price** and **tax**; the doctor's own wording stays visible under an edited name ("The doctor wrote: …");
* **add** a test (typed, or picked from the price list); under the handwritten prescription an added test is recorded as read from that picture;
* **take a test off** the bill (it can be put back until saved);
* press **Save changes**. Nothing is billed yet: the visit shows the new total. A test the price list could not price must be given a price here.

Saving never changes the doctor's order. The billing lines are the Cashier's record: an edited test's line keeps the doctor's order as its source; a test the Cashier added has no order until it is billed. Editing again changes the same line (never a second one), and an added test left out of the list is kept as dropped, not deleted.

**Billing from the saved lines.** When the visit is billed (by *Collect total*, or `POST /test-orders/bill` with `{ encounterId, fromSaved: true }`) the bill is made from the lines: the edited tests, the added ones, and any of the doctor's tests the Cashier did not touch at their price-list price. Each line keeps the Cashier's wording, quantity, price and tax on the bill, and the server works out every amount. A test taken off is closed without a charge: the doctor's order is marked "taken off the bill by the Cashier" (its wording unchanged). A test the Cashier added gets an order record when it is billed (source *Cashier*, or *Handwritten* when read from the picture), so every billed test has one. A handwritten picture whose tests were billed is dealt with.

**One payment for everything.** *Collect total* lists the pharmacy's medicines bill, bills already made, and **the visit's tests, billed in the same step** from the saved lines. Everything is one all-or-nothing transaction: if the payment is refused, the tests are not billed either. The result is one receipt per bill.

## Entering the tests, and what happens at signing

The doctor adds each test in its box (laboratory, imaging, cardiology, other procedures) by pressing **Add**, pressing Enter, or picking a suggestion. **Leaving the box also adds what was typed**, so a test that was typed but not confirmed is no longer lost when the doctor saves or signs. The tests reach the Cashier **when the doctor signs** (or amends a signed consultation); a saved draft sends nothing yet, because a draft can still change.

Consultations signed before this existed had their tests only inside the signed note. A one-time backfill (migration `backfill_test_orders`) ordered the tests of consultations signed in the last 60 days so the Cashier can see and bill them (it only adds missing orders, never changes or removes anything).

## Seeing the prescription

Each visit shows the digital prescription and the handwritten prescription as **separate sections**. *Digital prescription*: every medicine with strength, dosage, frequency, days, quantity and how much was given, then the tests written on screen. *Handwritten prescription*: the original pages (click a page to open the viewer: zoom in and out, fit, next and previous page, or open in a new tab), the medicines the doctor approved from it, and the tests read from it. If a visit has both, both sections appear.

## Bills

Test bills use the bill type **Other**, not OPD. The consultation's own bill ("consultation paid before the visit") and the doctor's share of earnings are worked out from OPD bills; test charges are neither. The bill carries the visit and patient, each line is a price-list item with its tax and SAC code, and every line is tied to its test order so a test can never be billed twice (one bill per test, enforced by the database as well as the code; two cashiers pressing Bill at once produce exactly one bill).

## API

| Route | Permission | What |
|---|---|---|
| `GET /cashier/prescriptions` | `TEST_BILL` | The consolidated view per patient (above) |
| `POST /cashier/patients/:patientId/collect` `{ invoiceIds, billTests?: [encounterId], payments: [{ method, amount, reference? }] }` + `Idempotency-Key` | `PAYMENT_CREATE` and `TEST_BILL` | Collect several of the patient's medicines and tests bills in one payment (201; 200 if replayed). 409 if more than the total is offered or nothing is due; 404 for a bill that is not this patient's (or another hospital's); 400 for a bad amount, a missing reference or a missing key |
| `GET /test-orders/queue` | `TEST_BILL` | Visits with tests waiting, and handwritten pictures with no tests read yet |
| `PUT /test-orders/billing/:encounterId` `{ lines: [{ orderId? or lineId?, scanId?, name, category, serviceId?, quantity, price?, taxPercent, removed }] }` | `TEST_BILL` | Save the Cashier's edits of a visit's tests as billing lines (the doctor's orders are not changed). 409 for a test no longer waiting, 404 for a line or picture that is not on this visit, 400 for a bad name, price, quantity or tax, an unknown field, or a price-list item that does not exist |
| `POST /test-orders/bill` `{ encounterId, orders?: [{ orderId, serviceId? or price?, taxPercent? }], fromPicture?: { scanId, tests: [{ serviceId, category } or { name, price, taxPercent?, category }] } }` | `TEST_BILL` | Bill tests (201); 409 if a test is no longer waiting or needs a price; 400 for unknown fields, an empty request, an unknown price-list item or a bad typed price (it must be a number above zero with at most two decimals, tax 0 to 100; a test cannot have both a price-list item and a typed price) |
| `POST /test-orders/:id/cancel` `{ reason }` | `TEST_BILL` | Take an unbilled test off |
| `POST /test-orders/pictures/:scanId/no-tests` | `TEST_BILL` | The picture holds no tests |
| `GET /encounters/:id/test-orders` | `CONSULTATION_READ` or `TEST_BILL` | Tests of a visit with their status and bill number (limited by the doctor and department rules in `docs/data-access.md`) |
| `GET /pharmacy/queue` | unchanged | Each prescription now carries `testsAdvised` |

## Data, permissions and audit

* Table `TestBillingLine` (status `DRAFT`, `BILLED` or `DROPPED`): one line per doctor's order, kept apart from the order; billed and dropped lines never change and nothing is deleted (database triggers); quantity 1 to 99, a price above zero for a test that is billed, tax 0 to 100.
* Tables `TestOrder` (status `ORDERED`, `BILLED` or `CANCELLED`) and `ScanTestReview` (a picture was dealt with). Both are tenant-scoped with row-level security. Billed and cancelled orders never change and nothing is deleted (database triggers). A digital test is unique per visit (partial unique index).
* New permission `TEST_BILL`, granted to the Cashier role by the migration `…_test_orders_cashier_billing`. Reception, Pharmacist and doctors cannot bill tests.
* Audit events: `TEST_ORDERS_PLACED`, `TEST_ORDERS_CANCELLED` (taken off by an amendment), `TEST_ORDER_CANCELLED` (by the Cashier, with the reason), `TEST_ORDERS_BILLED` (bill, number of tests, total, and how many were billed at a typed price), `TEST_BILLING_SAVED` (the Cashier saved edits: number of lines, added, taken off, dropped), `PATIENT_PAYMENT_COLLECTED` (patient, number of bills, total, methods; each bill also records its own `PAYMENT_RECEIVED`), `SCAN_TESTS_REVIEWED`.
* Stable error code: `TEST_NEEDS_PRICE`.

## Known limitations

* Consultations signed **before** this was installed have no test orders, so their tests do not appear in the Cashier's list.
* No laboratory, radiology or cardiology work list and no results: see `docs/backlog.md`.
* A test is matched to the price list by its exact name or code; near-spellings ("CBC test" for "CBC") need the Cashier to choose the item.
* A listed test is billed at its price-list price; a typed price is whatever the Cashier enters (the same trust the Cashier already has when typing a line on an ordinary bill). Discounts follow the normal bill rules after the bill exists.
