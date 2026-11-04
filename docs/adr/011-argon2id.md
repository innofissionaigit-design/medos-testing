# ADR-011: Argon2id for password hashing

**Status:** accepted. Replaces decision 1 of [ADR-009](009-platform-and-session-decisions.md) (scrypt).

## Context

ADR-009 chose scrypt because Argon2 meant a native add-on that might not build or might be blocked in the deployment image, and said to
revisit it "if the deployment image can carry the native module". CLAUDE.md §12 asks for Argon2. Node 22 has no built-in Argon2 (it arrives
in Node 24), and a pure-JavaScript or WebAssembly Argon2 would run on the main thread and pause every request for the length of each hash.

## Decision

Passwords are hashed with **Argon2id** using `@node-rs/argon2` (MIT), which runs on a background thread and ships **prebuilt binaries** for
Windows and for the glibc and musl Linux images, so nothing compiles on install. Hashes use the standard PHC string
(`$argon2id$v=19$m=…,t=…,p=1$salt$hash`), which carries its own parameters. Defaults are the OWASP minimum for Argon2id: 19 MiB of
memory, 2 passes, 1 lane (`ARGON2_MEMORY_KIB`, `ARGON2_PASSES`); production refuses anything weaker. Passwords are NFKC-normalised first, as before.

**Existing accounts are migrated without a reset.** scrypt hashes still verify. After a *correct* password for an *active* account, the
login replaces a scrypt hash (or an Argon2id hash weaker than the configured cost) with a fresh Argon2id hash, writes
`PASSWORD_HASH_UPGRADED` to the audit trail (no secrets in it), and never fails the sign-in because of the upgrade. The write only applies if
the stored hash is still the one that was just checked, so a password changed in the meantime is never overwritten by the old
password's hash. A wrong password, an inactive account or a locked account changes nothing.

A hash that is not well-formed Argon2id is refused before any work is done, and one asking for more than 1 GiB or 10 passes is refused, so a
corrupted row cannot be used to make the server do enormous work.

## Alternatives considered

- **Keep scrypt:** acceptable security, but contradicts CLAUDE.md §12 and the stated plan to move.
- **`argon2` (node-gyp native):** needs a compiler toolchain in the image, the exact risk ADR-009 avoided.
- **`hash-wasm` (WebAssembly):** no native code, but it hashes on the main thread, stalling all requests for around 100–200 ms per sign-in.
- **`crypto.argon2` (Node 24+):** the best long-term answer; this decision can be revisited when the runtime moves to Node 24.

## Consequences

- One new production dependency. If a platform has no prebuilt binary the install fails loudly; that is not expected on the supported ones.
- Unknown-account sign-ins burn an Argon2id verification, while an account still on scrypt takes scrypt's time: until everyone has signed in once,
  a timing difference between "no such user" and "scrypt user" is theoretically measurable. It disappears as accounts migrate.
- Accounts that never sign in again keep a scrypt hash indefinitely; the old verifier stays in the code for them.
- Rolling back to an older release after accounts have migrated would lock those accounts out (the old code cannot read Argon2id). Reset the passwords of
  affected accounts in that case, or keep the new code.
