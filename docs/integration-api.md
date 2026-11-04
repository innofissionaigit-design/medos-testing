# Integration API: booking from another system or a voice bot

Everything a person can book on the Appointments screen can be done by an outside system or a voice bot through the API, with its own key, its own limited abilities and its own audit trail. A machine-readable description is in [`openapi/booking.json`](openapi/booking.json) (OpenAPI 3.0; import it into Postman, a bot platform or a code generator).

## 1. Get a key

An administrator (permission `ADMIN_INTEGRATIONS`) opens **Administration → Integrations**, names the integration (for example "Voice bot"), ticks what it may do, optionally sets an expiry, and clicks **Create integration and key**. The key looks like `mdk_…` and is **shown once**: only its SHA-256 hash is stored, so a lost key cannot be recovered. Revoke it and create a new one (**Revoke…** stops it immediately; a revoked key cannot be reactivated).

Each integration is bound to **one facility** (the one the administrator is working in) and acts as a hidden service user (never listed among staff, never able to sign in with a password). The audit trail names it: every booking it makes records the integration as the actor.

Abilities (the whole menu; nothing financial, clinical or administrative can be granted):

| Ability | Lets it |
|---|---|
| *(always)* | read doctors, free times, the booking-fee settings, and the appointments **it made** |
| `FIND_PATIENTS` | find a patient by mobile number: first name, last initial, gender, age, MRN only |
| `REGISTER_PATIENTS` | register a new patient (name, gender, age or date of birth, mobile) |
| `BOOK_APPOINTMENTS` | book, move (postpone / prepone) and cancel **its own** appointments |

## 2. Call the API

Base URL `…/api/v1`. Send the key on every request: `Authorization: Bearer mdk_…`. Responses are `{ "data": … }`; errors are `{ "error": { "code", "message", "details?", "requestId" } }`.

| Step | Call |
|---|---|
| 1. Doctors and next free times | `GET /booking/doctors?date=YYYY-MM-DD&departmentId=…&slots=5` |
| 1b. Every slot of one doctor | `GET /practitioners/{id}/availability?date=YYYY-MM-DD` |
| 2. Who is calling? | `GET /booking/patients?mobile=9830012345` |
| 2b. New caller | `POST /booking/patients` `{ firstName, lastName?, gender, mobile, dateOfBirth \| estimatedAgeYears }` |
| 3. Book | `POST /appointments` `{ patientId, practitionerId, startAt }` |
| 4. Check | `GET /appointments/{id}` |
| 5. Postpone / prepone | `PATCH /appointments/{id}` `{ version, startAt }` |
| 6. Cancel | `POST /appointments/{id}/cancel` `{ reason }` |
| Booking fee and payment-link settings | `GET /booking-fee/config` |

```bash
KEY=mdk_...            # from Administration → Integrations
API=http://localhost:4000/api/v1

curl -s "$API/booking/doctors?slots=3" -H "Authorization: Bearer $KEY"
curl -s "$API/booking/patients?mobile=9830012345" -H "Authorization: Bearer $KEY"
curl -s -X POST "$API/appointments" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
     -H "Idempotency-Key: call-8841-book" \
     -d '{"patientId":"<id>","practitionerId":"<doctor id>","startAt":"2026-11-02T04:30:00.000Z"}'
```

### Safe retries (Idempotency-Key)
Voice and network calls time out. Send an `Idempotency-Key` (8–64 characters of letters, digits, `-`, `_`) on `POST /appointments` and `POST /booking/patients`: a retry with the same key and the same request returns the **first result** (HTTP 200, header `Idempotent-Replayed: true`) and never books or registers twice; the same key with a different request is refused (`422 IDEMPOTENCY_KEY_REUSED`). Without a key the call still works, but a retry is only caught by the duplicate-booking rule below.

### Postpone and prepone
`PATCH /appointments/{id}` with the current `version` and a new `startAt` (and optionally another `practitionerId`). Only a `BOOKED` appointment can be moved, never to a time that has already passed (`400`), and the same duplicate rules apply.

## 3. Rules the API enforces

- **Duplicate bookings:** the same patient, or a look-alike registered with another mobile number, cannot hold two live bookings with the same doctor, or with two doctors of the same department on the same day (`409 DUPLICATE_BOOKING_SUSPECTED`, see `duplicate-booking.md`). A key **cannot** override this: the front desk can.
- **Duplicate patients:** registering someone who already exists returns `409 DUPLICATE_PATIENT_SUSPECTED` with `details.matches` as minimal details; use that patient. A key cannot override this either.
- **Booking fee:** when the hospital charges one, the booking response has `bookingFee`, `feeStatus: "PENDING"` and `feeDue`; the patient cannot be checked in until it is paid or skipped at the desk. When the payment link is enabled, `paymentLink.dueBy` is the deadline after which an unpaid booking cancels itself (`booking-payment-link.md`; delivery is a placeholder today).
- **Cancelling** a booking whose fee was paid follows the cancellation policy (`booking-fee.md`).
- **Only its own bookings:** a key sees and changes only the appointments it made. Another key's or a staff member's appointment is `404`. A key can never read patient records, bills, users, settings or reports.
- **One hospital:** a key works only in the hospital and facility it was created in.
- **Rate limit:** 120 requests per minute per key by default (`API_CLIENT_RATE_LIMIT_PER_MINUTE`); beyond it `429`.
- **Privacy:** lookups return the minimum needed to confirm identity (first name, last initial, gender, age, MRN); never an address, a date of birth or a mobile number. Do not log full phone numbers or tokens on your side.

