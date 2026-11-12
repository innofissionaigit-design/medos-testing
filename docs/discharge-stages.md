# Discharge stages: who is responsible and what the HIS shows

The discharge screen (IPD → admission → **Discharge** tab) shows every stage with the person or team who answers for it and the HIS status. The same fields come from `GET /api/v1/admissions/:id/discharge` (`steps` and `summary`), so other screens and API clients can use them.

| Stage | Responsible person/team | HIS status and clearance | Who can act |
|---|---|---|---|
| Discharge decision (`MEDICALLY_FIT`) | Treating doctor | Pending: *Awaiting doctor's decision*. Cleared: **Clinically fit / discharge advised** | `ADMISSION_DISCHARGE` (a doctor) |
| Summary preparation (`summary`) | RMO / treating team | **Not started / Draft / Signed / Verified** | see below |
| Nursing clearance (`NURSING`) | Ward nurse / in-charge | Pending: *Medication, clinical documentation or handover outstanding*. Cleared: **Medication, clinical documentation and handover complete** | `NURSING_DOCUMENT` (a nurse; not the doctor) |
| Charges review (`CHARGES_REVIEWED`) | Billing team | Pending: *Charges not yet reviewed*. Cleared: *All charges posted and reviewed* | `CHARGE_CREATE` |
| Pharmacy clearance (`PHARMACY`) | Inpatient pharmacist | Pending: *Issues, returns or eligible credits not yet reconciled*. Cleared: **Issues, returns and eligible credits reconciled** (clears itself once everything adds up) | `PHARMACY_DISPENSE` (a pharmacist) |
| Laboratory / radiology (`LAB_RADIOLOGY`) | Relevant departments | Pending: *Pending services or charges not yet reconciled*. Cleared: **Pending services and charges reconciled** (reconciles itself; nobody clicks it) | automatic; a doctor can waive it |
| OT / procedure (`OT_PROCEDURE`) | OT / procedure coordinator | Pending: *Procedure, implants or consumables not yet finalised*. Cleared: **Procedure, implants and consumables finalised** (reconciles itself; nobody clicks it) | automatic; a doctor can waive it |
| Insurance (`INSURANCE`) | TPA desk + external payer | Pending: *Insurance documents or authorisation not yet complete*. Cleared: **Documentation submitted; authorisation tracked** (reconciles itself from the claim; a self-pay patient shows *Not applicable: self-pay patient*) | automatic; a doctor can waive it (self-pay); the TPA desk (`CLAIM_MANAGE`) keeps the claim up to date |
| Final billing (`BILLING`) | IP billing | Pending: *Final bill, deposits, credits or patient liability not yet reconciled*. Cleared: **Final bill, deposits, credits and patient liability reconciled** (reconciles itself once the bill is settled and nothing is left over) | automatic; cannot be waived; the cashier issues the bill, applies or refunds deposits and takes payment |
| Financial release (`FINANCIAL_RELEASE`) | Authorised billing / finance | Pending: *Financial release pending*. **Cleared** (by itself, once final billing is reconciled) / **Authorised exception** (recorded by `DISCHARGE_FINANCIAL_EXCEPTION`, with a reason) | automatic; not a doctor's waiver; the manager (billing / finance) authorises an exception |
| Physical exit (`exit`) | Ward nurse / transport | *Awaiting discharge* (while admitted) → *Departure not yet confirmed* → **Actual departure confirmed** (time, how, escort, minutes after discharge); *Not applicable* for an absconded patient | `DISCHARGE_DEPARTURE_CONFIRM` (ward nurse, patient transport) |
| Bed turnover (`turnover`) | Housekeeping | *Awaiting discharge* → *Vacated: cleaning not started* → *Cleaning in progress* → **Ready for the next patient** (with who, when and the minutes from vacated to ready) | `BED_HOUSEKEEPING` (housekeeping, the nurse) |
| Post-discharge (`postDischarge`) | MRD, claims, finance | *Awaiting discharge* → *Records not yet complete* → **Records complete; claims and receivables tracked** → *Records complete; claims and receivables closed* | `MRD_RECORD_COMPLETE` (Medical Records Department) signs off; claims and finance follow the list |

