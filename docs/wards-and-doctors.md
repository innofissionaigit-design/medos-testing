# Facilities, departments, wards, rooms, beds, doctors and weekly schedules (Administration)

## Purpose
How an administrator (`ADMIN_MASTERS`) sets up the places patients stay in and the doctors who see them, and how those settings change what the rest of MedOS allows. Screens: Administration → **Wards and beds** and **Doctors and departments**.

## Facilities
A hospital (tenant) has one or more facilities; most work happens inside one facility, chosen at sign-in or from the facility menu. Administration → Settings → **Facilities** (needs `ADMIN_SETTINGS`).

- **Add**: a code (capital letters, digits and hyphen, up to 16, unique in the hospital, never changed afterwards because it appears in numbers such as invoice numbers) and a name. The new facility inherits the hospital's time zone and starts empty: switch to it, then add its departments, doctors, wards, prices and staff access. The person who added it can work in it at once.
- **Edit**: name, address, city, district, state, PIN code (6 digits), phone, email and GSTIN (format checked). Leaving a box empty clears it. These are the facility's record; what is **printed** on bills, receipts and prescriptions is the separate "Print header" setting.
- **Switch off / on**: a switched-off facility cannot be signed in to and existing sessions at it end at once. It is refused while any patient is still admitted there (`INVALID_STATE`, 409, with the count), and the facility you are working in cannot be switched off. Nothing is deleted.
- Another hospital's facility is "not found". Audit: `FACILITY_CREATED`, `FACILITY_UPDATED`, `FACILITY_STATUS_CHANGED`.

## Departments
Administration → Doctors and departments → **All departments** (needs `ADMIN_MASTERS`; everyone signed in can read the active ones).

- **Add** with a name and a code (unique in the facility, capital letters, digits, `-`, `_`, never changed). **Rename** on the list.
- **Switch off / on**: refused while any working doctor is in the department (`INVALID_STATE`, 409, with the count; move the doctors or switch them off first). A switched-off department is hidden from everyday lists and cannot get new doctors; the administrator still sees it and can switch it back on. Audit: `DEPARTMENT_CREATED`, `DEPARTMENT_UPDATED`.

## Wards, rooms and beds
Ward → room → bed. A ward, a room and a bed each have a code that is unique in the facility (capital letters, digits, `-` and `_`). A bed has a **daily rate**, a **status** and an **in service / retired** switch.

- **Add**: a ward, then rooms in it, then beds in a room. A bed is placed in a room that is on, in a ward that is on.
- **Edit** (on the same screen, including things that are switched off): rename a ward or room, change a bed's daily rate (audited as `BED_RATE_CHANGED`; stays already in progress keep the rate they started with), switch a ward or room off and on, retire a bed or bring it back. Codes do not change.
- **Bed status** is always explicit: `AVAILABLE`, `OCCUPIED`, `RESERVED`, `CLEANING`, `MAINTENANCE`. People can move a free bed between available, cleaning and maintenance (maintenance needs `ADMIN_MASTERS`; reserved needs `ADMISSION_CREATE`). `OCCUPIED` is only ever set by an admission or a transfer, and an occupied bed's status cannot be changed by hand. Every change is audited (`BED_STATUS_CHANGED`, with the reason).
- **A bed is in service only while the bed, its room and its ward are all on.** Admitting a patient into it, or transferring a patient to it, is refused (`BED_NOT_AVAILABLE`, 409) otherwise, and nothing changes.
- **Switching off** a ward or room is refused while any of its beds is occupied or reserved (`INVALID_STATE`, 409). It keeps the history and does not touch the beds. A bed that is occupied or reserved cannot be retired either.
- **Switching on** goes top down: a room needs its ward on, a bed needs its ward and room on (`INVALID_STATE`, 409, "Switch the ward back on first").
- Switched-off wards, rooms and beds are listed for the administrator (`?includeInactive=true`); everyone else sees only what is on.
- Nothing is deleted. Bed history (who was where and when) is kept and cannot be edited.

Permissions: `ADMIN_MASTERS` for everything above; `ADMISSION_READ` to look. Audit: `WARD_CREATED/UPDATED`, `ROOM_CREATED/UPDATED`, `BED_CREATED/UPDATED/RATE_CHANGED/STATUS_CHANGED`.

## Doctors (practitioners)
A doctor is a record in the facility: name shown on prescriptions, specialty, registration number, department, and optionally the staff login they sign in with. Only a doctor linked to a login can write clinical notes (a permission alone is not enough).

- **Add** and **Edit** on the "All doctors" list. A staff login can be linked to only one doctor in a facility (`CONFLICT`, 409, "This staff login is already a doctor at this facility"); linking another hospital's login, an inactive login or a switched-off department is refused.
- **Switch off / on**: a switched-off doctor disappears from booking lists and cannot be booked or given walk-ins. Nothing already booked is cancelled. The screen says how many booked visits are still waiting for that doctor (the API returns `upcomingBooked`, and the audit event records it), so they can be moved or cancelled from Appointments.
- Audit: `PRACTITIONER_CREATED`, `PRACTITIONER_UPDATED`.

## Weekly schedule
Each doctor has weekly sessions: a day of the week, a start and end time, and a slot length (5 to 120 minutes). Sessions of one day must not overlap; times are in the facility's time zone.

- Saving **replaces** the whole schedule (`PRACTITIONER_SCHEDULE_REPLACED`). The slots shown for booking are built from it, minus what is already booked.
- **A doctor whose schedule was never saved can be booked at any time** (so a new doctor works at once). **Once a schedule has been saved, only its sessions can be booked**, and booking at any other time is refused (`SLOT_UNAVAILABLE`, 409). This includes a schedule saved with **no sessions**: the doctor then cannot be booked at all and offers no slots. (Before this was written down, clearing every session silently made the doctor bookable at any hour; the new `Practitioner.scheduleSet` flag, migration `20261104120000_practitioner_schedule_set`, records that a schedule has been saved. Doctors that already had sessions are marked as having one.)
- The doctor list tells the administrator which doctors still have no saved schedule.
- Changing the schedule never moves or cancels visits already booked. A person with `APPOINTMENT_OVERBOOK` can still book outside the sessions with a reason (audited).

## Known limitations
No leave or holiday calendar for a doctor yet (a day off is a missing session; a one-off day off needs the sessions edited and restored). Nothing warns, when a schedule is saved, about booked visits that now fall outside it.

Tests: `modules/facilities/facilities.spec.ts` (facilities, departments), `modules/ipd/ipd.spec.ts` (masters, bed rules), `modules/appointments/appointments.spec.ts` (schedules, switching a doctor off), `modules/masters/masters.spec.ts`, `common/tenant-sweep.spec.ts` (other hospitals' ids on every route).

## Seeing schedules without editing them

The Appointments page has a read-only card, "Doctors' weekly schedules", for everyone who may read appointments (reception, nurses, doctors, cashier): each doctor with the days, times and slot length, or a note when the doctor has no saved schedule (bookable at any time) or an empty one (not bookable). Only the administrator can change a schedule. When the booking window's patient search finds nobody it offers "Register a new patient", which opens the registration form in a new tab (`/patients?register=1`); the booking is then finished by searching the new patient.
