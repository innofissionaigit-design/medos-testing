# ABDM (Ayushman Bharat Digital Mission): groundwork

## What this is, and what it is not
**Built:**
1. **ABHA number on the chart.** Staff record a patient's ABHA number (14 digits, typed with or without dashes) and optionally the ABHA address (`name@abdm` or `name@sbx`). One live ABHA per patient and one live patient per number (the same number on a second patient is refused and names the other MRN, because it may be the same person). Removing one needs a reason and keeps the row. The patient is found by searching the number while it is live. Everything shows "recorded, not verified".
2. **The facility's gateway connection.** Administration → ABDM: environment (sandbox or production), the gateway session address, client id, client secret (encrypted, write-only, never shown again, never sent to a different address than the one it was entered for), and the Health Facility Registry id. A **Test the connection** button asks the gateway for a session with the saved credentials and keeps only the verdict (the token is discarded). The message never repeats ABDM's reply.

**Not built, on purpose:**
- Verifying an ABHA with ABDM (OTP flows, encrypted payloads).
- Creating an ABHA.
- Linking visits (care contexts) to an ABHA.
- Consent requests and sharing of health records (as provider or as requester), and the FHIR records that go with them.
- The gateway's callback endpoints.

These need ABDM sandbox credentials (a bridge or client id and secret from ABDM, a registered facility) and ABDM's current specifications, which change between versions. I could not test any of them, and a version that only passes against my own stand-in would give a false sense of safety. The screen lists each of them as "not built yet".

## What you need from ABDM to continue
1. Sandbox client id and client secret for the hospital (issued by ABDM to the registered email).
2. The facility registered in the Health Facility Registry (HFR id), with its callback address registered.
3. The current gateway documentation for the version to be used, so the session address and request shapes can be taken from it, not guessed.
4. A decision on which flows come first: verifying an ABHA at registration, then linking visits, then consent and sharing.

## Setting it up for testing
Administration → ABDM. Choose Sandbox, paste the gateway session address from ABDM's current documentation, enter the client id and secret, save, then press Test. The address must be https (plain http to this computer is accepted only in a test setup). Switching the environment to production is a separate, deliberate save and forgets the last test.

## Permissions and audit
Connection: `ADMIN_SETTINGS`. ABHA on the chart: `PATIENT_READ` to see, `PATIENT_UPDATE` to record or remove. Audit events: `ABDM_CONFIG_SAVED`, `ABDM_CONFIG_TESTED`, `ABDM_CONFIG_DISCONNECTED`, `ABHA_RECORDED`, `ABHA_REMOVED`.

## Database rules
An ABHA record is never deleted or rewritten; removing one sets who, when and why; a removed one stays removed. The number must be 14 digits and the address must look like an ABHA address. Row-level security covers both tables.

## API
`GET/PUT/DELETE /abdm/config`, `POST /abdm/config/test`, `GET/POST /patients/:id/abha`, `POST /patients/:id/abha/:linkId/remove`.

## Known limitations
No check that the number is a real ABHA; no ABHA on the patient app or on printed documents; ABHA recorded on a patient who is later merged is not carried over; the gateway credentials are per facility and the production switch has no extra approval step yet. See `docs/backlog.md`.
