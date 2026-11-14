import "reflect-metadata";
import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { tenantScope } from "../common/tenant-scope";
import { FIRST_NAMES_F, FIRST_NAMES_M, GENERICS, LAST_NAMES, LOCALITIES } from "./seed-data";

/**
 * Development / demo seed. Synthetic data only (CLAUDE.md §48). It drives the real HTTP API in-process so every business rule,
 * trigger and audit event applies to seeded data exactly as in production. Refuses to run in production.
 *   SEED_PASSWORD=... node dist/cli/seed.js
 */
const FULL = { departments: 8, doctors: 10, nurses: 12, patients: 1000, appointments: 100, opdNow: 30, beds: 20, admissions: 12, medicines: 100, invoices: 50, opdAt: 200, admAt: 400, invAt: 600 };
/** SEED_PROFILE=small is a quick data set for automated browser tests; the default is the demo scale from CLAUDE.md §48. */
const SMALL = { departments: 4, doctors: 3, nurses: 2, patients: 60, appointments: 10, opdNow: 4, beds: 10, admissions: 2, medicines: 20, invoices: 6, opdAt: 10, admAt: 20, invAt: 30 };
const COUNTS = process.env["SEED_PROFILE"] === "small" ? SMALL : FULL;

interface Json { [k: string]: any } // eslint-disable-line @typescript-eslint/no-explicit-any -- API responses are untyped JSON in a CLI

