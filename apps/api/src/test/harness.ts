import "reflect-metadata";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { PrismaClient } from "@medos/database";
import { SYSTEM_ROLES } from "@medos/shared";
import request from "supertest";

const url = process.env["TEST_DATABASE_URL"] ?? "postgresql://medos@127.0.0.1:54329/medos_test";
if (!new URL(url).pathname.replace("/", "").endsWith("_test")) {
  throw new Error("Refusing to run tests against a database whose name does not end with _test");
}
process.env["NODE_ENV"] = "test";
// The app under test may use the REAL restricted login (docs/rls.md) while the harness keeps its own owner connection.
const appUrl = process.env["TEST_APP_DATABASE_URL"];
if (appUrl && !new URL(appUrl).pathname.replace("/", "").endsWith("_test")) {
  throw new Error("Refusing to run tests against a database whose name does not end with _test");
}
process.env["DATABASE_URL"] = appUrl ?? url;
process.env["JWT_ACCESS_SECRET"] ??= "test-access-secret-0123456789abcdef-test";
process.env["ARGON2_MEMORY_KIB"] ??= "1024";
process.env["ARGON2_PASSES"] ??= "1";
process.env["SECRETS_ENCRYPTION_KEY"] ??= Buffer.alloc(32, 7).toString("base64");

import { createApp } from "../bootstrap";
import { AuditService } from "../common/audit.service";
import type { PrismaService } from "../common/prisma.service";
import { TenantsService } from "../modules/tenants/tenants.service";
import { PasswordService } from "../modules/auth/password.service";

export const PASSWORD = "Synthetic-Pass-123";

export interface TestTenant {
  tenantId: string;
  code: string;
  facilityId: string;
  facility2Id: string;
  admin: { id: string; username: string; token: string };
  roleIds: Record<string, string>;
}

export interface TestApp {
  app: INestApplication;
  /** The test's own OWNER connection: sees every hospital, independent of the app under test (which may run as the restricted role). */
  prisma: PrismaClient;
  http: () => ReturnType<typeof request>;
  api: (method: "get" | "post" | "put" | "patch" | "delete", path: string, token?: string) => request.Test;
  close: () => Promise<void>;
  /**
   * `defaultSettings: true` leaves the hospital's settings at the product defaults. Without it the test hospital starts with "OPD consultation paid before the visit"
   * switched OFF, so the many tests that start an OPD visit are not each held up by a consultation bill; the tests of that rule ask for the defaults.
   */
  makeTenant: (label?: string, opts?: { defaultSettings?: boolean }) => Promise<TestTenant>;
  makeUser: (t: TestTenant, roleNames: string[], opts?: { facilityIds?: string[]; username?: string }) => Promise<{ id: string; username: string; token: string }>;
  login: (tenantCode: string, username: string, password?: string, facilityId?: string) => Promise<request.Response>;
}

