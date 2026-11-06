# Digital and handwritten prescriptions

## Digital prescription (visit screen)

The doctor writes everything on the one consultation screen:

* patient details, allergies and vitals (shown at the top of the screen and on the prescription), chief complaints / symptoms, medical history (present illness and past history), examination
* diagnosis
* **medicines**: picked from the medicine master or typed; dose, route, frequency, days, quantity, **food timing** (before, after, with food, empty stomach, any time) and instructions
* investigations, each its own list, picked from the hospital investigation list or typed (any custom entry is allowed): **laboratory**, **radiology / imaging**, **cardiology** and **other diagnostic procedures**
* doctor advice and recommendations, **diet advice**, **referral**, follow-up (after N days or on a date) and follow-up instructions
* doctor details (name, specialty, registration number) and the digital signature, applied when the doctor signs
* **templates**: save what is on screen under a name (private or shared with the facility's doctors) and apply it later. A template holds medicines, tests and advice only, never patient details. Applying a template only fills the screen; the doctor still reviews and signs.
* a live preview of the whole prescription as the patient will receive it, a saved draft (edit as often as needed), and past visits with their prescriptions one click away

Signing locks the note, applies the digital signature, makes the prescription PDF available (Open prescription / Download PDF) and sends the medicines to the pharmacy queue. Corrections after signing are amendments. The printed prescription includes vitals, complaint, diagnosis, medicines with food timing, tests, advice, diet, referral and the follow-up date.

Permissions: `PRESCRIPTION_CREATE` for templates and writing, `CONSULTATION_SIGN` to sign. Audit: `PRESCRIPTION_TEMPLATE_SAVED`, `PRESCRIPTION_TEMPLATE_REMOVED`. Removing a template hides it; nothing is deleted.

## Handwritten prescription

Off by default. Administration → Settings → "Handwritten prescriptions and OCR":

| Setting | Meaning |
| --- | --- |
| `PRESCRIPTION_UPLOAD_ENABLED` | doctors can attach a photo or PDF (PNG, JPEG, PDF, up to 5 MB) to a visit, at any time, also after the consultation is signed and the visit is completed |
| `PRESCRIPTION_OCR_ENABLED` | read uploads with the connected OCR service |

The picture is stored as an ordinary patient file (type- and content-checked, virus-scanned when ClamAV is configured, access-controlled).

**Flow: doctor → pharmacy → cashier**

1. **Doctor uploads** (`PRESCRIPTION_SCAN`; PNG, JPEG or PDF, up to 5 MB each), during the visit or after the consultation is signed. A prescription can have up to 10 pages ("Add another page" until the pharmacy has dealt with it); more than one prescription can be uploaded for a visit. If OCR is on, each page is read (a failed page can be read again without redoing the others). The doctor may add an optional note to help the pharmacist read the handwriting. The doctor does not enter medicines.
2. **The pharmacy sees it at once.** The picture, every page, appears in Pharmacy → Prescription queue → "Handwritten prescriptions from doctors", with the patient, MRN, doctor, visit and the patient's recorded allergies. The pharmacist opens each page, and any note or machine reading is shown only as a help ("may be wrong: work from the picture").
3. **Pharmacist verifies and enters the medicines.** The pharmacist confirms they looked at all pages and that it is a valid prescription for this patient (required), searches the medicine master, enters each medicine and quantity from the handwriting, and dispenses. Batches are chosen first-expiry-first-out, expired stock is refused, and a medicine that matches a recorded allergy needs an acknowledgement, as for any sale.
4. **Bill to the cashier.** Dispensing generates the pharmacy bill (issued, not paid), linked to the visit and to the picture. It appears on the Cashier's screen, which collects the payment and updates its status. The pharmacy never takes payment.
5. **Outcome.** The picture leaves the pharmacy list when a dispense completes it ("more still to be dispensed later" keeps it listed for the next part), or when the pharmacist sends it back with a reason ("I cannot use this picture": blurred, wrong patient, not a prescription). Either outcome, who did it and when, is final and is shown to the doctor on the visit; a sent-back picture is replaced by uploading a clearer one as a new prescription.

The doctor's upload never creates a prescription, a medicine order or a bill by itself: the medicines are the pharmacist's own entries, made while looking at the doctor's picture. Digital prescriptions (written on the consultation screen) work differently: they reach the pharmacy as a ready list of medicines to verify and dispense.

Uploading never modifies the signed consultation: the document, its versions and its signature stay exactly as signed. The original picture, its pages, any OCR text and note, and what the pharmacy did stay linked to the visit and the patient.

Note: the server still has the earlier "doctor enters the medicine lines and approves" interface (`PUT /prescription-scans/:id/lines`, `POST /prescription-scans/:id/approve`, which creates a signed prescription with source HANDWRITTEN). The screens no longer use it.

Audit: `PRESCRIPTION_SCAN_UPLOADED`, `_PAGE_ADDED`, `_OCR_DONE`, `_OCR_FAILED`, `_OCR_SKIPPED`, `_CORRECTED`; `PHARMACY_DISPENSED` (with the picture and the pharmacist's confirmation), `HANDWRITTEN_PRESCRIPTION_REJECTED`. The text itself is not copied into the audit trail.

## Connecting an OCR service (Administration → Settings)

Administrators with `ADMIN_SETTINGS` manage it on the same card, without touching the server:

* **Service address** and **wait time** (1 to 60 s).
* **API key**: write-only. It is encrypted (AES-256-GCM) with `SECRETS_ENCRYPTION_KEY` before it is stored, never returned, never logged or audited (only its last 4 characters are shown). If the server has no encryption key, a key cannot be saved. A saved key is never sent to a different address: changing the address needs the key again or removing it.
* **Test connection**: sends a blank test picture (no patient data) and records the result. A service that answers but finds no text in the blank picture counts as working.
* **Disconnect**: removes the address and key. Each action is audited (`OCR_CONFIG_SAVED`, `_TESTED`, `_DISCONNECTED`).

In production the address must be a public `https://` address: localhost, private, link-local and cloud-metadata addresses (also when a name resolves to one) are refused, and redirects are not followed. Without a connection saved here, the server's `OCR_PROVIDER`/`OCR_API_URL`/`OCR_API_KEY` settings (if any) are the default.

The service receives JSON `{ "fileName", "contentType", "contentBase64" }` with `Authorization: Bearer <key>` when a key is set, and may answer `{ "text", "confidence"? }`, `{ "lines": [...] }`, `{ "data": { ... } }` or the Google Cloud Vision shape. Anything else needs a small adapter in front of the service; a different protocol can be added by implementing `OcrProvider` in `apps/api/src/modules/prescriptions/ocr.provider.ts`.

**Privacy.** The prescription image is sent to that service and contains patient information. Use a provider covered by your data-protection arrangements (see `privacy.md`). Neither the image nor the text is logged by the server.

## Sharing the signed prescription with the patient

Permission `PRESCRIPTION_SHARE` (doctors and the front desk). On a signed visit, "Share with the patient" creates a link valid for 1 to 30 days. The patient opens it without signing in and sees the prescription, with Download PDF; there is nothing else behind the link.

* The link's secret is shown once and only its hash is stored; it cannot be recovered, only replaced. A link can be revoked at any time (it cannot be reopened).
* Every opening is counted and audited (`PRESCRIPTION_SHARE_OPENED`, with no staff member as actor); creating and revoking are audited too (`PRESCRIPTION_SHARED`, `PRESCRIPTION_SHARE_REVOKED`).
* A wrong, expired or revoked link all give the same answer. Opening is rate limited per address.
* Staff can copy the link, or use the WhatsApp button, which opens a chat with the message ready for the staff member to send. The system can also **send it by message itself** (next section).
* Anyone holding the link can read the prescription until it expires: choose a short validity and revoke a link sent to the wrong person.

## Sending the prescription to the patient's phone

Staff with `PRESCRIPTION_SHARE` press **Send to the patient's phone** in the same card; the hospital can also send it **automatically when the prescription is signed** (setting `PRESCRIPTION_AUTO_SEND`, off by default). A message with a private link goes to the patient's own mobile number by WhatsApp or SMS (`PRESCRIPTION_SEND_CHANNEL`), through the hospital's approved provider.

* **The provider.** Set `MESSAGE_PROVIDER=http`, `MESSAGE_API_URL` and (if needed) `MESSAGE_API_KEY` on the server. Each message is one `POST` of JSON `{ channel, to, text, reference }` (`to` is the number with country code, `91XXXXXXXXXX`) with `Authorization: Bearer <key>`; any 2xx answer is acceptance, and the provider's message id is taken from `id`, `messageId` or `data.id`. A provider that wants another shape needs a small adapter in front of it. The default `log` provider **only records** that a message would have been sent: the screen says so and nothing reaches the patient. In production the address must be a public `https://` address. Links in the message use `PUBLIC_WEB_URL` (default: the first CORS origin).
* **The link** is made when the message is sent, is valid for `PRESCRIPTION_LINK_DAYS` (1 to 30, default 7), and is the same kind of link as above. A failed try withdraws its link and the next try makes a new one, so a link from a failed message never stays open.
* **What is kept.** For each message: who it was for (the number masked, last four digits), the channel, what triggered it (automatic or by hand), and what happened (waiting, sent, failed, the provider's id, a short reason). **Not** the message text, the full number or the link. Audit events: `PRESCRIPTION_SEND_REQUESTED`, `PRESCRIPTION_SENT`, `PRESCRIPTION_SEND_RETRIED`.
* **Consent.** A patient who has withdrawn consent to messages (the same record as appointment reminders) is never sent one, by hand or automatically, and the check is made again at the moment of sending. With the hospital's setting `REMINDERS_REQUIRE_CONSENT` on, automatic messages go only to patients who agreed.
* **Failures.** A message that cannot be sent is tried again after 1, 5 and 30 minutes (every few seconds for the worker's polling, `REMINDER_POLL_SECONDS`), then given up and shown as failed with a **try again** button. Signing a prescription never fails because of messaging.
* Only a signed prescription, and only to a mobile number saved on the patient's record, can be sent.


## Known limitations

* The message is in English; Bengali and Hindi wording and the provider's delivery receipts are in `docs/backlog.md`.
* Handwriting recognition is imperfect; that is why every reading is a draft for the doctor to check and approve.
* Reading is a single request per attempt; there is no background queue.
* Suggested lines are not matched to the medicine master; the pharmacist picks the stock item when dispensing.
* Handwritten approval is for outpatient visits; inpatient orders go through the ward prescription screen.

Signing also orders the tests the doctor advised (laboratory, imaging, cardiology, procedures) for the Cashier to bill, and the Pharmacy sees them next to the medicines. See `docs/test-orders.md`.

**How many tablets.** If the doctor writes the dose, how often and the days but leaves the quantity blank, the doctor's screen works the quantity out (for example 1 tablet, twice a day, 3 days = 6) and shows it for the doctor to keep or change. Whatever the doctor leaves blank, the pharmacist is told: the dispense screen says "the doctor wrote no quantity: 6 worked out from the dose, how often and the days. Check it", or, when it cannot be counted (as needed, a liquid, a timetable), "ask the doctor, then enter how many". The quantity box is never silently set to 1. The Cashier sees the same figure marked "calculated". The calculation covers tablets, capsules, sachets, ampoules, vials and puffs; it is in `packages/shared/src/prescription-quantity.ts` (the web app keeps an identical copy, and a test checks that they always agree). The signed prescription itself is not changed by it.

## Filling the digital prescription from a handwritten picture (OCR review)

For a doctor who would rather have the system start the digital prescription from the picture. It reuses everything above: the same OCR connection, the same pictures, and the same digital prescription screen. It adds one button, **Fill the prescription from this picture**, on each picture of a visit whose consultation is still a draft.

**1. Reading.** The picture is sent to the connected OCR service when it is uploaded (as before). A picture that is shown while it has never been read (for example uploaded before the OCR service was connected) is read once, automatically; *Read it* tries again after a failure. The doctor's own corrected text, if any, always replaces what OCR read.

**2. What is read.** Besides the medicine lines (name, strength, dose, how often, days, food, quantity), the text is searched for the diagnosis, the tests (under a "tests" heading, and well-known tests such as CBC, ESR, LFT, HbA1c, urine R/E, X-ray, USG, ECG named anywhere), advice, diet, a referral, a follow-up and the name, age and sex written on the paper.

**3. Matched to the hospital's own lists.** Each medicine is matched to the hospital's medicine list by brand or generic name (and by strength when the paper gives one), and each test to the lab-test list (the investigations of the price list). A medicine or test the hospital does not list is shown as "not matched" and left for the doctor.

**4. The review screen.** One screen shows everything that was read, each part ticked and editable:
* **Patient check**: the name, age and sex on the paper against the patient of the visit, with a warning when they differ (a wrong-patient upload).
* **Diagnosis**, **Medicines** (a **Drug** list, a **Medicine** list of brands and strengths for that drug, dose, frequency, days, quantity), **Lab tests** (a **Lab test** list and the kind of test), and **Medical advice** (advice, diet, referral, follow-up days, with one-click standard advice phrases that can be edited).
* The Drug and Lab test lists are dropdowns that can also be typed in, so anything not in the list can still be entered. If the lists cannot be loaded, the names can be typed. If nothing could be read (OCR failed or the picture is unreadable), the screen opens empty with the reason, and the doctor fills it in with the lists.
* A medicine needs a drug and a dose; days, quantity and follow-up must be real numbers; the quantity is worked out from the dose, how often and the days when it was not written.

**5. Apply, review, sign.** **Apply to the prescription** puts the approved parts on the digital prescription screen: medicines and tests are added to what is there, advice is added below the existing advice, and the diagnoses are recorded like any diagnosis added by hand. **Nothing is saved, ordered or sent by Apply**: the doctor reads it on the prescription screen, saves, and signs, and the signature is the approval. Signing then sends the medicines to the pharmacy and the tests to the Cashier as for any digital prescription.

**API.** `GET /prescription-scans/options` (`PRESCRIPTION_SCAN` or `PRESCRIPTION_CREATE`) returns the Drug, Medicine and Lab test lists of the doctor's own hospital (active items only, at most 1000 medicines and 500 tests, and says when a list was cut) and the standard advice. `GET /prescription-scans/:id/prescription-draft` (`PRESCRIPTION_SCAN`, only for visits the doctor may see) returns what was read, matched to those lists, with the patient check and warnings. Both only read; the draft creates nothing.

**Safety.** The reading is a best effort and can be wrong: handwriting and OCR make mistakes, every part is a suggestion, the doctor reviews and signs, and the pharmacist still works from the original picture. The text and the picture are never written to the logs.

**Limits.** The reading looks for common English headings and abbreviations (Dx, Rx, Inv, Advice, F/U and so on); handwriting in other languages or unusual layouts may give little. Diagnoses are suggestions in words (no diagnosis codes). A test is matched to the list by name; near-spellings may need picking from the list.

## Lab and radiology results on the printed prescription and discharge summary
Both documents now print the visit's (or admission's) **verified lab results** and **signed radiology reports**, under "Laboratory results" and "Radiology reports". A result with a critical value is left out until a doctor has acknowledged it (the same rule as the patient app), and the page says how many are with the doctor. Nothing is edited: the printed values are the signed ones.

## Changing one medicine of a signed prescription
A doctor with `PRESCRIPTION_SIGN` can change a single medicine (a dose, how often, how long, a different brand or medicine) with **Change** on the visit page's Signed medicines card, or **change** on an admission's Orders tab, without amending the whole consultation. The signed note and the signed prescription are never edited. Instead, in one step:
- the old medicine is marked **stopped** with the reason "Amended: ..." (and the doctor and time), exactly as it was signed;
- the replacement is signed now as a **one-medicine prescription of its own**, with its own prescription number, pointing back at the medicine it replaces (`amendsItemId`). A replacement can itself be changed later (a chain).
Rules: the medicine must be active on a current signed prescription; something must actually change; a reason is required; the allergy check runs on the replacement (the doctor confirms a warning); a visit with an unsigned draft prescription must finish the draft first (only one draft per visit exists). What the pharmacy already gave of the old medicine stays on the record; the replacement is a new prescription for the pharmacy queue and, on an admission, the nurse's chart. Stopped and replaced medicines show on the printed prescription as [REPLACED] and the new line as [AMENDED], with the reason under the table; the printed document keeps the first prescription's number. The patient app, the AI summary and the printout read **every** signed prescription of the visit. Audit: `PRESCRIPTION_ITEM_AMENDED` (and `PRESCRIPTION_SIGNED` for the new prescription). The database refuses a replacement of a medicine that is not stopped, one on another visit, a second replacement of the same medicine, and any change to the link afterwards. API: `POST /medication-order-items/:id/amend` (`{ reason, item, acknowledgeAllergyWarnings? }`).

## Stopping a medicine
On the admission's Orders tab the doctor chooses **stop** on an active medicine, confirms, and must give a reason (3+ characters). The medicine stays on the record as STOPPED with the doctor, time and reason (`PRESCRIPTION_ITEM_STOPPED`), and drops off the nurse's chart. On a signed OPD visit the **Signed medicines** card on the visit page does the same: a doctor with `PRESCRIPTION_SIGN` stops a medicine with a reason, including one the pharmacy has already given (an amendment refuses to replace those). The signed note and its saved version are never changed; the stop is its own record, shown on the visit, printed as [STOPPED] on the prescription, refused by the pharmacy and the nurse chart, and audited with `afterSigning` and the quantity already given. Replacing the whole prescription is still done by amending the consultation. A user who can write prescriptions but not sign them cannot stop an item of a signed visit.
