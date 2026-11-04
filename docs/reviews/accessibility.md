# Accessibility audit brief

**Ask:** an audit against WCAG 2.1 AA (and the GIGW guidelines if a buyer requires them) using assistive technology, by a specialist. Our automated self-check is mechanical and finds only part of the problems.

## What we did (automated, mechanical)

`apps/web/e2e/a11y-rules.ts` checks each main screen for: page language and title, a main landmark, exactly one h1, heading order, image alt text, form fields without labels, buttons and links without names, positive tabindex, duplicate ids, dialogs without a name, tables without header cells, and text contrast (4.5:1, or 3:1 for large text). `apps/web/e2e/a11y.spec.ts` runs it for each role's screens and also checks that Tab focus stays inside open dialogs.

What ran so far, and what could not, is recorded in [../load-test.md](../load-test.md), section "Accessibility self-check".

## What an automated check cannot tell us

Whether labels and instructions make sense; screen-reader reading order and announcements (live regions for save and error messages); keyboard operation of every control (queue actions, pickers, the patient search); focus after navigation and dialog close; zoom and reflow at 200 to 400 percent; touch target size; meaning carried by colour alone (status badges); time limits (session expiry); error recovery; and the language switch (Bengali and Hindi strings also need native-speaker review).

## Journeys to test with a screen reader and keyboard only

1. Sign in. 2. Register a patient (target: under 45 seconds). 3. Start an OPD visit and see the queue. 4. Doctor consultation: vitals, diagnosis, prescription, sign. 5. Billing: create a bill, take a split payment, print the receipt. 6. Pharmacy: dispense from the prescription queue. 7. Nurse worklist and medication chart. 8. Admission, bed transfer, discharge.

## Known risks

Dense tables on narrow screens, icon-only controls, colour-coded status badges, the global patient-search shortcut, modal dialogs, and printed documents (PDF accessibility not assessed).

## Expected deliverable

Findings mapped to WCAG success criteria with severity, recordings or screenshots, fix recommendations, and an accessibility conformance statement if appropriate.
