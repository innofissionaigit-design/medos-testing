# External review pack

Five reviews cannot be done by engineering: they need an independent qualified person, and their sign-off is theirs, not ours. This folder gives each reviewer a self-contained brief: what the system does today, where we know it is weak, the specific questions we need ruled on, how to reproduce what we describe, and what we expect back.

**Nothing here is a review result.** No clinical, tax, legal, security or accessibility sign-off exists. Until each reviewer reports, treat the area as unreviewed and do not describe MedOS as compliant, certified or clinically safe.

| Review | Brief | Reviewer | Status |
|---|---|---|---|
| Clinical safety | [clinical-safety.md](clinical-safety.md) | Practising clinician plus a clinical-safety officer (a hazard log is a reasonable method) | Not started: needs a reviewer |
| GST / tax (spec gap G6) | [gst-tax.md](gst-tax.md) | Chartered accountant or GST practitioner | Not started: needs a reviewer |
| Data protection / legal (spec gap G14) | [data-protection.md](data-protection.md) | Lawyer experienced in India's DPDP Act 2023 and health records | Not started: needs a reviewer |
| Penetration test | [penetration-test.md](penetration-test.md) | Independent security firm | Not started: needs a vendor and a staging environment |
| Accessibility audit | [accessibility.md](accessibility.md) | Specialist using assistive technology (WCAG 2.1 AA) | Automated self-check done in part; audit not started |
| Multi-user load test | [../load-test.md](../load-test.md) | Engineering | Run on one machine; staging-scale run still needed |

**Provisional defaults waiting for a reviewer** (what engineering built where the rules are unsettled, and who must decide each): [pending-decisions.md](pending-decisions.md).

## How to run a review

1. Give the reviewer the brief, read-only access to the repository, and a **staging** environment seeded with synthetic data (`docs/deployment.md`, "Seed"). Never production, never real patient data.
2. Ask for written findings with severity, evidence and a recommended fix, and a statement of what was **not** covered.
3. Log each finding in `docs/backlog.md` with an owner. Fix, then ask the reviewer to confirm closure.
4. Record the review (date, reviewer, scope, outcome) in `docs/certification.md`; keep the report itself outside the repository if it contains vulnerabilities.
