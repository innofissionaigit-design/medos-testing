# Authentication (sign-in)

## Purpose
How staff sign in to MedOS, what happens when they get it wrong, and how an administrator helps. Patients use a separate sign-in (`docs/patient-app.md`).

## Signing in
A person enters the **hospital code**, their **username or email**, and their **password**. The hospital code and the username or email ignore capital letters and stray spaces (they are stored in lower case). A username belongs to one hospital: the same username at another hospital is a different person. A person who works at several facilities is then asked which one they are at today; the choice is checked against the facilities they may use and never taken on trust.

On success the server issues a short-lived access token (15 minutes) and a rotating refresh token that can be revoked; the web server keeps both in `httpOnly` cookies that page scripts cannot read. Passwords are stored only as Argon2id hashes (an older hash is upgraded at the next successful sign-in).

## Sessions: staying signed in, and being signed out
A sign-in starts a **session**. It is made of a 15-minute access token and a refresh token that the web server uses quietly to get a new access token before the old one runs out, so a person who is working stays signed in. Each refresh gives a new refresh token and the old one stops working (rotation); using an old one again is taken as theft and ends the whole session (`REFRESH_TOKEN_REUSE_DETECTED`). A session ends by itself when its refresh token runs out of time.

**A session ends at once when it is ended.** Every access token carries the id of its session, and on every request the server checks that the session is still alive (it has a refresh token that is unused, not revoked and not expired), as well as that the person, hospital and facility are still active. So these take effect immediately, not when the access token's 15 minutes are up:
- the person signs out (only that device; their other devices stay signed in),
- an administrator **resets their password**, or they **change their own** (every session of theirs ends, including the one that changed it, and they sign in again with the new password),
- they are deactivated, or their hospital or facility is,
- an old refresh token is used again (theft alarm),
- they switch facility (the old session is replaced by a new one for the new facility).
Before this check an old session kept working for up to 15 minutes after a logout or password reset and then signed the person out without warning. A token with no session in it, or naming a session that does not exist, is refused even if its signature is right.

## Setting a password for someone else
Administration → Users → Access… → **Set a new password**. The password is typed twice and can be shown while typing, so a typo cannot silently set a password nobody knows; the button stays off until both match and the password is strong enough (10+ characters with upper case, lower case and a digit). After it is set the person is signed out everywhere and must use the new password, so the administrator has to tell them what it is. The same "show the password" option is on the Add a staff member form. Every reset is audited (`PASSWORD_RESET`, who reset whose); the password itself is never recorded. There is no way to read a password back: if one is lost, set a new one.

## One answer for every wrong detail
A wrong hospital code, an unknown username, a wrong password, a locked account, an inactive person and an inactive hospital all get **exactly the same answer** (`INVALID_CREDENTIALS`, "Invalid credentials", HTTP 401), and take about the same time (the server still checks a dummy password when there is nothing to check against). So the sign-in cannot be used to find out which hospitals, people or locked accounts exist. Every try is audited (`LOGIN_SUCCESS`, `LOGIN_FAILED` with the reason, never the password).

The sign-in screen says "Check the hospital code, your username and your password. After several wrong tries the account is locked for a few minutes; wait and try again, or ask your administrator to unlock it." That hint is shown for any wrong detail, so it does not say whether this account is actually locked. It also warns when Caps Lock is on, and says plainly when the server cannot be reached.

## Lock-out
- **Five wrong passwords** (`LOGIN_MAX_FAILURES`) **in a row, each within 15 minutes** (`LOGIN_FAILURE_WINDOW_SECONDS`) of the one before, lock the account for **15 minutes** (`LOGIN_LOCK_SECONDS`). While locked, even the correct password is refused (with the same generic answer).
- Wrong tries further apart than the window do not add up: the count starts again at 1. A few typos spread over weeks never lock anyone. The check and the increment are one database statement, so several simultaneous wrong tries are each counted exactly once.
- A correct password clears the count. When the lock ends the count starts clean.
- The sign-in endpoint is also rate-limited (see "Rate limits" below).
- **Inactive people cannot sign in**, and deactivating a person ends their existing access token at once. A person can also be refused because their hospital is inactive.

## Rate limits
Limits are counted per minute (a fixed window) and refused with HTTP 429, code `RATE_LIMITED`, and a `Retry-After` header in seconds (the window length: the allowance is back by then at the latest).

| Endpoint | Allowed | Counted per |
|---|---|---|
| `POST /auth/login` | 10 | client address |
| `POST /auth/refresh`, `/auth/logout`, `/auth/switch-facility` | 30 | session (the refresh token, hashed) |
| `POST /users/me/password` | 10 | session |
| `POST /patient-portal/auth/code` | 10 | client address |
| `POST /patient-portal/auth/verify` | 20 | client address |
| `POST /patient-portal/unlock` | 10 | session |

The web server passes the browser's address on (`X-Forwarded-For`), and the API believes that header only from the proxies listed in `TRUST_PROXY` (default: this machine), so a client cannot invent fresh addresses and everybody behind one web server does not share one allowance. Requests that carry an integration API key are limited per key (`API_CLIENT_RATE_LIMIT_PER_MINUTE`) on every route.

The counters live in PostgreSQL (`RATE_LIMIT_STORE=database`, one atomic statement per request, timed by the database clock), so **every API instance shares one allowance**: ten tries spread over two instances still stop at ten. If the database cannot be reached the request is counted in memory on that instance instead (sign-in stays available and still throttled, and the failure is logged). `RATE_LIMIT_STORE=memory` is for a single instance only. Switching the limiter off (`RATE_LIMIT_ENABLED=false`) is refused in production.

Tests: `modules/auth/auth.spec.ts` (exact threshold, `Retry-After`, per address, per session, forged `X-Forwarded-For`, two instances), `common/rate-limit.spec.ts` (the store).

## Unlocking
An administrator (`ADMIN_USERS`) sees a **locked** badge on the staff list (Administration → Users) and an **Unlock** button. Unlocking clears the lock and the count at once; the password is not touched. `POST /users/:id/unlock` returns whether the account really was locked, and is harmless on an account that is not. It is audited as `USER_UNLOCKED` with who unlocked whom. A password reset by an administrator also clears the lock. Another hospital's administrator gets "not found".

## Permissions and audit
`ADMIN_USERS` for unlocking and resetting passwords; sign-in needs none. Audit events: `LOGIN_SUCCESS`, `LOGIN_FAILED` (reason: unknown user, bad password, locked, inactive, no facility), `REFRESH_TOKEN_REUSE_DETECTED`, `FACILITY_SWITCHED`, `USER_UNLOCKED`, `PASSWORD_RESET`, `PASSWORD_CHANGED`, `PASSWORD_HASH_UPGRADED`, `LOGOUT`.

## Database
`User.failedLoginCount`, `lockedUntil` and `lastFailedLoginAt` (the time of the last wrong try) hold the lock-out state. Migration `20261104090000_login_failure_window`.

## Known limitations
No second factor (MFA) and no self-service "forgot password" (an administrator resets it); an attacker who knows a username can still lock that account for 15 minutes with five wrong tries, which the per-address rate limit and the audit trail make visible but do not prevent. See `docs/backlog.md`.

Tests: `modules/auth/auth.spec.ts`.
