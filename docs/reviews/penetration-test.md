# Penetration-test brief

**Ask:** an independent grey-box test of MedOS before any real patient data is loaded. Engineering's own security testing is described below; it is **not** a penetration test.

## Environment

Test only on a dedicated **staging** deployment with synthetic data, never production. We provide: hospital codes (two or three, for cross-hospital testing), accounts for each role (receptionist, doctor, nurse, pharmacist, cashier, manager, admin), the API route list (`docs/api-routes.md`), the architecture notes (`docs/architecture`) and the repository. Rules of engagement (time window, no denial-of-service against shared infrastructure, no social engineering of staff) are to be agreed in writing.

## Architecture in one paragraph

A Next.js web app (cookie session, server-side proxy `/api/proxy`) in front of a NestJS API under `/api/v1`, with PostgreSQL (row-level security through a restricted `medos_app` login; the hospital id comes from the authenticated session, never from the client), optional ClamAV for uploads, and local-disk file storage (S3 later).

## Controls in place (claims to test)

- **Authentication:** username or email plus password, scrypt hashes, short-lived access token, revocable refresh token (logout revokes), inactive users refused, per-account lockout after repeated failures, login and refresh rate-limited (shared PostgreSQL limiter).
- **Authorization:** permission-based roles enforced on the server for every route; facility scoping; hospital isolation in code and by row-level security; object-ID (IDOR) tests exist per module.
- **Input:** schema validation on every endpoint with unknown fields rejected; idempotency keys on payments and bookings; version checks on clinical and master records.
- **Output:** stable error codes, no stack traces or SQL in responses, `helmet` headers, structured logs without secrets or clinical payloads.
- **Files:** type sniffing, 5 MB limit, virus scan when ClamAV is configured, access-controlled download.
- **Audit:** append-only audit table with request ids.

## Known limits (please try to break them)

- The Docker images, compose stack and CI workflow were written but **never run**. TLS termination, headers behind the reverse proxy, production CORS and secret handling depend on deployment.
- `pnpm audit` shows one moderate advisory in `@nestjs/core`, fixed only by a Nest 11 upgrade.
- The web server's refresh-token single-flight cache is per instance.
- No WAF, no MFA, a basic password policy, and no session-management screen beyond logout. (A per-account lockout after repeated failed sign-ins does exist: `LOGIN_MAX_FAILURES` and `LOGIN_LOCK_SECONDS`; please test it, including lockout abuse against a known username.)
- Row-level security isolates hospitals only; facility isolation is application-level. Three `SECURITY DEFINER` functions need an administrator's review.

## In scope

Authentication and sessions, authorization and hospital isolation (horizontal and vertical), IDOR, business-logic abuse (billing, refunds, discounts, stock, bed allocation, discharge, state transitions), injection (SQL, header, template), file upload, rate limiting, CSRF and cookie flags, CORS, information disclosure, dependency and container review, and the staging infrastructure configuration.

## Out of scope unless agreed

Denial-of-service, physical access, social engineering, third-party providers.

## Engineering self-checks already done (not a substitute)

Automated authorization, IDOR and cross-hospital tests across modules (`*.spec.ts`), row-level-security escalation attempts (24 refused, `rls.paths.spec.ts` and `rls.login.spec.ts`), concurrency and replay tests, and the load test's cross-hospital probe.

## Expected deliverable

Findings with severity (CVSS), proof of exploit, affected endpoints and a recommended fix; a retest after fixes; a statement of coverage and limitations.