The first twelve rows were specified. The earlier name of the last one was *Final bill and payment*; change wording if your hospital uses another name. It names a stage that already existed in the workflow; change their wording in `STAGE_INFO` in `apps/api/src/modules/discharge/discharge.service.ts` if your hospital uses other names.

## Summary preparation: draft, signed, verified
1. **Draft.** The **RMO** (resident medical officer) or the treating consultant writes the summary (`PUT /admissions/:id/discharge-summary`). Who prepared it is shown.
2. **Signed.** Only the **treating consultant** signs (`CONSULTATION_SIGN`). The consultant can correct a draft the RMO started. No other doctor can change it, and the RMO cannot sign.
3. **Verified.** The **RMO** checks the signed copy and verifies it (`POST .../discharge-summary/verify`, permission `CONSULTATION_VERIFY`; a short note is optional). The person who signed or amended that version can never verify it. The verification is stored as an append-only row and appears in the audit log as `DISCHARGE_SUMMARY_VERIFIED`.
4. **Amendment.** An amendment (with a reason) is a new version and shows *Signed (amended, version N)* until it is verified again; verification belongs to one version.

By default verification is **not required** to discharge (a signed summary is enough). A facility can switch on *Also require a second doctor to verify it* (Administration → Discharge rules, setting `DISCHARGE_REQUIRE_VERIFIED_SUMMARY`); discharge then stays blocked with "discharge summary is not verified".

### The RMO role
`RMO` is a system role created in every hospital: it reads the whole ward (`DATA_SCOPE_WARD`, so being a registered practitioner does not narrow it to "my own patients"), prepares drafts, records vitals, and verifies signed summaries. It cannot sign, prescribe or bill. An RMO needs a practitioner record (a registered, active clinician); give it an empty saved schedule so nobody can book appointments with it. The demo seed creates `rmo1`.

## The laboratory / radiology stage shows three checks
The relevant departments answer for every laboratory and radiology test ordered on the admission. The stage works it out from the test orders, the lab results and the radiology reports, and clears **by itself** once everything is settled (there is no Clear button). Tests taken off ("Not needed", with a reason) do not count; cardiology and procedure tests are not this stage's business.
- **Laboratory**: every laboratory test is *resulted*, meaning its result is **verified** by the pathologist (a draft is not a result).
- **Radiology**: every radiology test has a **signed report** (a performed study is not reported yet).
- **Charges**: every test has been **billed** by the cashier. A test that is not billed is a pending charge: the cashier bills it, or marks it *Not needed*.

A test that is billed but not yet resulted or reported is a **pending service**; a test that is not billed is a **pending charge**. Either one keeps the stage pending, the discharge blocked, and the final bill refused ("Clear these steps before billing"). A doctor can still **waive** the stage with a written reason (at least 10 characters). The stage is in the default list of required steps; a hospital can remove `LAB_RADIOLOGY` from `DISCHARGE_REQUIRED_STEPS`, and a pending test then no longer blocks discharge.

### Ordering a test from the admission
The treating doctor or the RMO orders a laboratory or radiology test from the admission itself: Discharge tab → **Laboratory and radiology tests** → choose the kind, type the test name and press **Order test** (`POST /admissions/:id/test-orders`, permission `CONSULTATION_CREATE`; `GET` lists them with where each one stands). The name is matched to the price list by name or code, like the tests a doctor advises at an outpatient visit; a test that matches nothing is still ordered and the cashier picks or types a price. The same test cannot be ordered twice, and a closed admission takes no more orders. The list shows each test as *To be billed by the cashier*, *Billed · waiting for the result* (or *report*), *Done* or *Not needed*, and the "Laboratory / radiology" stage follows the same records.

## The OT / procedure stage shows three checks
The OT / procedure coordinator answers for every procedure planned for the admission (see [procedures.md](procedures.md)). The stage works it out from the procedure records and clears **by itself** once everything is settled; there is no Clear button. A cancelled procedure does not count.
- **Procedure**: every procedure is *finalised*. A procedure still planned, or performed but not finalised, keeps the stage pending.
- **Implants**: every implant recorded has its charge and its procedure is finalised.
- **Consumables**: the same for consumables.

