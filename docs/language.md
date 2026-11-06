# Language (English, Bengali, Hindi)

A user picks a language from the language switcher in the top bar. The choice is remembered in a cookie (`medos_lang`) and in the browser, so it survives a reload and a new sign-in on the same computer.

## What changes, and what does not

| Changes with the language | Stays exactly as it was entered or recorded |
|---|---|
| Menus, page titles, headings, buttons, tabs | Patient names, doctor and staff names |
| Table column heads, form labels, hints, placeholders | MRN, visit, admission, invoice, receipt and prescription numbers |
| Statuses and badges (waiting, occupied, paid, …) | Bed, room and ward names (G1, ICU, General Ward) |
| Messages, empty-list notes, confirmation prompts | Medicine, test and service names; department names |
| Dates (month and weekday names) and the page `lang` | Diagnosis, complaints, notes, advice: whatever the clinician typed |
| | Amounts and numbers: always Latin digits (1,234.50), so money is never ambiguous |

So it is more than menus (every label and status), but never the hospital's own records. A nurse who typed a note in English sees it in English on a Bengali screen. Clinical content is not machine-translated: a wrong translation of a dose or a diagnosis is a patient-safety risk.

## How it works

* English text is the key. `translate(lang, text)` looks the text up in `apps/web/src/lib/locales/bn.ts` or `hi.ts` and **falls back to English**, so a missing entry shows readable English, never a blank or a raw key.
* The shared components (`Button`, `Card`, `Table`, `Field`, `Badge`, `Modal`, …) translate their text themselves. Plain text outside them is wrapped in `<T>…</T>` (or `useT()`).
* Never wrap data in `<T>`. A name that happens to match a dictionary phrase would be translated.
* Dates and money use the chosen language's locale with Latin digits (`localeFor`).
* The patient app is English (docs/architecture/architecture-current.md). Printed documents and PDFs use Latin fonts only, so Bengali or Hindi text in a print (a patient's name, a note) shows as "?" (docs/certification.md §5); a Bengali/Hindi font is a later item.

## Adding or fixing a translation

1. Add the English text and its Bengali and Hindi translation to both `bn.ts` and `hi.ts` (a test fails if one has a key the other lacks).
2. If the text still shows in English, it is rendered outside a shared component: wrap it in `<T>`.
3. `node scripts/extract-ui-strings.mjs --list` reports gaps.

## Known limitations

* Fixed labels, hints, notes and table heads on all screens, including the add-on ones (payroll, claims, ABDM, radiology, lab, attendance, data import, integrations), are translated. About 20 sentences that are split around a link or bold word in the code (for example "Before the OPD visit: click **New bill**, add …") cannot be matched as one phrase and stay English until they are restructured.
* Plain text outside the shared components still needs `<T>`; a few places were wrapped (patient page, advance, ledger, privacy, identifiers) and others may remain. The add-on screens were translated through the dictionary and were not each re-checked in the browser.
* Text produced by the server (ledger descriptions such as "Payment for INV-… (cash + upi)", some error messages) is English.
* Bengali and Hindi wording should be reviewed by hospital staff who use those languages before go-live.
