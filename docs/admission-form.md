# Admission form

## Purpose

A printed form for an in-patient admission: who is admitted, under which consultant and where, who to contact, known allergies, the consent wording, and signature lines for the patient or relative and the admitting doctor. It is printed when the patient is admitted and can be printed again later.

## How to print it

In-patient screen of the admission → **Print admission form** (opens the page to print) or **PDF** (downloads). Reception, nurses, doctors, cashiers and pharmacists can print it (permission `ADMISSION_READ`). A cancelled admission has no form (409). An admission outside the signed-in user's data scope or another hospital's answers 404.

`GET /api/v1/print/admission-forms/:admissionId?format=html|pdf&download=0|1`

## What is on the form

| Section | Content |
| --- | --- |
| Admission | admission number, admitted at (facility time), consultant and specialty, department, ward, room and bed, reason |
| Patient | name, MRN, gender, age or date of birth, blood group, mobile, address |
| Contacts | guardian (name, relation, mobile), emergency contact |
| Allergies | known active allergies of the patient's whole chart, when there are any |
| Consent and declaration | the hospital's consent wording, then two signature blocks: patient or relative (name, relationship, date and time to be written in) and the admitting doctor |

## Languages

The form prints in **English** (default), **Bengali** or **Hindi**: the links *বাংলা* and *हिन्दी* beside **Print admission form**, or `?lang=bn` / `?lang=hi` on the print address (the PDF has the Bengali and Devanagari fonts embedded). Headings, labels and the signature lines change language; names, numbers, dates and the hospital's header stay as entered. The built-in Bengali and Hindi wording has **not yet been reviewed by a native speaker**: the hospital should check it and replace the consent paragraph with its own approved text.

## Configuration (no hospital is hard-coded)

* Hospital name, logo, address, GST and phone: `PRINT_HEADER` (Administration → Settings), the same for every document.
* Footer: `PRINT_FOOTER.admissionForm` (Administration → Settings → print footers, "Admission form").
* Consent wording: settings `ADMISSION_CONSENT_TEXT` (English), `ADMISSION_CONSENT_TEXT_BN` (Bengali) and `ADMISSION_CONSENT_TEXT_HI` (Hindi), each 10 to 1,500 characters. The defaults are short neutral paragraphs; the hospital should replace them with wording approved by its own legal adviser.

## Audit and safety

* Every print is audited as `DOCUMENT_PRINTED` (document type `ADMISSION_FORM`, format, copy number). No patient or clinical text is put in the audit line.
* A second print of the same admission is stamped **DUPLICATE COPY**.
* Everything typed by staff is escaped; the page is served with a locked-down content security policy and is never cached.

## Known limitations

* The form is a printout, not a captured consent: the signed paper is kept by the hospital. Storing a scan of it is done through the patient's files.
* The consent wording is one text per language for the facility; wording per admission type is not supported yet.