A procedure, implant or consumable whose charge is missing or voided is flagged too. A problem keeps the stage pending, blocks the discharge and refuses the final bill ("Clear these steps before billing"). A doctor can still **waive** the stage with a written reason (at least 10 characters). The stage is in the default list of required steps; a hospital can remove `OT_PROCEDURE` from `DISCHARGE_REQUIRED_STEPS`, and a pending procedure then no longer blocks discharge.

## The insurance stage shows two checks
The TPA desk answers for the insurance claim; the insurer is the external payer (see [claims.md](claims.md)). The stage is worked out from the claim whose visit is this admission and clears **by itself**; there is no Clear button.
- **Self-pay.** No live claim and no valid policy (an expired or inactive policy does not count): the stage clears with **Not applicable: self-pay patient**. Nothing to do.
- **Insured, no claim.** The patient has a valid policy but no claim is open: pending, *Insurance claim not started*. The TPA desk starts the claim from the **Insurance** card on the Discharge tab (cashless or reimbursement). A doctor can waive the stage for a patient who chooses to pay (reason of at least 10 characters).
- **Documentation**: at least one document is attached to the claim (removed ones do not count) **and**, for a cashless claim, the claim has been sent for authorisation (pre-authorisation requested). A reimbursement claim only needs its documents collected now; it is filed after the final bill.
- **Authorisation**: a cashless claim has its pre-authorisation requested **and** answered. Waiting for the insurer, an open insurer query, or no request yet keeps the stage pending and says which. An approved authorisation shows the approved amount against the amount asked. A reimbursement claim needs none. If the insurer rejected the authorisation, that is tracked: the stage clears and says the patient pays as self-pay.

A closed claim (withdrawn or written off) is no longer live. A pending insurance stage blocks the discharge and refuses the final bill ("Clear these steps before billing"), as for every other required stage; a hospital can remove `INSURANCE` from `DISCHARGE_REQUIRED_STEPS`. **MedOS keeps the record; it does not send anything to the insurer or TPA** (see claims.md, known limitations). The claims officer role can open an admission (`ADMISSION_READ`) to start the claim and watch this stage; they cannot waive it or discharge the patient.

## The pharmacy stage shows three checks
The inpatient pharmacist answers for what happened to the patient's medicines. The row (and `steps[].checks` and `steps[].reconciliation` in the API) works it out from the records:
- **Issues**: everything handed to the patient since admission: medicines dispensed to the admission, medicines drawn from a ward store, and counter sales. It shows the number of issues, units and value. It is red while prescribed medicines are still waiting to be dispensed, or when a ward-store issue has lost its charge (voided or missing).
- **Returns**: the units returned and their value. For medicines dispensed to the admission, what is billed (not voided) must equal *issued minus returned*; if it does not, the row names the medicine and the numbers (for example "4 issued, 1 returned, but 0 billed (should be 3)").
- **Eligible credits**: a return of a medicine that was already invoiced (a counter sale, or a medicine already on the final bill) needs credit notes covering its value. The return itself raises the credit note; the check is red if the credit notes cover less than the returned value.


Anything red is a **problem**: the stage does not clear itself, the pharmacist's Clear is refused with "Pharmacy clearance blocked: ...", and the discharge stays blocked. A doctor can still **waive** the stage with a written reason (at least 10 characters), which is recorded permanently together with the mismatch.

### Returns after the final bill
A medicine dispensed to the admission and **not yet billed** is returned by voiding its charge and re-posting what remains. One that is **already on the final bill** can now be returned too: the medicine goes back to stock, the billed charge is left as it is, and a **credit note** for the value returned is raised on that invoice (reason "Pharmacy return: …", refunded by the cashier if the bill was already paid). The *Eligible credits* check counts those returns: it is red until the credit notes on the bill cover the value returned after billing.

### Putting back a missing charge
If a medicine charge goes missing (for example billing voids it by mistake), the stage turns red. While the final bill has **not** been issued, the pharmacist presses **Re-post missing charges** (`POST /admissions/:id/discharge/pharmacy/repost-charges`, permission `PHARMACY_DISPENSE`) and the stage reconciles by itself, with no waiver. It re-creates the charge for exactly the units that are missing (issued minus returned minus what is still billed), for both medicines dispensed to the admission and ward-store issues, and writes `PHARMACY_CHARGES_REPOSTED` to the audit log. Once the final bill is issued the bill is never touched: a doctor can waive the stage instead.


