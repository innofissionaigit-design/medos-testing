import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import * as jwt from "jsonwebtoken";
import { randomBytes, randomUUID, scrypt } from "node:crypto";
import { tenantScope } from "../../common/tenant-scope";
import { PASSWORD, startApp, type TestApp, type TestTenant } from "../../test/harness";
import { AuthService } from "./auth.service";

/** A password hash in the format used before Argon2id. */
const legacyHash = (password: string): Promise<string> => new Promise((resolve, reject) => {
  const N = 1024;
  const salt = randomBytes(16);
  scrypt(password.normalize("NFKC"), salt, 32, { N, r: 8, p: 1, maxmem: 256 * N * 8 }, (e, key) => (e ? reject(e) : resolve(["scrypt", N, 8, 1, salt.toString("base64"), key.toString("base64")].join("$"))));
});

describe("password hash upgrade at sign-in", () => {
  let t: TestApp;
  let tenant: TestTenant;
  before(async () => { t = await startApp(); tenant = await t.makeTenant("hashup"); });
  after(async () => { await t.close(); });

  const hashOf = async (id: string) => (await t.prisma.user.findFirstOrThrow({ where: { id, tenantId: tenant.tenantId } })).passwordHash;
  const upgradeEvents = (id: string) => t.prisma.auditEvent.findMany({ where: { tenantId: tenant.tenantId, action: "PASSWORD_HASH_UPGRADED", entityId: id } });

  it("an account with an old-format hash signs in, and its hash is replaced with Argon2id", async () => {
    const u = await t.makeUser(tenant, ["RECEPTIONIST"]);
    const old = await legacyHash(PASSWORD);
    await t.prisma.user.update({ where: { tenantId_id: { tenantId: tenant.tenantId, id: u.id } }, data: { passwordHash: old } });

    const first = await t.login(tenant.code, u.username);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const upgraded = await hashOf(u.id);
    assert.notEqual(upgraded, old);
    assert.match(upgraded, /^\$argon2id\$/);
    assert.ok(!upgraded.includes(PASSWORD));

    assert.equal((await t.login(tenant.code, u.username)).status, 200, "the new hash works");
    assert.equal(await hashOf(u.id), upgraded, "and is not replaced again");
    const events = await upgradeEvents(u.id);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.actorUserId, u.id);
    assert.deepEqual(events[0]!.metadata, { from: "scrypt", to: "argon2id" });
  });

  it("a wrong password is refused and leaves the old hash untouched", async () => {
    const u = await t.makeUser(tenant, ["RECEPTIONIST"]);
    const old = await legacyHash(PASSWORD);
    await t.prisma.user.update({ where: { tenantId_id: { tenantId: tenant.tenantId, id: u.id } }, data: { passwordHash: old } });
    const bad = await t.login(tenant.code, u.username, "Not-The-Password-1");
    assert.equal(bad.status, 401);
    assert.equal(await hashOf(u.id), old);
    assert.equal((await upgradeEvents(u.id)).length, 0);
  });

  it("an inactive account is refused and not upgraded", async () => {
    const u = await t.makeUser(tenant, ["RECEPTIONIST"]);
    const old = await legacyHash(PASSWORD);
    await t.prisma.user.update({ where: { tenantId_id: { tenantId: tenant.tenantId, id: u.id } }, data: { passwordHash: old, status: "INACTIVE" } });
    assert.equal((await t.login(tenant.code, u.username)).status, 401);
    assert.equal(await hashOf(u.id), old);
  });

  it("an account whose Argon2id hash is weaker than the current setting is strengthened", async () => {
    const u = await t.makeUser(tenant, ["RECEPTIONIST"]);
    const original = await hashOf(u.id);
    const { hash } = await import("@node-rs/argon2");
    const weak = await hash(PASSWORD, { algorithm: 2, memoryCost: 8, timeCost: 1, parallelism: 1 }); // 2 = Argon2id
    assert.notEqual(weak, original);
    await t.prisma.user.update({ where: { tenantId_id: { tenantId: tenant.tenantId, id: u.id } }, data: { passwordHash: weak } });
    assert.equal((await t.login(tenant.code, u.username)).status, 200);
    const now = await hashOf(u.id);
    assert.notEqual(now, weak);
    assert.match(now, /\$m=1024,t=1,p=1\$/, "rebuilt with the configured cost");
    assert.deepEqual((await upgradeEvents(u.id))[0]!.metadata, { from: "argon2id-weaker", to: "argon2id" });
  });

  it("a password changed while the sign-in was in progress is never overwritten by the old password's hash", async () => {
    const u = await t.makeUser(tenant, ["RECEPTIONIST"]);
    const old = await legacyHash(PASSWORD);
    await t.prisma.user.update({ where: { tenantId_id: { tenantId: tenant.tenantId, id: u.id } }, data: { passwordHash: old } });
    // The sign-in read `old`; before it could write its upgrade, the user changed their password.
    const changed = await t.app.get(AuthService)["passwords"].hash("Brand-New-Password-7");
    await t.prisma.user.update({ where: { tenantId_id: { tenantId: tenant.tenantId, id: u.id } }, data: { passwordHash: changed } });
    const auth = t.app.get(AuthService) as unknown as { upgradeHash: (a: unknown, id: string, tid: string, current: string, pw: string) => Promise<void> };
    await tenantScope.run(tenant.tenantId, () => auth.upgradeHash({ tenantId: tenant.tenantId, userId: u.id, requestId: undefined }, u.id, tenant.tenantId, old, PASSWORD));
    assert.equal(await hashOf(u.id), changed, "the newer password stands");
    assert.equal((await upgradeEvents(u.id)).length, 0);
    assert.equal((await t.login(tenant.code, u.username, "Brand-New-Password-7")).status, 200);
    assert.equal((await t.login(tenant.code, u.username, PASSWORD)).status, 401);
  });
});

