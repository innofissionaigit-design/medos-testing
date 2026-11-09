# Patient registration fee

A one-time fee collected at Reception from every **new** patient, before the Patient ID (MRN) is issued.

## Setting it up (Administration → Settings → Patient registration fee)

| Setting | Meaning |
| --- | --- |
| `REGISTRATION_FEE_ENABLED` | collect the fee from new patients |
| `REGISTRATION_FEE_AMOUNT` | the fee in rupees (`0` = no fee). A change applies to patients registered from then on; what was charged earlier is never rewritten |
| `REGISTRATION_FEE_EXEMPT_REASONS` | the reasons that allow an exemption (default: Emergency, Staff or family, Free camp, Referral, Financial hardship) |

Nothing changes while it is off: registration works as before.

## At the desk

Registering a patient (Patients → Register) shows the fee. The receptionist either

* **collects** it: cash, UPI or card (a split such as card plus cash is allowed; UPI and card need a transaction reference; the amount must equal the fee), or
* **exempts** it, if they hold `REGISTRATION_FEE_EXEMPT` (administrator, manager and the front desk by default), choosing one of the listed reasons.

In **one step** the system then creates the patient, issues the Patient ID, creates the registration bill (kind REGISTRATION), records the payment and generates the receipt number. It is all one database transaction: if the payment cannot be taken (nothing given, wrong amount, cash with no open shift, not allowed) **no patient and no Patient ID are created** and nothing is charged. The screen then shows the Patient ID and receipt, with a Print receipt button.

## No second charge

* Every patient has at most one registration record (a database rule), and one registration bill (the bill's source is that patient).
* Submitting twice is safe: the same request replays, and a different request for the same person is stopped by duplicate detection, so an existing patient is selected instead of charged. A patient deliberately registered as a different person (duplicate override) is a new patient and pays the fee.
* A paid or exempted fee cannot be paid again, and four people paying the same pending fee at once produce one receipt.
* Patients registered before the fee existed, and patients imported from an old system, have no fee record and are never charged.

## Patients registered where nobody can take the fee

A patient registered by a booking bot through the integration API has no cashier in front of them. Such a patient is registered with the fee **pending**. The patient's page shows "Registration fee: to be collected" with the same collect/exempt form, and until it is settled the patient **cannot be checked in (walk-in or appointment) or admitted**. An **emergency** check-in is never held up: the fee simply stays pending and visible.

## Who sees it, live

| Who | What |
| --- | --- |
| Cashier (`REPORT_FINANCE`), Manager and Administrator (`REPORT_READ`) | Dashboard card "Patient registrations today" (registered, fees collected, exempted, fee due, collected by cash/UPI/card, and the latest registrations with patient, Patient ID, fee, status, payment modes, receipt number and who registered them), refreshed every 15 seconds; Reports → "Patient registrations and fees" for any date range |
| Cashier and the Billing screen | the registration bills (filter "Registration"), refreshed every 15 seconds; the money is in Reports → Collections and in the cashier's shift like any other receipt |
| Reception | the receipt and the patient's fee status |

`GET /api/v1/reports/registrations?from&to` returns the totals, the collection by payment mode, every registration (patient, Patient ID, registered by, status PAID / EXEMPTED / PENDING, fee, amount paid, payment modes, bill, receipt, exemption reason, who settled it) and the fees still due.

## Rules and records

* States: `PENDING` → `PAID` (with its bill) or `EXEMPTED` (with who and why). A settled record is final; nothing is deleted (database rules).
* Audit: `REGISTRATION_FEE_PAID`, `REGISTRATION_FEE_EXEMPTED`, `REGISTRATION_FEE_DUE` (pending), plus the usual `PATIENT_CREATED`, `INVOICE_ISSUED`, `PAYMENT_RECEIVED`.
* Permissions: `PATIENT_CREATE` to register, `PAYMENT_CREATE` to collect, `REGISTRATION_FEE_EXEMPT` to exempt.
* API: `POST /patients` takes `registration: { payments: [...] }` or `{ exemption: { reason } }`; `GET /patients/registration-fee/config`; `GET` and `POST /patients/:id/registration-fee`.

## Known limitations

* "Real time" is automatic refreshing every 15 seconds (no push connection).
* Refunding a registration fee is an ordinary refund on its bill (Billing); it does not make the patient "unregistered".
* The workflow is the same wherever a patient is created or enters the hospital (reception registration, booking bot, check-in, admission); departments that only serve an existing patient (pharmacy, billing, nursing) never charge it.
