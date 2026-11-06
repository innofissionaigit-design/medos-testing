# ADR-012: Live notifications over server-sent events, with the database as the source of truth

**Status:** Accepted.

## Context
Staff screens refreshed by polling every 15 to 20 seconds. Several events need attention sooner (a critical lab result, a patient in the queue, a prescription at the pharmacy). The system has no Redis (ADR-009), may run several API servers, and must keep tenant isolation (ADR-010).

## Decision
1. **The table is the truth.** A `Notification` row is written in the same transaction as the event. The live channel only tells an open browser to fetch.
2. **Server-sent events** (one-way, plain HTTP, works through the existing same-origin proxy and cookies), with the browser falling back to polling every 20 seconds if the stream is down.
3. **The stream looks at the caller's own notifications every 3 seconds, inside the request.** No new database driver, no extra connection, no cross-tenant access, and the same behaviour behind several servers.
4. **No patient data in a notification.** A type and a pointer; the screen it opens enforces permissions.

## Alternatives considered
* **PostgreSQL LISTEN/NOTIFY**: instant, but needs a long-lived connection per API server and a new database driver (`pg`) the project does not use, and a listener that crosses tenants under row-level security.
* **WebSockets**: two-way is not needed, and the Next.js route proxy does not carry them.
* **Redis pub/sub**: a new service to run, secure and back up (ADR-009).
* **Polling only**: simple, but slow and heavier at scale.

## Consequences
* A change appears within about 3 seconds, not instantly.
* Each open stream makes two small queries every 3 seconds; with a hundred staff that is a few queries a second. Revisit with LISTEN/NOTIFY or Redis if a hospital outgrows this.
* A stream ends after 10 minutes so an expired session or a switched-off login cannot keep one open.