## Post-discharge: records complete; claims and receivables tracked
After the patient has gone, three departments close the stay. The row has six checks:
- **Records** (the Medical Records Department): *Discharge summary* signed (and verified where `DISCHARGE_REQUIRE_VERIFIED_SUMMARY` is on), *Clinical documents* with no drafts left open, *Departure* recorded (physical exit; not applicable when the patient absconded), and the *Medical records sign-off*. When the first three are in order the MRD (a new role, `MEDICAL_RECORDS`, demo user `mrd1`; permission `MRD_RECORD_COMPLETE`) presses **Mark records complete** on the Discharge tab (`POST /admissions/:id/discharge/records-complete`, optional `note`). It is refused, with what is missing, while the record is not ready; it can be done once; the sign-off (`MedicalRecordCompletion`) is never changed and is audited as `MEDICAL_RECORD_COMPLETED`.
- **Claims** (the TPA desk): the stay's insurance claim with its insurer and status; it stays open while the claim is live (draft, pre-authorisation, submitted, query, approved) and shows what the insurer still owes.
- **Receivables** (finance): what the patient still owes on the final bill (for example after a financial-release exception) and what the insurer has authorised and not yet paid, by the same rule as final billing and the patient statement.

Where it stands: *Records not yet complete* until the sign-off; then **Records complete; claims and receivables tracked** while a claim is open or money is owed; then *Records complete; claims and receivables closed* by itself once the claim is finished and nothing is owed.

The **Post-discharge** page (MRD, claims officer, cashier, manager: `MRD_RECORD_COMPLETE`, `CLAIM_READ` or `REPORT_FINANCE`) lists the discharged stays of the last 90 days with anything open, or filtered to records to complete, claims to follow or money still owed (`GET /post-discharge?show=OPEN|RECORDS|CLAIMS|RECEIVABLES|ALL&days=`). Housekeeping and nurses do not see it. Migration `20261110190000_post_discharge_records`. **Diagnosis coding.** *Mark records complete…* opens a coding form pre-filled with the final diagnoses of the signed summary: each diagnosis gets an ICD-10 code (format checked, for example K35.8; the same code cannot be used twice) and one is marked primary. The codes (`MedicalRecordCode`) are kept with the sign-off and never changed (one primary per admission, enforced by the database).

**Record file.** MRD tracks the paper record: *received* in MRD, *filed* (where: rack / shelf), *issued* (to whom), *returned*, filed again, only in that order (`POST /admissions/:id/discharge/record-file`). Each movement (`MedicalRecordFileMovement`) is append-only and audited (`MEDICAL_RECORD_FILE_MOVED`). The row shows where the file is; the list has a *Record file* column.

**Ageing.** The post-discharge list shows what patients and insurers still owe by days since discharge: 0-30, 31-60, 61-90, 90+ (`ageing` in the response). Migration `20261110200000_mrd_coding_and_files`.

## Bed turnover: vacated, cleaning, ready
When the doctor completes the discharge, the bed is **vacated** (status *Cleaning*, the `BED_AFTER_DISCHARGE` default) and a turnover is opened. **Housekeeping** (a new role, `HOUSEKEEPING`, demo user `housekeeping1`; the nurse has the same permission `BED_HOUSEKEEPING`) works from the **Housekeeping** page: the beds to turn around, oldest first, with ward and room, **never the patient** (housekeeping cannot open admissions or patients).
- **Start cleaning**, then **Mark ready**, in that order and once each, each recorded with who and when. *Mark ready* makes the bed *Available* again (unless it was meanwhile put under maintenance). API: `GET /bed-turnovers`, `POST /bed-turnovers/:id/start`, `POST /bed-turnovers/:id/ready`.
- A nurse who uses *Mark clean* on the bed board completes the open turnover at the same moment, so the bed and the turnover never disagree.
- A hospital that sets `BED_AFTER_DISCHARGE` to *Available* (no cleaning step) gets the turnover ready at once (*Ready (no cleaning step at this hospital)*).
- The record (`BedTurnover`, one per discharged admission) only fills its steps in order; a step, once recorded, is never changed, and nothing is deleted (database trigger and checks). Audit: `BED_CLEANING_STARTED`, `BED_TURNOVER_READY` (with the minutes from vacated to ready), `BED_STATUS_CHANGED`.

