# ADR-006: Common Encounter model

**Status:** Accepted (Stage 0; CLAUDE.md §8, spec §6.2)

## Context
OPD visits and IPD admissions generate the same kinds of clinical records (vitals, notes, diagnoses, orders, charges). Separate visit concepts per module would duplicate logic and break longitudinal history.

## Decision
One `Encounter` entity with `type` (`OPD`, `IPD` in MLP-1; `EMERGENCY`, `TELECONSULT`, `DAYCARE` later), `status`, `patientId`, `tenantId`, `facilityId`, `departmentId`, `practitionerId`, `encounterNumber`, `startedAt`, `endedAt`. Clinical records reference both `patientId` and `encounterId`. Type-specific data lives in extension tables (`QueueEntry` and `Appointment` for OPD; `Admission`, `BedAssignment` for IPD) that point to the encounter, not in module-specific visit tables. Encounter status transitions are validated centrally. Allergies are patient-level (not encounter-bound).

## Alternatives considered
- **Separate `OpdVisit` and `Admission` roots:** rejected, duplicated clinical plumbing.
- **Episode-of-care hierarchy:** premature for MLP-1; can wrap encounters later.

## Consequences
+ One chart timeline, one place for orders/vitals/notes, easier future types.
− Type-specific invariants (e.g. an IPD encounter must have an admission) are enforced by services and constraints, not by table separation.