async function main(): Promise<void> {
  if (process.env["NODE_ENV"] === "production") throw new Error("Refusing to seed demo data in production");
  process.env["RATE_LIMIT_ENABLED"] = "false";
  const generated = !process.env["SEED_PASSWORD"];
  const password = process.env["SEED_PASSWORD"] ?? `Demo-${randomBytes(6).toString("hex")}-Pass1`;

  const [{ createApp }, { PrismaService }, { TenantsService }, { PasswordService }] = await Promise.all([
    import("../bootstrap"), import("../common/prisma.service"), import("../modules/tenants/tenants.service"), import("../modules/auth/password.service"),
  ]);
  const app = await createApp();
  await app.init();
  await app.listen(0, "127.0.0.1");
  const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api/v1`;
  const prisma = app.get(PrismaService);
  const passwords = app.get(PasswordService);

  const code = process.env["SEED_TENANT_CODE"] ?? "demo-hospital";
  if (await prisma.tenant.findFirst({ where: { code } })) {
    process.stdout.write(`Tenant "${code}" already exists; nothing to do.\n`);
    await app.close();
    return;
  }

  const rnd = (n: number) => Math.floor(Math.random() * n);
  const pick = <T,>(xs: readonly T[]): T => xs[rnd(xs.length)] as T;

  const call = async (method: string, path: string, token: string | null, body?: unknown, headers: Record<string, string> = {}, expect: number[] = [200, 201]): Promise<Json> => {
    const res = await fetch(`${base}${path}`, {
      method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as Json;
    if (!expect.includes(res.status)) throw new Error(`${method} ${path} -> ${res.status} ${json["error"]?.code ?? ""} ${json["error"]?.message ?? ""}`);
    return (json["data"] ?? {}) as Json;
  };
  const parallel = async <T,>(items: T[], size: number, fn: (x: T, i: number) => Promise<void>) => {
    let next = 0;
    await Promise.all(Array.from({ length: size }, async () => { while (next < items.length) { const i = next++; await fn(items[i] as T, i); } }));
  };
  const step = (s: string) => process.stdout.write(`• ${s}\n`);

  step("provisioning tenant and facility");
  const prov = await app.get(TenantsService).provision({
    tenant: { name: "Demo City Hospital", code, timezone: "Asia/Kolkata" },
    facility: { name: "Demo City Hospital", code: "DEMO", city: "Kolkata", district: "Kolkata", state: "West Bengal" },
    admin: { username: "admin", fullName: "Demo Administrator", password },
  });
  const login = async (username: string): Promise<string> => {
    const r = await call("POST", "/auth/login", null, { tenantCode: code, identifier: username, password, facilityId: prov.facilityId });
    return r["tokens"].accessToken as string;
  };
  const admin = await login("admin");

  const roles = Object.fromEntries((await prisma.role.findMany({ where: { tenantId: prov.tenantId } })).map((r) => [r.name, r.id]));
  const hash = await passwords.hash(password);
  const mkUser = async (username: string, fullName: string, role: string): Promise<string> => {
    const user = await prisma.user.create({ data: { tenantId: prov.tenantId, username, fullName, passwordHash: hash } });
    await prisma.userFacility.create({ data: { tenantId: prov.tenantId, userId: user.id, facilityId: prov.facilityId } });
    await prisma.userRole.create({ data: { tenantId: prov.tenantId, userId: user.id, roleId: roles[role] as string } });
    return user.id;
  };

  step("settings, departments and staff");
  // The demo data starts OPD visits without a consultation bill, so the rule "pay the consultation before the visit" (on by default) is held off while seeding
  // and switched back to the default at the end.
  await call("PUT", "/settings/OPD_FEE_BEFORE_VISIT", admin, { value: false });
  await call("PUT", "/settings/PRINT_HEADER", admin, { value: { hospitalName: "Demo City Hospital", tagline: "Care you can trust", address: "12 Synthetic Road, Kolkata 700091", phone: "033-5550123" } });
  const deptNames = ["General Medicine", "Paediatrics", "Obstetrics and Gynaecology", "Orthopaedics", "General Surgery", "ENT", "Dermatology", "Cardiology"];
  const departments: Json[] = [];
  for (const [i, name] of deptNames.slice(0, COUNTS.departments).entries()) departments.push(await call("POST", "/departments", admin, { name, code: `DEPT${i + 1}` }));

  const doctors: string[] = [];
  for (let i = 0; i < COUNTS.doctors; i++) {
    const name = `Dr. ${pick(i % 2 ? FIRST_NAMES_F : FIRST_NAMES_M)} ${pick(LAST_NAMES)}`;
    const userId = await mkUser(`doctor${i + 1}`, name, "DOCTOR");
    const pr = await prisma.practitioner.create({
      data: { tenantId: prov.tenantId, facilityId: prov.facilityId, userId, departmentId: (departments[i % departments.length] as Json)["id"], displayName: name, specialty: deptNames[i % deptNames.length] as string },
    });
    await call("PUT", `/practitioners/${pr.id}/schedule`, admin, { windows: [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, start: "09:00", end: "17:00", slotMinutes: 15 })) });
    doctors.push(pr.id);
  }
  // The resident medical officer: a registered practitioner (so they may write clinical documents) who covers the whole ward. An empty,
  // saved schedule (scheduleSet) means nobody can book appointments with them.
  const rmoName = `Dr. ${pick(FIRST_NAMES_F)} ${pick(LAST_NAMES)} (RMO)`;
  const rmoUserId = await mkUser("rmo1", rmoName, "RMO");
  await prisma.practitioner.create({ data: { tenantId: prov.tenantId, facilityId: prov.facilityId, userId: rmoUserId, displayName: rmoName, specialty: "Resident Medical Officer", scheduleSet: true } });
  for (let i = 0; i < COUNTS.nurses; i++) await mkUser(`nurse${i + 1}`, `Nurse ${pick(FIRST_NAMES_F)} ${pick(LAST_NAMES)}`, "NURSE");
  for (const [u, n, r] of [["reception1", "Reception One", "RECEPTIONIST"], ["reception2", "Reception Two", "RECEPTIONIST"], ["cashier1", "Cashier One", "CASHIER"], ["cashier2", "Cashier Two", "CASHIER"], ["pharmacist1", "Pharmacist One", "PHARMACIST"], ["manager1", "Manager One", "MANAGER"], ["labtech1", "Lab Technician One", "LAB_TECHNICIAN"], ["pathologist1", "Dr. Pathologist One", "PATHOLOGIST"], ["radiographer1", "Radiographer One", "RADIOGRAPHER"], ["radiologist1", "Dr. Radiologist One", "RADIOLOGIST"], ["otcoord1", "OT Coordinator One", "OT_COORDINATOR"], ["tpa1", "TPA Desk One", "CLAIMS_OFFICER"], ["billing1", "Billing One", "BILLING"], ["transport1", "Patient Transport One", "PATIENT_TRANSPORT"], ["housekeeping1", "Housekeeping One", "HOUSEKEEPING"], ["mrd1", "Medical Records One", "MEDICAL_RECORDS"], ["procurement1", "Procurement One", "PROCUREMENT"], ["coordinator1", "Care Coordinator One", "CARE_COORDINATOR"], ["relations1", "Patient Relations One", "PATIENT_RELATIONS"]] as const) await mkUser(u, n, r);
  const [reception, cashier, pharmacist] = await Promise.all([login("reception1"), login("cashier1"), login("pharmacist1")]);

  step(`registering ${COUNTS.patients} patients`);
  const used = new Set<string>();
  const patients: string[] = [];
  const mobile = () => { for (;;) { const m = `${pick(["98", "97", "96", "90", "87", "70"])}${String(10_000_000 + rnd(89_999_999))}`; if (!used.has(m)) { used.add(m); return m; } } };
  await parallel(Array.from({ length: COUNTS.patients }), 6, async (_x, i) => {
    const female = i % 2 === 0;
    const loc = pick(LOCALITIES);
    const p = await call("POST", "/patients", reception, {
      firstName: pick(female ? FIRST_NAMES_F : FIRST_NAMES_M), lastName: pick(LAST_NAMES), gender: female ? "FEMALE" : "MALE",
      dateOfBirth: `${1945 + rnd(70)}-${String(1 + rnd(12)).padStart(2, "0")}-${String(1 + rnd(28)).padStart(2, "0")}`, mobile: mobile(),
      addressLine: `${1 + rnd(200)} ${loc.street}`, city: "Kolkata", district: loc.district, state: "West Bengal", postalCode: loc.pin,
    }, { "idempotency-key": randomUUID() }, [201, 409]);
    if (p["id"]) patients.push(p["id"] as string);
  });
  step(`  ${patients.length} patients created`);

  step("booking future appointments");
  const slotBase = new Date();
  slotBase.setUTCDate(slotBase.getUTCDate() + 1);
  slotBase.setUTCHours(3, 30, 0, 0); // 09:00 IST
  let booked = 0;
  for (let i = 0; i < COUNTS.appointments; i++) {
    const startAt = new Date(slotBase.getTime() + Math.floor(i / doctors.length) * 15 * 60_000);
    try { await call("POST", "/appointments", reception, { patientId: patients[i], practitionerId: doctors[i % doctors.length], startAt: startAt.toISOString() }); booked++; } catch { /* slot unavailable: skipped */ }
  }
  step(`  ${booked} appointments booked`);

  step(`opening ${COUNTS.opdNow} OPD visits`);
  for (let i = 0; i < COUNTS.opdNow; i++) await call("POST", "/appointments/walk-in", reception, { patientId: patients[COUNTS.opdAt + i], practitionerId: doctors[i % doctors.length] });

  step("wards, beds and admissions");
  const wards = [await call("POST", "/wards", admin, { name: "General Ward", code: "GW" }), await call("POST", "/wards", admin, { name: "Private Rooms", code: "PR" })];
  const beds: string[] = [];
  for (const [wi, ward] of wards.entries()) {
    const room = await call("POST", "/rooms", admin, { wardId: ward["id"], name: wi === 0 ? "Ward hall" : "Private block", code: `RM${wi + 1}` });
    for (let b = 0; b < COUNTS.beds / 2; b++) beds.push((await call("POST", "/beds", admin, { roomId: room["id"], code: `${wi === 0 ? "G" : "P"}${b + 1}`, dailyRate: wi === 0 ? "800.00" : "2500.00" }))["id"] as string);
  }
  const reasons = ["Fever with breathing difficulty", "Post-operative care", "Dehydration needing IV fluids", "Chest pain under observation", "Fracture management"];
  for (let i = 0; i < COUNTS.admissions; i++) {
    await call("POST", "/admissions", reception, { patientId: patients[COUNTS.admAt + i], consultantId: doctors[i % doctors.length], bedId: beds[i], reason: `${pick(reasons)} (synthetic)` }, { "idempotency-key": randomUUID() });
  }

  step(`stocking ${COUNTS.medicines} medicines`);
  const ymd = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
  const meds = GENERICS.flatMap((g) => g.strengths.map((s) => ({ generic: g.name, strength: s, form: g.form })));
  for (const [i, m] of meds.slice(0, COUNTS.medicines).entries()) {
    const med = await call("POST", "/medicines", pharmacist, { brandName: `${m.generic.split(" ")[0]}-${["Plus", "Forte", "DS", "Rx", "Lite"][i % 5]}`, genericName: m.generic, strength: m.strength, dosageForm: m.form, gstPercent: 12, reorderLevel: 20 });
    const price = 2 + rnd(60);
    for (const [bi, days] of [[1, 120 + rnd(300)], [2, 400 + rnd(300)]] as const) {
      await call("POST", "/pharmacy/batches", pharmacist, {
        medicineId: med["id"], batchNo: `B${i + 1}-${bi}`, expiryDate: ymd(i % 17 === 0 && bi === 1 ? 45 : days),
        mrp: (price * 1.2).toFixed(2), purchasePrice: (price * 0.7).toFixed(2), sellingPrice: price.toFixed(2), quantity: i % 23 === 0 ? 8 : 60 + rnd(200),
      }, { "idempotency-key": randomUUID() });
    }
  }

  step(`billing: ${COUNTS.invoices} invoices`);
  const services: string[] = [];
  // The OPD desk bills only outpatient services: surgeries are inpatient (IPD) by default, so the OPD invoices below choose from the others.
  const opdServices: string[] = [];
  const SURGERIES = ["APPEN", "HERNIA", "ARTHRO"];
  for (const [c, n, price, cat] of [["CONS", "OPD consultation", "500", "CONSULTATION"], ["DRESS", "Dressing (small)", "150", "INJECTION_DRESSING"], ["INJ", "Injection charge", "80", "INJECTION_DRESSING"], ["ECG", "ECG", "300", "PROCEDURE"], ["APPEN", "Appendectomy", "15000", "PROCEDURE"], ["HERNIA", "Hernia repair", "18000", "PROCEDURE"], ["ARTHRO", "Knee arthroscopy", "22000", "PROCEDURE"], ["IMPLT", "Orthopaedic plate and screws (implant)", "8500", "OTHER"], ["IMPMS", "Surgical mesh (implant)", "3500", "OTHER"], ["CONKT", "Surgical consumables kit", "1800", "OTHER"], ["CONSU", "Suture pack", "600", "OTHER"]] as const) {
    // An ECG is a procedure by category but an outpatient service too, so it is offered at both desks; the OPD consultation is outpatient only.
    const id = (await call("POST", "/services", admin, { code: c, name: n, category: cat, price, taxPercent: 0, ...(c === "ECG" ? { availableFor: "BOTH" } : c === "CONS" ? { availableFor: "OPD" } : {}) }))["id"] as string;
    services.push(id);
    if (!SURGERIES.includes(c)) opdServices.push(id);
  }
  // The hospital's lab-test and investigation list, which feeds the Lab test dropdown of the prescription and the Cashier's test billing (synthetic prices).
  for (const [c, n, price] of [["CBC", "CBC (complete blood count)", "250"], ["ESR", "ESR", "100"], ["LFT", "Liver function test (LFT)", "600"], ["KFT", "Kidney function test (KFT)", "550"], ["RBS", "Random blood sugar", "80"], ["FBS", "Fasting blood sugar", "80"], ["HBA1C", "HbA1c", "450"], ["LIPID", "Lipid profile", "700"], ["TSH", "TSH", "350"], ["CRP", "CRP", "400"], ["URINE", "Urine routine", "120"], ["XRAYCH", "Chest X-ray", "400"], ["USGAB", "USG abdomen", "900"], ["ECHO", "2D echo", "1500"]] as const) {
    await call("POST", "/services", admin, { code: c, name: n, category: "INVESTIGATION", price, taxPercent: 0 });
  }
  await call("POST", "/shifts/open", cashier, { openingCash: "2000" });
  for (let i = 0; i < COUNTS.invoices; i++) {
    const inv = await call("POST", "/invoices", cashier, { patientId: patients[COUNTS.invAt + i], lines: [{ serviceId: pick(opdServices), quantity: 1 }, ...(i % 3 === 0 ? [{ serviceId: pick(opdServices), quantity: 2 }] : [])] });
    const issued = await call("POST", `/invoices/${inv["id"]}/issue`, cashier, {});
    if (i % 4 === 0) continue; // left outstanding on purpose
    const total = Number(issued["total"]);
    const half = Math.floor(total / 2);
    const payments = i % 3 === 0
      ? [{ method: "CASH", amount: half.toFixed(2) }, { method: "UPI", amount: (total - half).toFixed(2), reference: `UPI${100000 + i}` }]
      : [{ method: i % 2 ? "CASH" : "CARD", amount: total.toFixed(2), ...(i % 2 ? {} : { reference: `CARD${100000 + i}` }) }];
    await call("POST", `/invoices/${inv["id"]}/payments`, cashier, { payments }, { "idempotency-key": randomUUID() });
  }

  // Back to the product default (on), unless the seed is told otherwise: SEED_OPD_FEE_BEFORE_VISIT=false (the browser tests, which bill after the consultation).
  await call("PUT", "/settings/OPD_FEE_BEFORE_VISIT", admin, { value: process.env["SEED_OPD_FEE_BEFORE_VISIT"] !== "false" });
  await app.close();
  process.stdout.write(`\nSeed complete. Tenant code: ${code}\nLogin as admin, doctor1..doctor${COUNTS.doctors}, nurse1..nurse${COUNTS.nurses}, rmo1, reception1, cashier1, pharmacist1, manager1, labtech1, pathologist1, radiographer1, radiologist1, otcoord1, tpa1, billing1, transport1, housekeeping1, mrd1, procurement1.\n`);
  process.stdout.write(generated ? `Password (generated, shown once): ${password}\n` : "Password: the value of SEED_PASSWORD\n");
}

// The seed provisions a hospital and writes across it: an owner operation, run with the OWNER database login (docs/rls.md).
tenantScope.owner(() => main()).catch((e: unknown) => {
  process.stderr.write(`Seed failed: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