The checklist row shows the bed, when it was vacated, who started the cleaning, who made it ready and the turnaround in minutes. Like physical exit it is reported next to the steps (`turnover`), because it happens after the discharge. Beds vacated by a transfer go to *Cleaning* as before but do not open a turnover. Migration `20261110180000_bed_turnover`.

## Physical exit: actual departure confirmed
The doctor's *Discharge patient* closes the stay administratively (bed released, visit closed). The patient then has to actually leave. The ward nurse or **patient transport** (a new role, `PATIENT_TRANSPORT`, for ward attendants and porters; demo user `transport1`) confirms it on the Discharge tab, or `POST /admissions/:id/discharge/departure` with `mode` and optionally `departedAt`, `escortedBy`, `note`. Permission `DISCHARGE_DEPARTURE_CONFIRM` (the nurse and patient transport).
- **When**: only after the discharge is completed; the time defaults to now, cannot be before the discharge and cannot be in the future (more than 5 minutes ahead).
- **How**: walked out, wheelchair, stretcher or ambulance; for a death, *body released*, and only for a death.
- **Once**: the record (`AdmissionDeparture`, one per admission) is never changed or removed (database trigger) and is audited as `PATIENT_DEPARTURE_CONFIRMED` with the time, the mode and the minutes after discharge.
- A patient who **absconded** shows *Not applicable* and nothing can be confirmed.

The row comes after financial release and shows the departure time, how, who escorted, who confirmed and how many minutes after the discharge the patient actually left (the discharge-to-exit time). It is reported as `exit` next to the steps, because it happens after the discharge and does not gate it. Migration `20261110170000_discharge_physical_exit`.

**The bed is freed at the actual departure.** *Discharge patient* closes the stay but the patient keeps the bed (still *Occupied*; the bed board shows *discharged, awaiting departure*; bed turnover shows *Bed kept until the patient leaves*). Confirming the departure releases the bed (to *Cleaning*, or straight to *Available* where `BED_AFTER_DISCHARGE` says so) at the departure time and opens the bed turnover. A patient who **absconded** has no departure, so the bed is released at discharge. A hospital that prefers the old behaviour sets `BED_RELEASE_AT` to `DISCHARGE` (default `DEPARTURE`).

## Financial release: cleared, or an authorised exception
The last stage. It **clears by itself** (*Cleared*, note *Nothing outstanding*) as soon as final billing is reconciled, so most patients never need anyone to touch it.

