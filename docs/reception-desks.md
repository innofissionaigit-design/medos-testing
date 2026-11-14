# Reception desks: OPD and IPD

## Purpose
Reception does two different jobs: the outpatient desk (OPD) and the inpatient desk (IPD). MedOS keeps them apart so a receptionist sees only the screens, actions and services of the desk they are working at.

## Workflow
1. **Choose a desk after signing in.** A receptionist is asked "Which desk are you working at?" at every sign-in: **OPD** or **IPD**. The choice is kept in that browser tab and forgotten at sign-out; the **Switch** button in the top bar asks again. Only the Receptionist role is asked (and only where inpatient care is switched on); everyone else sees the menu for their role as before.
2. **OPD desk.** Dashboard "OPD reception" with the **Start new visit** button (patient, then department, then doctor), the OPD queue, appointments and video consultations. Billing makes OPD bills. The patient page shows **Start OPD visit** and hides **Admit**.
3. **IPD desk.** Dashboard "IPD reception" (admitted patients, Admissions, Going home) with **no** Start new visit. The menu has Admissions, Going home and Nursing but not Appointments, the OPD queue or Video consultations. Billing makes IPD bills. The patient page shows **Admit** and hides **Start OPD visit**.
4. **The other desk's screens.** Opening one by its address shows a notice ("Appointments belongs to the OPD desk") with a **Switch desk** button.

## Services are OPD, IPD or both
Each service has **Used at**: *OPD only*, *IPD only* or *OPD and IPD* (Administration, Price list). A new service follows its category unless the administrator says otherwise: surgery and other procedures, room and bed, and nursing are IPD; everything else is both. Existing services were set the same way by the migration.

- `GET /services?scope=OPD` gives the OPD price list (OPD and shared services); `scope=IPD` gives the IPD list. Without `scope`, everything.
- **New bill** at the OPD desk offers only OPD services (no Appendectomy, no surgery); at the IPD desk only IPD services.
- The server enforces it: an OPD bill (new, or a draft being edited) refuses an IPD-only service with 400, and an IPD bill refuses an OPD-only one. Pharmacy, registration and "other" bills are not held to a desk.

## Permissions
No new permission. The desk is a working mode, not a security boundary: what a person may do is still decided by their permissions on the server. `ADMIN_MASTERS` changes a service's "Used at".

## Audit events
Changing a service's "Used at" is recorded with the other service changes (`SERVICE_UPDATED`).

## Database
`Service.availableFor` (`OPD`, `IPD`, `BOTH`; default `BOTH`). Migration `20261122090000_service_scope`.

## Known limitations
- The desk choice is not stored on the server; it lives in the browser tab. A second tab asks again.
- Charges added to an admission (ward, room, nursing) are not offered from the OPD price list and are unaffected by this rule; they follow the admission.
- The desk screens are in English; Bengali and Hindi labels are not added yet.