describe("authentication", () => {
  let t: TestApp;
  let tenant: TestTenant;

  before(async () => {
    t = await startApp();
    tenant = await t.makeTenant("auth");
  });
  after(async () => { await t.close(); });

  it("logs in with valid credentials and returns a token pair; me reflects server-derived context", async () => {
    const r = await t.login(tenant.code, "admin", PASSWORD, tenant.facilityId);
    assert.equal(r.status, 200);
    assert.equal(r.body.data.status, "AUTHENTICATED");
    assert.ok(r.body.data.tokens.accessToken);
    assert.ok(r.body.data.tokens.refreshToken);
    const me = await t.api("get", "/auth/me", r.body.data.tokens.accessToken);
    assert.equal(me.status, 200);
    assert.equal(me.body.data.tenant.id, tenant.tenantId);
    assert.equal(me.body.data.facility.id, tenant.facilityId);
    assert.ok(me.body.data.permissions.includes("ADMIN_USERS"));
  });

  it("stores only a hash of the password and refresh token", async () => {
    const u = await t.prisma.user.findFirstOrThrow({ where: { tenantId: tenant.tenantId, username: "admin" } });
    assert.match(u.passwordHash, /^\$argon2id\$v=19\$m=\d+,t=\d+,p=1\$/);
    assert.ok(!u.passwordHash.includes(PASSWORD));
    const login = await t.login(tenant.code, "admin", PASSWORD, tenant.facilityId);
    const rt = login.body.data.tokens.refreshToken as string;
    const rows = await t.prisma.refreshToken.findMany({ where: { tenantId: tenant.tenantId } });
    assert.ok(rows.every((x) => x.tokenHash !== rt));
  });

  it("returns an identical generic error for unknown tenant, unknown user and wrong password", async () => {
    const a = await t.login("no-such-tenant", "admin");
    const b = await t.login(tenant.code, "nobody");
    const c = await t.login(tenant.code, "admin", "Wrong-Password-1");
    for (const r of [a, b, c]) {
      assert.equal(r.status, 401);
      assert.equal(r.body.error.code, "INVALID_CREDENTIALS");
    }
    assert.equal(a.body.error.message, b.body.error.message);
    assert.equal(b.body.error.message, c.body.error.message);
  });

  it("rejects malformed login input with a validation error and unknown fields", async () => {
    const r = await t.http().post("/api/v1/auth/login").send({ tenantCode: tenant.code, identifier: "admin", password: PASSWORD, role: "ADMIN" });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, "VALIDATION_FAILED");
    const r2 = await t.http().post("/api/v1/auth/login").send({ tenantCode: tenant.code });
    assert.equal(r2.status, 400);
  });

  it("rejects inactive users at login and invalidates their existing access token immediately", async () => {
    const u = await t.makeUser(tenant, ["RECEPTIONIST"]);
    assert.equal((await t.api("get", "/auth/me", u.token)).status, 200);
    const off = await t.api("patch", `/users/${u.id}`, tenant.admin.token).send({ status: "INACTIVE" });
    assert.equal(off.status, 200);
    assert.equal((await t.api("get", "/auth/me", u.token)).status, 401);
    const r = await t.login(tenant.code, u.username);
    assert.equal(r.status, 401);
    assert.equal(r.body.error.code, "INVALID_CREDENTIALS");
  });

  it("rejects users of an inactive tenant", async () => {
    const t2 = await t.makeTenant("inact");
    await t.prisma.tenant.update({ where: { id: t2.tenantId }, data: { status: "INACTIVE" } });
    assert.equal((await t.api("get", "/auth/me", t2.admin.token)).status, 401);
    assert.equal((await t.login(t2.code, "admin")).status, 401);
  });

  it("locks the account after repeated failures, even for the correct password", async () => {
    const u = await t.makeUser(tenant, ["RECEPTIONIST"]);
    for (let i = 0; i < 5; i++) assert.equal((await t.login(tenant.code, u.username, "Bad-Password-9")).status, 401);
    const locked = await t.login(tenant.code, u.username, PASSWORD);
    assert.equal(locked.status, 401);
    const row = await t.prisma.user.findFirstOrThrow({ where: { id: u.id } });
    assert.ok(row.lockedUntil && row.lockedUntil > new Date());
  });

  it("a locked account gets exactly the same answer as a wrong password, so nobody can tell which accounts exist or are locked", async () => {
    const u = await t.makeUser(tenant, ["RECEPTIONIST"]);
    const wrong = await t.login(tenant.code, u.username, "Bad-Password-9");
    for (let i = 0; i < 4; i++) await t.login(tenant.code, u.username, "Bad-Password-9");
    const locked = await t.login(tenant.code, u.username, PASSWORD);
    const unknown = await t.login(tenant.code, `nobody.${u.username}`, "Bad-Password-9");
    for (const r of [locked, unknown]) assert.deepEqual([r.status, r.body.error.code, r.body.error.message], [wrong.status, wrong.body.error.code, wrong.body.error.message]);
  });

  it("the hospital code and the username or email ignore capital letters and stray spaces; a username belongs to its own hospital only", async () => {
    const u = await t.makeUser(tenant, ["RECEPTIONIST"]);
    const ok = await t.login(` ${tenant.code.toUpperCase()} `, ` ${u.username.toUpperCase()} `, PASSWORD);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const other = await t.makeTenant("auth-other");
    assert.equal((await t.login(other.code, u.username, PASSWORD)).status, 401, "this username does not exist at the other hospital");
  });

  it("wrong passwords add up to a lock only when they are close together; typos spread over time never lock anyone", async () => {
    const u = await t.makeUser(tenant, ["RECEPTIONIST"]);
    const age = (minutes: number) => t.prisma.user.update({ where: { id: u.id }, data: { lastFailedLoginAt: new Date(Date.now() - minutes * 60_000) } });
    const row = () => t.prisma.user.findFirstOrThrow({ where: { id: u.id } });
    for (let i = 0; i < 4; i++) await t.login(tenant.code, u.username, "Bad-Password-9");
    assert.deepEqual([(await row()).failedLoginCount, (await row()).lockedUntil], [4, null]);
    await age(20); // the last wrong try was twenty minutes ago: those four no longer count
    await t.login(tenant.code, u.username, "Bad-Password-9");
    const after = await row();
    assert.deepEqual([after.failedLoginCount, after.lockedUntil], [1, null], "the count starts again");
    for (let i = 0; i < 3; i++) await t.login(tenant.code, u.username, "Bad-Password-9");
    await age(20);
    await t.login(tenant.code, u.username, "Bad-Password-9");
    assert.equal((await row()).lockedUntil, null, "still not locked: never five in a row within the window");
    assert.equal((await t.login(tenant.code, u.username, PASSWORD)).status, 200, "the right password still works");
    const ok = await row();
    assert.deepEqual([ok.failedLoginCount, ok.lockedUntil, ok.lastFailedLoginAt], [0, null, null], "a good sign-in clears the count");
  });

  it("five wrong tries in a row within the window do lock, and simultaneous wrong tries are each counted once", async () => {
    const u = await t.makeUser(tenant, ["RECEPTIONIST"]);
    await Promise.all([1, 2, 3, 4].map(() => t.login(tenant.code, u.username, "Bad-Password-9")));
    assert.equal((await t.prisma.user.findFirstOrThrow({ where: { id: u.id } })).failedLoginCount, 4, "four at once make four, not fewer");
    await t.login(tenant.code, u.username, "Bad-Password-9");
    const row = await t.prisma.user.findFirstOrThrow({ where: { id: u.id } });
    assert.ok(row.lockedUntil && row.lockedUntil > new Date(Date.now() + 10 * 60_000), "locked for about fifteen minutes");
    assert.equal(row.failedLoginCount, 0, "and the count starts clean when the lock ends");
    assert.equal(await t.prisma.auditEvent.count({ where: { tenantId: tenant.tenantId, entityId: u.id, action: "LOGIN_FAILED" } }), 5);
  });

  it("an administrator can unlock a locked account at once; nobody else can, and the unlock is audited", async () => {
    const u = await t.makeUser(tenant, ["RECEPTIONIST"]);
    const other = await t.makeUser(tenant, ["RECEPTIONIST"]);
    for (let i = 0; i < 5; i++) await t.login(tenant.code, u.username, "Bad-Password-9");
    assert.equal((await t.login(tenant.code, u.username, PASSWORD)).status, 401, "locked");
    const listed = async () => ((await t.api("get", "/users?pageSize=100", tenant.admin.token)).body.data as { id: string; locked: boolean }[]).find((x) => x.id === u.id)!;
    assert.equal((await listed()).locked, true, "the staff list says so");

    assert.equal((await t.api("post", `/users/${u.id}/unlock`, other.token)).status, 403, "reception cannot unlock");
    assert.equal((await t.api("post", `/users/${u.id}/unlock`).send({})).status, 401);
    const foreign = await t.makeTenant("auth-foreign");
    assert.equal((await t.api("post", `/users/${u.id}/unlock`, foreign.admin.token)).status, 404, "another hospital's administrator cannot reach this user");
    assert.equal((await t.api("post", `/users/${randomUUID()}/unlock`, tenant.admin.token)).status, 404);

    const done = await t.api("post", `/users/${u.id}/unlock`, tenant.admin.token);
    assert.deepEqual([done.status, done.body.data.unlocked, done.body.data.wasLocked], [200, true, true], JSON.stringify(done.body));
    assert.equal((await listed()).locked, false);
    assert.equal((await t.login(tenant.code, u.username, PASSWORD)).status, 200, "back in straight away, with the same password");
    const ev = await t.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: tenant.tenantId, action: "USER_UNLOCKED", entityId: u.id } });
    assert.deepEqual([ev.actorUserId, (ev.metadata as { wasLocked: boolean }).wasLocked], [tenant.admin.id, true]);
    const again = await t.api("post", `/users/${u.id}/unlock`, tenant.admin.token);
    assert.deepEqual([again.status, again.body.data.wasLocked], [200, false], "unlocking someone who is not locked is harmless and says so");
  });

  it("requires facility selection when the user has several facilities, and never trusts a foreign facility id", async () => {
    const r = await t.login(tenant.code, "admin");
    assert.equal(r.status, 200);
    assert.equal(r.body.data.status, "FACILITY_SELECTION_REQUIRED");
    assert.equal(r.body.data.facilities.length, 2);
    assert.equal(r.body.data.tokens, undefined);

    const other = await t.makeTenant("other");
    const foreign = await t.login(tenant.code, "admin", PASSWORD, other.facilityId);
    assert.equal(foreign.status, 403);
    assert.equal(foreign.body.error.code, "UNAUTHORIZED_FACILITY");
  });

  describe("a session ends when it is ended, not minutes later", () => {
    const session = async (username: string, password = PASSWORD) => {
      const r = await t.login(tenant.code, username, password);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return r.body.data.tokens as { accessToken: string; refreshToken: string };
    };
    const works = async (accessToken: string) => (await t.api("get", "/auth/me", accessToken)).status === 200;
    const gone = async (accessToken: string) => { const r = await t.api("get", "/auth/me", accessToken); return [r.status, r.body.error?.code]; };

    it("signing out ends the session at once; the access token does not keep working for its remaining minutes", async () => {
      const u = await t.makeUser(tenant, ["RECEPTIONIST"]);
      const s = await session(u.username);
      assert.equal(await works(s.accessToken), true);
      assert.equal((await t.http().post("/api/v1/auth/logout").send({ refreshToken: s.refreshToken })).status, 204);
      assert.deepEqual(await gone(s.accessToken), [401, "UNAUTHENTICATED"]);
    });

    it("an administrator's password reset signs the person out everywhere at once, and the new password works", async () => {
      const u = await t.makeUser(tenant, ["RECEPTIONIST"]);
      const phone = await session(u.username);
      const desk = await session(u.username);
      assert.deepEqual([await works(phone.accessToken), await works(desk.accessToken)], [true, true]);
      const reset = await t.api("post", `/users/${u.id}/reset-password`, tenant.admin.token).send({ password: "Brand-New-Pass-77" });
      assert.equal(reset.status, 204, JSON.stringify(reset.body));
      assert.deepEqual([(await gone(phone.accessToken))[0], (await gone(desk.accessToken))[0]], [401, 401], "both sessions end now, not in up to fifteen minutes");
      assert.equal((await t.http().post("/api/v1/auth/refresh").send({ refreshToken: phone.refreshToken })).status, 401);
      assert.equal((await t.login(tenant.code, u.username, PASSWORD)).status, 401, "the old password no longer works");
      const again = await session(u.username, "Brand-New-Pass-77");
      assert.equal(await works(again.accessToken), true);
    });

    it("changing your own password ends every session of yours at once, including this one", async () => {
      const u = await t.makeUser(tenant, ["RECEPTIONIST"]);
      const here = await session(u.username);
      const elsewhere = await session(u.username);
      const r = await t.api("post", "/users/me/password", here.accessToken).send({ currentPassword: PASSWORD, newPassword: "Another-Pass-4242" });
      assert.equal(r.status, 204, JSON.stringify(r.body));
      assert.deepEqual([(await gone(here.accessToken))[0], (await gone(elsewhere.accessToken))[0]], [401, 401]);
      assert.equal((await t.login(tenant.code, u.username, "Another-Pass-4242")).status, 200);
    });

    it("signing out one device leaves the person's other sessions alone", async () => {
      const u = await t.makeUser(tenant, ["RECEPTIONIST"]);
      const a1 = await session(u.username);
      const b1 = await session(u.username);
      await t.http().post("/api/v1/auth/logout").send({ refreshToken: a1.refreshToken });
      assert.deepEqual([await works(a1.accessToken), await works(b1.accessToken)], [false, true]);
    });

    it("refreshing keeps the session alive: the new tokens work, and so does the access token from before until it runs out", async () => {
      const u = await t.makeUser(tenant, ["RECEPTIONIST"]);
      const s = await session(u.username);
      const next = await t.http().post("/api/v1/auth/refresh").send({ refreshToken: s.refreshToken });
      assert.equal(next.status, 200, JSON.stringify(next.body));
      assert.deepEqual([await works(next.body.data.accessToken), await works(s.accessToken)], [true, true]);
      assert.equal(jwt.decode(next.body.data.accessToken) && (jwt.decode(next.body.data.accessToken) as jwt.JwtPayload)["sid"], (jwt.decode(s.accessToken) as jwt.JwtPayload)["sid"], "the same session");
      const third = await t.http().post("/api/v1/auth/refresh").send({ refreshToken: next.body.data.refreshToken });
      assert.equal(third.status, 200);
      assert.equal(await works(third.body.data.accessToken), true);
    });

    it("using an old refresh token again ends the whole session at once, including its access tokens", async () => {
      const u = await t.makeUser(tenant, ["RECEPTIONIST"]);
      const s = await session(u.username);
      const next = await t.http().post("/api/v1/auth/refresh").send({ refreshToken: s.refreshToken });
      assert.equal(next.status, 200);
      assert.equal((await t.http().post("/api/v1/auth/refresh").send({ refreshToken: s.refreshToken })).status, 401, "the used token is a sign of theft");
      assert.deepEqual([(await gone(next.body.data.accessToken))[0], (await gone(s.accessToken))[0]], [401, 401]);
      assert.equal(await t.prisma.auditEvent.count({ where: { tenantId: tenant.tenantId, action: "REFRESH_TOKEN_REUSE_DETECTED", entityId: u.id } }), 1);
    });

    it("a session that has run out ends, and a token with no session in it is refused", async () => {
      const u = await t.makeUser(tenant, ["RECEPTIONIST"]);
      const s = await session(u.username);
      const claims = jwt.decode(s.accessToken) as jwt.JwtPayload;
      const secret = process.env["JWT_ACCESS_SECRET"] as string;
      const noSession = jwt.sign({ typ: "access", tid: claims["tid"], fid: claims["fid"] }, secret, { subject: claims.sub, expiresIn: 60 });
      const madeUp = jwt.sign({ typ: "access", tid: claims["tid"], fid: claims["fid"], sid: randomUUID() }, secret, { subject: claims.sub, expiresIn: 60 });
      assert.deepEqual([(await gone(noSession))[0], (await gone(madeUp))[0]], [401, 401], "signed correctly, but there is no such session");
      assert.equal(await works(s.accessToken), true);
      await t.prisma.refreshToken.updateMany({ where: { userId: u.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
      assert.equal((await gone(s.accessToken))[0], 401, "its refresh token ran out, so the session is over");
    });

    it("switching facility starts a new session and ends the old one at once", async () => {
      const u = await t.makeUser(tenant, ["RECEPTIONIST"], { facilityIds: [tenant.facilityId] });
      const s = await session(u.username);
      const same = await t.api("post", "/auth/switch-facility", s.accessToken).send({ refreshToken: s.refreshToken, facilityId: tenant.facilityId });
      assert.equal(same.status, 200, JSON.stringify(same.body));
      assert.deepEqual([await works(same.body.data.accessToken), await works(s.accessToken)], [true, false]);
    });

    it("deactivating a person still ends their session at once", async () => {
      const u = await t.makeUser(tenant, ["RECEPTIONIST"]);
      const s = await session(u.username);
      assert.equal((await t.api("patch", `/users/${u.id}`, tenant.admin.token).send({ status: "INACTIVE" })).status, 200);
      assert.equal((await gone(s.accessToken))[0], 401);
    });
  });

  it("rotates refresh tokens, detects reuse of a rotated token and revokes the whole family", async () => {
    const l = await t.login(tenant.code, "admin", PASSWORD, tenant.facilityId);
    const rt1 = l.body.data.tokens.refreshToken as string;
    const r1 = await t.http().post("/api/v1/auth/refresh").send({ refreshToken: rt1 });
    assert.equal(r1.status, 200);
    const rt2 = r1.body.data.refreshToken as string;
    assert.notEqual(rt1, rt2);
    const replay = await t.http().post("/api/v1/auth/refresh").send({ refreshToken: rt1 });
    assert.equal(replay.status, 401);
    assert.equal(replay.body.error.code, "TOKEN_REVOKED");
    const afterTheft = await t.http().post("/api/v1/auth/refresh").send({ refreshToken: rt2 });
    assert.equal(afterTheft.status, 401, "rotated successor must be dead after reuse detection");
    const evt = await t.prisma.auditEvent.findFirst({ where: { tenantId: tenant.tenantId, action: "REFRESH_TOKEN_REUSE_DETECTED" } });
    assert.ok(evt);
  });

  it("allows exactly one winner when the same refresh token is used concurrently", async () => {
    const l = await t.login(tenant.code, "admin", PASSWORD, tenant.facilityId);
    const rt = l.body.data.tokens.refreshToken as string;
    const results = await Promise.all(Array.from({ length: 6 }, () => t.http().post("/api/v1/auth/refresh").send({ refreshToken: rt })));
    assert.equal(results.filter((r) => r.status === 200).length, 1);
    assert.ok(results.filter((r) => r.status !== 200).every((r) => r.status === 401));
  });

  it("logout revokes the session, is idempotent, and is audited", async () => {
    const l = await t.login(tenant.code, "admin", PASSWORD, tenant.facilityId);
    const rt = l.body.data.tokens.refreshToken as string;
    assert.equal((await t.http().post("/api/v1/auth/logout").send({ refreshToken: rt })).status, 204);
    assert.equal((await t.http().post("/api/v1/auth/logout").send({ refreshToken: rt })).status, 204);
    assert.equal((await t.http().post("/api/v1/auth/refresh").send({ refreshToken: rt })).status, 401);
    const evt = await t.prisma.auditEvent.findFirst({ where: { tenantId: tenant.tenantId, action: "LOGOUT" } });
    assert.ok(evt);
  });

  it("switch-facility issues a new session scoped to an accessible facility only", async () => {
    const l = await t.login(tenant.code, "admin", PASSWORD, tenant.facilityId);
    const { accessToken, refreshToken } = l.body.data.tokens as { accessToken: string; refreshToken: string };
    const sw = await t.api("post", "/auth/switch-facility", accessToken).send({ refreshToken, facilityId: tenant.facility2Id });
    assert.equal(sw.status, 200);
    const me = await t.api("get", "/auth/me", sw.body.data.accessToken);
    assert.equal(me.body.data.facility.id, tenant.facility2Id);
    assert.equal((await t.http().post("/api/v1/auth/refresh").send({ refreshToken })).status, 401, "old session revoked");

    const other = await t.makeTenant("sw");
    const bad = await t.api("post", "/auth/switch-facility", sw.body.data.accessToken).send({ refreshToken: sw.body.data.refreshToken, facilityId: other.facilityId });
    assert.equal(bad.status, 403);
  });

  it("rejects missing, malformed, tampered, wrong-algorithm and expired tokens identically", async () => {
    const good = tenant.admin.token;
    const payload = jwt.decode(good) as jwt.JwtPayload;
    const forged = jwt.sign({ typ: "access", tid: payload["tid"], fid: payload["fid"], sid: payload["sid"] }, "wrong-secret-wrong-secret-wrong-secret", { subject: payload.sub, expiresIn: 60 });
    const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString("base64url")}.${Buffer.from(JSON.stringify({ sub: payload.sub, tid: payload["tid"], fid: payload["fid"], sid: payload["sid"], typ: "access" })).toString("base64url")}.`;
    const expired = jwt.sign({ typ: "access", tid: payload["tid"], fid: payload["fid"], sid: payload["sid"] }, process.env["JWT_ACCESS_SECRET"] as string, { subject: payload.sub, expiresIn: -10 });
    const refreshAsAccess = jwt.sign({ typ: "refresh", tid: payload["tid"], fid: payload["fid"], sid: payload["sid"] }, process.env["JWT_ACCESS_SECRET"] as string, { subject: payload.sub, expiresIn: 60 });
    for (const bad of [undefined, "garbage", forged, none, expired, refreshAsAccess, `${good}x`]) {
      const r = await t.api("get", "/auth/me", bad);
      assert.equal(r.status, 401, String(bad).slice(0, 30));
      assert.equal(r.body.error.code, "UNAUTHENTICATED");
    }
  });

  it("changes own password with the current password, revokes sessions, and audits without secrets", async () => {
    const u = await t.makeUser(tenant, ["RECEPTIONIST"]);
    const l = await t.login(tenant.code, u.username);
    const rt = l.body.data.tokens.refreshToken as string;
    const wrong = await t.api("post", "/users/me/password", u.token).send({ currentPassword: "Nope-Nope-1", newPassword: "New-Passw0rd-xyz" });
    assert.equal(wrong.status, 400);
    const ok = await t.api("post", "/users/me/password", u.token).send({ currentPassword: PASSWORD, newPassword: "New-Passw0rd-xyz" });
    assert.equal(ok.status, 204);
    assert.equal((await t.http().post("/api/v1/auth/refresh").send({ refreshToken: rt })).status, 401);
    assert.equal((await t.api("get", "/auth/me", u.token)).status, 401, "the session that changed the password has ended too");
    const again = await t.login(tenant.code, u.username, "New-Passw0rd-xyz");
    assert.equal(again.status, 200);
    const weak = await t.api("post", "/users/me/password", again.body.data.tokens.accessToken).send({ currentPassword: "New-Passw0rd-xyz", newPassword: "short" });
    assert.equal(weak.status, 400);
    const evts = await t.prisma.auditEvent.findMany({ where: { tenantId: tenant.tenantId, actorUserId: u.id, action: "PASSWORD_CHANGED" } });
    assert.equal(evts.length, 1);
    assert.ok(!JSON.stringify(evts[0]).includes("Passw0rd"));
  });

  it("audits login success and failure without leaking secrets", async () => {
    await t.login(tenant.code, "admin", "Wrong-Password-1", tenant.facilityId);
    await t.login(tenant.code, "admin", PASSWORD, tenant.facilityId);
    const events = await t.prisma.auditEvent.findMany({ where: { tenantId: tenant.tenantId, action: { in: ["LOGIN_FAILED", "LOGIN_SUCCESS"] } } });
    assert.ok(events.some((e) => e.action === "LOGIN_FAILED"));
    assert.ok(events.some((e) => e.action === "LOGIN_SUCCESS"));
    const blob = JSON.stringify(events);
    assert.ok(!blob.includes(PASSWORD) && !blob.includes("Wrong-Password-1"));
  });
});

describe("authentication rate limiting", () => {
  let t: TestApp;
  before(async () => { t = await startApp({ rateLimit: true }); });
  after(async () => { await t.close(); });

  it("throttles repeated login attempts with 429 RATE_LIMITED", async () => {
    let last = 0;
    let code = "";
    for (let i = 0; i < 14; i++) {
      const r = await t.login("whatever-tenant", "someone", "Whatever-123");
      last = r.status;
      if (r.status === 429) { code = r.body.error.code as string; break; }
    }
    assert.equal(last, 429);
    assert.equal(code, "RATE_LIMITED");
  });

  it("allows exactly ten sign-in tries a minute per client, then answers 429 with Retry-After", async () => {
    const attempt = () => t.http().post("/api/v1/auth/login").set("X-Forwarded-For", "203.0.113.50").send({ tenantCode: "whatever-tenant", identifier: "someone", password: "Whatever-123" });
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await attempt()).status);
    assert.deepEqual(statuses, [...Array<number>(10).fill(401), 429]);
    const refused = await attempt();
    assert.equal(refused.status, 429);
    assert.equal(refused.headers["retry-after"], "60", "tells the client how long to wait");
    assert.equal(refused.body.error.code, "RATE_LIMITED");
    assert.ok(!JSON.stringify(refused.body).includes("Whatever-123"), "never echoes the password");
  });

  it("counts login attempts per client address forwarded by the trusted web server", async () => {
    const attempt = (ip: string) => t.http().post("/api/v1/auth/login").set("X-Forwarded-For", ip).send({ tenantCode: "whatever-tenant", identifier: "someone", password: "Whatever-123" });
    let last = 0;
    for (let i = 0; i < 14 && last !== 429; i++) last = (await attempt("203.0.113.10")).status;
    assert.equal(last, 429, "one client is still throttled");
    assert.equal((await attempt("203.0.113.11")).status, 401, "a different client keeps its own allowance");
  });

  it("counts refreshes and logouts per session, so users sharing the web server are never throttled together", async () => {
    for (let i = 0; i < 35; i++) {
      const refreshToken = `not-a-real-token-${String(i).padStart(8, "0")}`;
      assert.equal((await t.http().post("/api/v1/auth/refresh").send({ refreshToken })).status, 401, `refresh for session ${i + 1}`);
      assert.equal((await t.http().post("/api/v1/auth/logout").send({ refreshToken })).status, 204, `logout for session ${i + 1}`);
    }
    let last = 0;
    for (let i = 0; i < 34 && last !== 429; i++) last = (await t.http().post("/api/v1/auth/refresh").send({ refreshToken: "one-session-hammering-refresh" })).status;
    assert.equal(last, 429, "a single session hammering refresh is still throttled");
  });
});

describe("authentication rate limiting across API instances", () => {
  let one: TestApp;
  let two: TestApp;
  before(async () => { one = await startApp({ rateLimit: true }); two = await startApp({ rateLimit: true }); });
  after(async () => { await one.close(); await two.close(); });

  it("two running API instances share one sign-in allowance per client", async () => {
    const attempt = (app: TestApp) => app.http().post("/api/v1/auth/login").set("X-Forwarded-For", "203.0.113.77").send({ tenantCode: "whatever-tenant", identifier: "someone", password: "Whatever-123" });
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await attempt(i % 2 === 0 ? one : two)).status);
    assert.deepEqual(statuses, [...Array<number>(10).fill(401), 429], "the eleventh try is refused whichever instance gets it");
    assert.equal((await attempt(one)).status, 429);
    assert.equal((await attempt(two)).status, 429);
  });
});

describe("authentication rate limiting when no proxy is trusted", () => {
  let t: TestApp;
  before(async () => { process.env["TRUST_PROXY"] = "false"; t = await startApp({ rateLimit: true }); });
  after(async () => { await t.close(); delete process.env["TRUST_PROXY"]; });

  it("ignores X-Forwarded-For from an untrusted peer, so a client cannot forge fresh addresses", async () => {
    let last = 0;
    for (let i = 0; i < 14 && last !== 429; i++) {
      last = (await t.http().post("/api/v1/auth/login").set("X-Forwarded-For", `198.51.100.${i}`).send({ tenantCode: "whatever-tenant", identifier: "someone", password: "Whatever-123" })).status;
    }
    assert.equal(last, 429);
  });
});

describe("password change rate limiting", () => {
  let t: TestApp;
  let tenant: TestTenant;
  before(async () => { t = await startApp({ rateLimit: true }); tenant = await t.makeTenant("pwrl"); });
  after(async () => { await t.close(); });

  it("counts password-change attempts per session, not per address", async () => {
    const a = await t.makeUser(tenant, []);
    const b = await t.makeUser(tenant, []);
    const change = (token: string) => t.api("post", "/users/me/password", token).send({ currentPassword: "Wrong-Password-1", newPassword: "Another-Pass-456" });
    let last = 0;
    for (let i = 0; i < 14 && last !== 429; i++) last = (await change(a.token)).status;
    assert.equal(last, 429, "one session is still throttled");
    assert.equal((await change(b.token)).status, 400, "another user's session keeps its own allowance");
  });
});