When money is still outstanding (the patient's share unpaid, an advance not returned, an overpayment not refunded), the discharge is blocked. A person with **`DISCHARGE_FINANCIAL_EXCEPTION`** (the Manager role, billing / finance) can release the patient anyway: *Authorise exception…* on the Discharge tab, or `POST /admissions/:id/discharge/financial-exception` with a `reason` (10 to 240 characters). Rules:
- only after the doctor's decision and after the final bill is generated (an exception is for money outstanding on the bill);
- never when nothing is outstanding (the stage has already cleared) and only once;
- a doctor cannot waive this stage, and the cashier cannot authorise it;
- the reason is kept with the amounts outstanding at that moment (patient owes, deposits unapplied, overpaid), the row shows *Authorised exception* with who and when, and the audit event `DISCHARGE_FINANCIAL_EXCEPTION_AUTHORISED` records the reason, the bill and the amounts.

The exception releases the patient: the discharge may complete while **final billing still shows Pending** with what is outstanding. Nothing about the bill changes: it stays issued and has to be settled (collected, credited or written off through the normal billing screens). The other stages, clinical and financial, are not affected by the exception. Two checks show on the row: *Final billing* (reconciled or what is outstanding) and *Authorisation* (not needed, none yet, or authorised by whom).

Migration `20261110150000_discharge_financial_release` adds the stage and gives the permission to the Manager role. A hospital can remove `FINANCIAL_RELEASE` from `DISCHARGE_REQUIRED_STEPS`; final billing then stays the money gate on its own.

## The final billing stage shows four checks
IP billing answers for the money side of the stay. The stage is worked out from the final bill, the patient's advance deposits (see [advance-payments.md](advance-payments.md)), the credit notes and the insurance claim, and clears **by itself**; it cannot be waived.
- **Final bill**: the final bill is generated (or there is nothing chargeable). Unbilled charges keep the stage pending ("Generate the final bill").
- **Deposits**: every advance the patient paid since being admitted (an advance taken earlier, or tied to an appointment booking, is not this stay's) has been **applied to a bill or refunded**. A balance left with the hospital keeps the stage pending and blocks the discharge, with the amount shown.
- **Credits**: credit notes leave nothing overpaid. If the bill is worth less than was paid after a credit note, the refund that is due keeps the stage pending until it is refunded.
- **Patient liability**: the bill's balance less the insurer's authorised share that has not yet been paid. A cashless patient pays only their own share before discharge; the insurer's authorised amount (the approved claim, or the approved pre-authorisation, less what the insurer has already paid onto the bill) is awaited separately and shown. A rejected authorisation leaves the whole bill to the patient. A cancelled or fully refunded bill is settled.

The money is exact decimal. The `reconciliation` object carries `billTotal`, `credited`, `overpaid`, `deposits` (`received`, `applied`, `refunded`, `unapplied`), `insurerShare` and `patientLiability`. The insurer's payment, once it arrives, is posted on the bill as before (docs/claims.md); the claim is settled outside the discharge.

## The nursing stage shows three checks
Under the nursing row the screen (and `steps[].checks` in the API) lists the three things the stage stands for:
- **Medication**: no dose is overdue and unrecorded (a missed dose must be recorded as given, missed or refused). *Blocks clearance.*
- **Clinical documentation**: no nursing task is still pending; the number of nursing notes on file is shown. *Pending tasks block clearance.*
- **Handover**: confirmed when the nurse clears the stage. The nurse can type a **handover note** (3 to 300 characters) first; it is stored with the clearance and shown on the row afterwards. The note is optional.

## Rules (unchanged)
- The doctor's decision comes first; no other stage can be cleared or waived before it.
- A waived stage shows *… waived* and keeps the reason as its note.
- Each cleared or waived stage shows who did it and when (`byName`, `at`).
- The patient is discharged (bed released, visit closed) only when every required stage is cleared, the discharge summary is signed (if the facility requires it, and verified if it requires that too), and the final bill is settled.

## Extra fields
- On each step: `stage`, `responsible`, `description`, `hisStatus`, `byName`, `at`, `automatic` (no Clear button), `waivable`, and `checks` (nursing, pharmacy, laboratory / radiology, OT / procedure, insurance and final billing) with `reconciliation` (pharmacy, laboratory / radiology, OT / procedure, insurance and final billing; for insurance it carries `insured`, `validPolicies` and the linked `claim`).
- On `summary`: `status` (`NOT_STARTED`, `DRAFT`, `SIGNED`, `AMENDED`, `VERIFIED`), `hisStatus`, `preparedByName`, `signedByName`, `signedAt`, `verifiedByName`, `verifiedAt`, `verificationNote`, `verificationRequired`.

## Discharge turnaround report
**Reports → Discharge turnaround times** (`GET /reports/ipd/discharge-turnaround?from=&to=`, `REPORT_IPD`/`REPORT_READ`, ranges up to 93 days) shows, for the stays discharged in the range, how long each part took, with the number of stays measured, the average, the median and the slowest tenth (in minutes), and names the stage that was slowest to clear. Parts measured: summary signed and verified after the doctor's advice; nursing, charges review and pharmacy cleared after the advice; the final bill issued and the dues paid (or released by an authorised exception); every measured clearance done; discharge completed after the last clearance; the whole of advice to discharge; discharge to the patient leaving; the patient leaving to the bed being ready; and the whole journey from advice to bed ready. A list of the stays with their main times follows. Lab and radiology, OT and insurance clear on their own and keep no time of their own, so they are not measured. A stage is counted only for stays that have its times. Tests: `discharge/discharge.spec.ts` ("discharge turnaround report").

## Housekeeping requests and record retention
Requests for housekeeping or maintenance anywhere in the building are in docs/housekeeping.md. How long records are kept and what happens when the period is over is in docs/record-retention.md.

