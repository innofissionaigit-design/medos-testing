# Fonts embedded in printed PDFs

Printed PDFs (`apps/api/src/modules/print/pdf.ts`) embed these fonts so English, Bengali and Hindi all print. No one font covers all
three: the Bengali font has no Latin letters, digits or punctuation, and the Devanagari font has no Latin letters, so the renderer draws
each run of text in the right font.

| Font | Used for |
|---|---|
| Noto Sans | Latin letters, digits, punctuation, the rupee sign, Greek and Cyrillic |
| Noto Sans Bengali | Bengali letters |
| Noto Sans Devanagari | Hindi (Devanagari) letters |

## Licence

All three families are licensed under the **SIL Open Font License, Version 1.1** (the licence text is in each `OFL-*.txt` file, and each
font states the same licence inside itself). In short: they may be used, embedded in documents and shipped with software, including
commercially; they may not be sold on their own, and a modified version may not use the "Noto" name. Keep the `OFL-*.txt` files with
the fonts. REMINDER.md calls for a legal review of this licence before a hospital pilot; that review is still to be done.

## Where they came from

Downloaded on 2026-10-29 from the official Noto project repository, https://github.com/notofonts/notofonts.github.io (folder
`fonts/<Family>/hinted/ttf/`). The licence texts come from the project repositories `notofonts/latin-greek-cyrillic`,
`notofonts/bengali` and `notofonts/devanagari`. Each file was checked to be a valid TrueType font before it was added.

| File | Bytes | SHA-256 |
|---|---|---|
| `NotoSans-Regular.ttf` | 621572 | `478c558ea716033cd60c03438f628dfa75694dcf6b5f6d505a2f05fd2b4f3823` |
| `NotoSans-Bold.ttf` | 631484 | `1df075a380fc7cb898acf64c1f7b3b4dd780de3caa860178bf929de35817a913` |
| `NotoSansBengali-Regular.ttf` | 143072 | `b55c62ee531e3214da6c0701daecea89a52ba42db7d8206b92e6b51f397a3193` |
| `NotoSansBengali-Bold.ttf` | 144828 | `923c6a4c2eb618a57ed83f4bca855b4f5287b87906a4d9df40a2ffa8ebd8c2e8` |
| `NotoSansDevanagari-Regular.ttf` | 243520 | `4e3c66638958c3e2ab5d37f47a8deb89fffeb7be9985c665a519bbc7ba762313` |
| `NotoSansDevanagari-Bold.ttf` | 250176 | `6a09c8d797cfc803d32cdc731e809424d74cbaff59f503de34ade421a08e5bc2` |

## Replacing or updating

Put new files here with the same names (a different file name needs `FONT_FILES` in `pdf.ts` updated), and update the checksums above.
If a font file cannot be read at runtime the API logs `pdf_fonts_unavailable` and prints with Helvetica instead (Latin only).