## 4. Errors worth handling

| HTTP | Code | Meaning / what to do |
|---|---|---|
| 401 | `UNAUTHENTICATED` | key missing, wrong, expired or revoked |
| 403 | `FORBIDDEN` | the key was not given that ability |
| 400 | `VALIDATION_FAILED` | bad field; `details` lists them; moving to a past time |
| 409 | `SLOT_UNAVAILABLE` | the time was just taken: fetch free times again |
| 409 | `DUPLICATE_BOOKING_SUSPECTED` | already booked: offer the existing booking |
| 409 | `DUPLICATE_PATIENT_SUSPECTED` | already registered: use `details.matches` |
| 409 | `STALE_VERSION` | the appointment changed: GET it again, then retry |
| 422 | `IDEMPOTENCY_KEY_REUSED` | a different request with the same key |
| 429 | `RATE_LIMITED` | slow down and retry shortly |

## 5. Security notes for administrators

Keep keys secret like passwords and give each system its own key, so one can be revoked alone. Prefer an expiry and rotate: create the new integration, switch the system over, revoke the old one. Keys travel in the `Authorization` header, so use HTTPS in production (`deployment.md`). Creating and revoking keys is audited (`API_CLIENT_CREATED`, `API_CLIENT_REVOKED`); neither the key nor its hash is ever written to the audit trail or the logs.

## 6. Where a key may be used from

Each key can be limited to certain addresses (Administration → Integrations → **Addresses…**, or when the key is created): single IPv4 or IPv6 addresses or CIDR ranges such as `203.0.113.0/24`. From any other address the key is refused with the same `401` as any bad key (the server log records why), even though the key is correct. An empty list means from anywhere. Changing the list is audited (`API_CLIENT_IPS_CHANGED`). When the server sits behind a proxy, set `TRUST_PROXY` so the real caller's address is the one checked.

## 7. Webhooks

A key that books appointments can be told when one of **its own** appointments is booked, moved or cancelled, whoever did it (the key, or hospital staff). Administration → Integrations → **Webhook…** (permission `ADMIN_INTEGRATIONS`): the address to send to, which events (`appointment.booked`, `appointment.moved`, `appointment.cancelled`), switch off, **Send a test**, **New secret**.

* **The message** is a `POST` of JSON `{ id, event, occurredAt, appointment: { id, status, startAt, endAt, practitionerId, version, cancelReason? } }`: identifiers, times and the status only, **never patient details**. Fetch the appointment with `GET /appointments/{id}` for the rest.
* **Signature.** The secret (`whsec_…`) is shown **once** when the webhook is created or replaced and is kept only encrypted (needs `SECRETS_ENCRYPTION_KEY`). Each request carries `X-MedOS-Event`, `X-MedOS-Delivery` (the message id) and `X-MedOS-Signature: t=<unix seconds>,v1=<hex>`, where `v1` is the HMAC-SHA256, keyed with the secret, of `<t>.<raw body>`. Check it, and reject a timestamp older than a few minutes.
* **Delivery.** The event is queued in the same transaction as the change, so a change is never lost and nothing is announced for something that rolled back. A 2xx answer within 8 seconds is delivery; anything else is retried after 1, 5, 30, 120 and 720 minutes, and then given up (shown in the list with a **Retry** button). Redirects are not followed. Make your receiver idempotent: the same `X-MedOS-Delivery` id can arrive twice after a timeout.
* **Where it may point.** In production the address must be a public `https://` address (never localhost, a private or link-local address, or a name that resolves to one, checked on every call). Development also allows local addresses.
* Audit events: `WEBHOOK_CREATED`, `WEBHOOK_UPDATED`, `WEBHOOK_SECRET_ROTATED`, `WEBHOOK_TESTED`, `WEBHOOK_DELIVERY_RETRIED` (host and events, never the secret).

## 8. Known limitations

- Webhooks cover booked, moved and cancelled only (check-in and no-show are in `docs/backlog.md`); one webhook address per key.
- The payment link, and a payment confirmation callback from a payment provider, are placeholders (`booking-payment-link.md`).
- One facility per key; a system serving two facilities needs two keys.

Tests: `modules/integrations/integrations.spec.ts` and `webhooks.spec.ts`.
