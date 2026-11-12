# Housekeeping requests

## Purpose
Beside the bed turnover after a discharge (docs/discharge-stages.md), anyone who works in the building can ask housekeeping or maintenance for a job anywhere: a spill in a corridor, a broken tap, waste to collect, fresh linen. Housekeeping sees every request, starts it and marks it done.

## Entities
- **Request**: a job (cleaning, repair or maintenance, waste pick-up, linen, something else), a place (free text, 2 to 120 characters), a priority (routine or urgent), optional details (up to 300 characters), who asked and when, and each later step with who and when.

A request names a place and a job, **never a patient**. Housekeeping sees places and jobs only, as in bed turnover. The screen reminds people not to write a patient's name.

## Workflow and states
`OPEN → IN_PROGRESS → DONE`, or `CANCELLED` from open or in progress.

1. A nurse, receptionist or manager sends a request.
2. Housekeeping starts it, then marks it done (optionally with a note). A request cannot be marked done before it is started.
3. The person who asked can withdraw their own request, and a housekeeping manager can cancel any open one, with a reason (5+ characters). A finished request (done or cancelled) is final.

Housekeeping staff see every request of the facility (urgent first, then oldest). Anyone who may only ask sees their own requests.

## Permissions
`HOUSEKEEPING_REQUEST` (raise requests and see and withdraw your own): Nurse, Receptionist, Manager, Administrator. `HOUSEKEEPING_MANAGE` (see all, start, finish, cancel any): Housekeeping, Manager, Administrator. The existing `BED_HOUSEKEEPING` permission still covers bed turnover. Migration `20261112090000_housekeeping_requests_record_retention` adds both permissions to existing hospitals.

## Audit events
`HOUSEKEEPING_REQUESTED`, `HOUSEKEEPING_STARTED`, `HOUSEKEEPING_DONE`, `HOUSEKEEPING_CANCELLED`.

## Database rules
Requests are never deleted. The job, place, priority and requester never change; the status only moves along the path above, each step with who and when (checked by the database).

## API
`GET /housekeeping/requests`, `POST /housekeeping/requests` (`{ kind, location, priority?, description? }`), `POST /housekeeping/requests/:id/start`, `POST /housekeeping/requests/:id/done` (`{ note? }`), `POST /housekeeping/requests/:id/cancel` (`{ reason }`). The screen is the **Housekeeping** page.

## Known limitations
No assignment to a named person, no scheduling or recurring jobs, no photos, and no link to rooms or assets (the place is free text). Tests: `discharge/discharge.spec.ts` ("housekeeping requests").
