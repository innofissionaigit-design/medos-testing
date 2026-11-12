# Who sees which data: doctors, departments and the organisation administrator

## Purpose

A doctor sees only their own patients, records and reports. Staff assigned to departments see only those departments. The organisation administrator sees everything. The rules are enforced on the server, on every list, search, record page and report, and never depend on what the screen hides.

## The three kinds of access

| Who | Sees | How it is decided |
|---|---|---|
| Organisation administrator | Every department, doctor, patient, record and report | Holds the permission `DATA_SCOPE_ALL` (the Administrator role has it). It wins over everything below, even for an administrator who is also a doctor. |
| Resident medical officer (RMO) | The whole ward: every admitted patient | Holds `DATA_SCOPE_WARD` (the RMO role has it). The RMO is a registered practitioner, which would normally limit them to their own patients as consultant; this permission lifts that, so they can prepare and verify discharge summaries for any consultant's patients. They cannot sign. |
| Doctor | Only their own patients, visits, records and reports | The login is linked to an active doctor record (practitioner) at the facility. A doctor's own record is the only scope; a department assignment does not widen it. |
| Department staff | Only the patients, visits, admissions and reports of their departments | The user has at least one row in the department assignment (`UserDepartment`), set by an administrator. |
| Everyone else (Reception, Cashier, Pharmacist, Nurse, Manager with no department) | What their role gives, as before | Not a doctor and no department assigned. Assigning a department to any of them limits them as above. |

The scope comes from the signed-in session (`ctx.dataScope`, worked out in `AuthGuard`), never from a request value. A doctor or department named in the URL or query changes nothing.

## What "own patient" means

A patient belongs to whoever treats them: they are visible to a doctor when the doctor has a visit, an appointment or an admission (as consultant) for them, also under a record merged into them. A department user sees a patient with a visit, appointment or admission of that department (the visit's department, or the department of its doctor).

A patient who has just been registered and has no visit yet is visible to Reception and the administrator, not to a doctor, until a visit or appointment is made with that doctor.

Once a patient is the doctor's, the patient-wide safety information (allergies and the vitals trend) is shown as a whole, because hiding an allergy another clinician recorded would be unsafe. Visit records (consultation, diagnoses, prescription, follow-ups) are limited to the doctor's own visits.

## Where it is enforced

| Area | Behaviour for a limited user |
|---|---|
| Patient search, open a patient, a patient's visits | Only their patients; others answer 404 (`PATIENT_NOT_FOUND`). The visit list shows only their visits. |
| Visit, consultation (and versions), workspace, diagnoses, prescription, scans, shares, follow-ups, vitals of a visit, printing the prescription | Only their visits; other visits answer 404 `NOT_FOUND`, the same answer as a visit that does not exist. |
| Appointments (list, one, a patient's history) | Only their appointments. |
| OPD queue | Only their queue. A doctor asking for another doctor's screen is refused 403 as before; department staff get 404 for a doctor outside the department. |
| Admissions (list, one, charges, discharge status, discharge summary, medication chart, nursing) | Only their admissions. |
| Reports: OPD daily, by doctor, by department; IPD current admissions and admissions/discharges; bookings by doctor | Counted from their data only (a doctor's by-doctor report has one row, theirs). |
| Dashboard | Reads the OPD report, the queue and the admissions list, so it shows only their numbers. A note at the top of every page says what they see. |

A 404 is used, not 403, so a limited user cannot tell whether an outside record exists.

## Assigning departments

`PUT /api/v1/users/:id/departments` with `{ "departmentIds": ["…"] }` (permission `ADMIN_USERS`). An empty list lifts the department limit. The departments must exist, be active and belong to the same hospital (400 otherwise); you cannot change your own (409); unexpected fields are rejected. The change is audited as `USER_DEPARTMENTS_CHANGED` with the before and after lists. In the app: Administration → Staff → Access… → *What this person can see*. `GET /users` and `GET /users/:id` list each user's departments, and `GET /auth/me` returns `dataScope` (`ALL`, `DOCTOR` or `DEPARTMENT`, with the department names).

## Permissions and audit

* New permission `DATA_SCOPE_ALL` (granted to the Administrator role by migration `…_user_departments_data_scope`; a hospital's own roles do not get it).
* New audit event `USER_DEPARTMENTS_CHANGED`.
* New table `UserDepartment` (tenant-scoped, row-level security, foreign keys to the user and the department).

## Known limitations (see `docs/backlog.md`)

* Money reports (collections, registrations, cashier shifts, outstanding invoices) and the pharmacy reports stay permission-gated for the finance and pharmacy roles; they are not split by department or doctor, because bills and stock are not owned by a department.
* Bed occupancy is a facility-wide resource view and is not limited.
* The rules limit what a user can **see**. Actions on another doctor's records that already require their own permission and a registered doctor (for example writing a consultation) are unchanged.
* Reading a limited user's data denied by scope is not itself written to the audit trail.
* Documents and patient files, nursing worklists and pharmacy dispensing screens are not yet limited by doctor or department.

## Checked on the demo data (2026-10-31)

Signed in through the API against the seeded hospital (counts only): the administrator and Reception see 1,051 patients, 60 OPD visits in the last 90 days, 10 doctors in the by-doctor report and 14 admissions. doctor7 sees 27 patients, 5 visits, one doctor row and 2 admissions; doctor1 sees 21 patients, 8 visits, one doctor row and 2 admissions. The automated checks are in pps/api/src/common/data-access.spec.ts (13 tests).