export async function startApp(opts: { rateLimit?: boolean } = {}): Promise<TestApp> {
  process.env["RATE_LIMIT_ENABLED"] = opts.rateLimit ? "true" : "false";
  // Uploaded test files go to a throwaway directory, never the project storage.
  process.env["STORAGE_DIR"] ??= mkdtempSync(join(tmpdir(), "medos-test-files-"));
  const app = await createApp();
  await app.init();
  const prisma = new PrismaClient({ datasourceUrl: url, transactionOptions: { maxWait: 15_000, timeout: 30_000 } });
  // Open the pool's connections up front, as the application does at startup: a burst of simultaneous queries on a cold pool can make the local
  // Windows database refuse connections for a moment (Prisma P1001), which would fail concurrency tests for reasons unrelated to what they test.
  await Promise.allSettled(Array.from({ length: 16 }, () => prisma.$queryRaw`SELECT pg_sleep(0.1)`));
  // Rate-limit counters are shared through the database, so a previous test app's counters would otherwise throttle this one.
  await prisma.$executeRaw`DELETE FROM "RateLimitBucket"`;
  const passwords = app.get(PasswordService);
  // Provisioning is a platform-operator action done with the OWNER login (the CLI does the same), never through the API's restricted one.
  const ownerDb = prisma as unknown as PrismaService;
  const tenants = new TenantsService(ownerDb, passwords, new AuditService(ownerDb));
  const server = app.getHttpServer();

  const api: TestApp["api"] = (method, path, token) => {
    const r = request(server)[method](`/api/v1${path}`);
    return token ? r.set("Authorization", `Bearer ${token}`) : r;
  };

  const login: TestApp["login"] = (tenantCode, username, password = PASSWORD, facilityId) =>
    request(server).post("/api/v1/auth/login").send({ tenantCode, identifier: username, password, ...(facilityId ? { facilityId } : {}) });

  const tokenFor = async (code: string, username: string, facilityId: string): Promise<string> => {
    const r = await login(code, username, PASSWORD, facilityId);
    if (r.status !== 200 || r.body.data.status !== "AUTHENTICATED") throw new Error(`test login failed: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body.data.tokens.accessToken as string;
  };

  const makeTenant: TestApp["makeTenant"] = async (label = "t", opts = {}) => {
    const suffix = randomBytes(4).toString("hex");
    const code = `${label}-${suffix}`.toLowerCase();
    const res = await tenants.provision({
      tenant: { name: `Synthetic Hospital ${code}`, code, timezone: "Asia/Kolkata" },
      facility: { name: "Main Campus", code: `MC${suffix.slice(0, 4).toUpperCase()}`, city: "Kolkata", state: "West Bengal" },
      admin: { username: "admin", fullName: "Synthetic Admin", password: PASSWORD },
    });
    const facility2 = await prisma.facility.create({ data: { tenantId: res.tenantId, name: "Annex", code: `AX${suffix.slice(0, 4).toUpperCase()}` } });
    const roles = await prisma.role.findMany({ where: { tenantId: res.tenantId } });
    const roleIds = Object.fromEntries(roles.map((r) => [r.name, r.id]));
    await prisma.userFacility.create({ data: { tenantId: res.tenantId, userId: res.adminUserId, facilityId: facility2.id } });
    if (!opts.defaultSettings) {
      for (const facilityId of [res.facilityId, facility2.id]) await prisma.setting.create({ data: { tenantId: res.tenantId, facilityId, key: "OPD_FEE_BEFORE_VISIT", value: false, updatedById: res.adminUserId } });
    }
    const token = await tokenFor(code, "admin", res.facilityId);
    return { tenantId: res.tenantId, code, facilityId: res.facilityId, facility2Id: facility2.id, admin: { id: res.adminUserId, username: "admin", token }, roleIds };
  };

  const makeUser: TestApp["makeUser"] = async (t, roleNames, o = {}) => {
    const username = o.username ?? `u${randomBytes(4).toString("hex")}`;
    const passwordHash = await passwords.hash(PASSWORD);
    const user = await prisma.user.create({ data: { tenantId: t.tenantId, username, fullName: `Synthetic ${username}`, passwordHash } });
    const facilityIds = o.facilityIds ?? [t.facilityId];
    await prisma.userFacility.createMany({ data: facilityIds.map((facilityId) => ({ tenantId: t.tenantId, userId: user.id, facilityId })) });
    for (const n of roleNames) {
      const roleId = t.roleIds[n];
      if (!roleId || !(n in SYSTEM_ROLES)) throw new Error(`unknown system role ${n}`);
      await prisma.userRole.create({ data: { tenantId: t.tenantId, userId: user.id, roleId } });
    }
    const token = await tokenFor(t.code, username, facilityIds[0] as string);
    return { id: user.id, username, token };
  };

  return {
    app, prisma, api, login, makeTenant, makeUser,
    http: () => request(server),
    close: async () => { await app.close(); await prisma.$disconnect(); },
  };
}

// ───────────── synthetic data builders ─────────────

const LETTERS = "bcdfghjklmnprstvwz";
const VOWELS = "aeiou";
/** A pronounceable, effectively unique synthetic name word so trigram duplicate detection never collides across tests. */
export function uniqueWord(len = 8): string {
  const b = randomBytes(len);
  return Array.from(b, (x, i) => (i % 2 === 0 ? LETTERS[x % LETTERS.length] : VOWELS[x % VOWELS.length])).join("").replace(/^./, (c) => c.toUpperCase());
}
export function randomMobile(): string {
  const digits = Array.from(randomBytes(9), (x) => x % 10).join("");
  return `9${digits}`;
}
export function patientBody(o: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    firstName: uniqueWord(8), lastName: uniqueWord(8), gender: "FEMALE", dateOfBirth: "1990-04-02",
    mobile: randomMobile(), addressLine: "12 Synthetic Lane", city: "Kolkata", district: "Kolkata", state: "West Bengal", postalCode: "700001",
    ...o,
  };
}
export async function registerPatient(t: TestApp, token: string, o: Record<string, unknown> = {}): Promise<{ id: string; mrn: string; version: number }> {
  // Every test patient has the same birth date and a random name, and duplicate detection looks at similar name plus the same birth date, so two random names can very
  // rarely look alike. When that happens (and the caller did not choose the names) try again with fresh names instead of failing an unrelated test.
  const named = "firstName" in o || "lastName" in o;
  let r = await t.api("post", "/patients", token).send(patientBody(o));
  for (let tries = 0; r.status === 409 && r.body?.error?.code === "DUPLICATE_PATIENT_SUSPECTED" && !named && tries < 5; tries++) r = await t.api("post", "/patients", token).send(patientBody(o));
  if (r.status !== 201) throw new Error(`registerPatient failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data as { id: string; mrn: string; version: number };
}
export interface TestDoctor { userId: string; token: string; practitionerId: string; departmentId: string }

/** A doctor user with a practitioner record (and a fresh department) at the tenant's primary facility. */
export async function makeDoctor(t: TestApp, tenant: TestTenant, o: { facilityId?: string } = {}): Promise<TestDoctor> {
  const facilityId = o.facilityId ?? tenant.facilityId;
  const user = await t.makeUser(tenant, ["DOCTOR"], { facilityIds: [facilityId] });
  const department = await t.prisma.department.create({ data: { tenantId: tenant.tenantId, facilityId, name: `Dept ${uniqueWord(5)}`, code: `D${randomBytes(3).toString("hex").toUpperCase()}` } });
  const practitioner = await t.prisma.practitioner.create({
    data: { tenantId: tenant.tenantId, facilityId, userId: user.id, departmentId: department.id, displayName: `Dr. ${uniqueWord(6)} ${uniqueWord(7)}`, specialty: "General Medicine" },
  });
  return { userId: user.id, token: user.token, practitionerId: practitioner.id, departmentId: department.id };
}

/** A user whose only role is a custom role holding exactly the listed permissions. */
export async function makeUserWithPermissions(t: TestApp, tenant: TestTenant, permissions: string[]): Promise<{ id: string; token: string }> {
  const role = await t.api("post", "/roles", tenant.admin.token).send({ name: `Custom ${uniqueWord(6)}`, permissions });
  if (role.status !== 201) throw new Error(`role create failed: ${JSON.stringify(role.body)}`);
  const user = await t.makeUser(tenant, []);
  const r = await t.api("put", `/users/${user.id}/roles`, tenant.admin.token).send({ roleIds: [role.body.data.id] });
  if (r.status !== 200) throw new Error(`role assign failed: ${JSON.stringify(r.body)}`);
  return user;
}
export interface TestVisit { encounterId: string; queueId: string; appointmentId: string }

/** Registers an immediate OPD visit (walk-in) for the patient with the given doctor, returning the encounter. */
export async function startVisit(t: TestApp, receptionToken: string, doctor: TestDoctor, patientId: string): Promise<TestVisit> {
  const r = await t.api("post", "/appointments/walk-in", receptionToken).send({ patientId, practitionerId: doctor.practitionerId });
  if (r.status !== 201) throw new Error(`startVisit failed: ${r.status} ${JSON.stringify(r.body)}`);
  return { encounterId: r.body.data.encounter.id as string, queueId: r.body.data.queueEntry.id as string, appointmentId: r.body.data.appointment.id as string };
}
/** A practitioner whose user holds exactly the listed permissions (for authorization edge cases). */
export async function makeClinicianWith(t: TestApp, tenant: TestTenant, permissions: string[]): Promise<TestDoctor> {
  const user = await makeUserWithPermissions(t, tenant, permissions);
  const department = await t.prisma.department.create({ data: { tenantId: tenant.tenantId, facilityId: tenant.facilityId, name: `Dept ${uniqueWord(5)}`, code: `D${randomBytes(3).toString("hex").toUpperCase()}` } });
  const practitioner = await t.prisma.practitioner.create({ data: { tenantId: tenant.tenantId, facilityId: tenant.facilityId, userId: user.id, departmentId: department.id, displayName: `Dr. ${uniqueWord(6)} ${uniqueWord(7)}` } });
  return { userId: user.id, token: user.token, practitionerId: practitioner.id, departmentId: department.id };
}