import { randomUUID } from "node:crypto";
import { makeDoctor, patientBody, startApp, type TestApp, type TestDoctor, type TestTenant } from "../test/harness";

/**
 * Multi-user, multi-hospital load test (docs/load-test.md). Not part of `pnpm test`: run `pnpm --filter @medos/api load`.
 * Several hospitals each run many simultaneous receptionists and cashiers through the OPD money path (register, check in,
 * search, bill, issue, collect payment) against the real database, then the data is checked for the things concurrency breaks:
 * duplicate patient numbers, duplicate or skipped invoice numbers, money that does not add up, and data leaking between hospitals.
 *
 * Settings (environment): LOAD_TENANTS (4), LOAD_USERS (users per hospital, 10), LOAD_SECONDS (45),
 * LOAD_DOCTORS (doctors per hospital, 5; use 1 to hammer one doctor's queue), LOAD_P95_MS (1500, the budget for the slowest common operation), LOAD_MIN_RPS (0, optional throughput floor).
 */
const TENANTS = Number(process.env["LOAD_TENANTS"] ?? 4);
const USERS = Number(process.env["LOAD_USERS"] ?? 10);
const SECONDS = Number(process.env["LOAD_SECONDS"] ?? 45);
const DOCTORS = Number(process.env["LOAD_DOCTORS"] ?? 5);
const P95_BUDGET = Number(process.env["LOAD_P95_MS"] ?? 1500);
const MIN_RPS = Number(process.env["LOAD_MIN_RPS"] ?? 0);

interface Hospital { tenant: TestTenant; serviceId: string; doctors: TestDoctor[]; created: { patientId: string; mrn: string; invoiceId: string; number: string; total: string }[] }
const samples = new Map<string, number[]>();
const statusCounts = new Map<string, number>();
const problems: string[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function pct(sorted: number[], p: number): number { return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]! : 0; }

async function main(): Promise<void> {
  const t: TestApp = await startApp();
  t.app.getHttpServer().setMaxListeners(0);
  const started = Date.now();
  const timed = async <T extends { status: number }>(op: string, fn: () => Promise<T>): Promise<T> => {
    const s = process.hrtime.bigint();
    const r = await fn();
    const ms = Number(process.hrtime.bigint() - s) / 1e6;
    (samples.get(op) ?? samples.set(op, []).get(op)!).push(ms);
    const bucket = `${op} ${Math.floor(r.status / 100)}xx`;
    statusCounts.set(bucket, (statusCounts.get(bucket) ?? 0) + 1);
    return r;
  };

  process.stdout.write(`Setting up ${TENANTS} hospitals x ${USERS} users, ${DOCTORS} doctors each...\n`);
  const hospitals: Hospital[] = [];
  const workers: { h: Hospital; rec: string; cashier: string }[] = [];
  for (let i = 0; i < TENANTS; i++) {
    const tenant = await t.makeTenant(`load-${i}`);
    const svc = await t.api("post", "/services", tenant.admin.token).send({ code: "LCONS", name: "OPD consultation", category: "CONSULTATION", price: "500.00", taxPercent: 0 });
    const h: Hospital = { tenant, serviceId: svc.body.data.id as string, doctors: await Promise.all(Array.from({ length: DOCTORS }, () => makeDoctor(t, tenant))), created: [] };
    hospitals.push(h);
    for (let u = 0; u < USERS; u++) {
      const rec = await t.makeUser(tenant, ["RECEPTIONIST"]);
      const cashier = await t.makeUser(tenant, ["CASHIER"]);
      const shift = await t.api("post", "/shifts/open", cashier.token).send({ openingCash: "0" });
      if (shift.status !== 201) throw new Error(`shift open failed: ${shift.status} ${JSON.stringify(shift.body)}`);
      workers.push({ h, rec: rec.token, cashier: cashier.token });
    }
  }

  const deadline = Date.now() + SECONDS * 1000;
  let iterations = 0;
  const unexpected = (what: string, r: { status: number; body: unknown }): void => {
    if (problems.length < 25) problems.push(`${what}: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  };

  await Promise.all(workers.map(async (w) => {
    while (Date.now() < deadline) {
      const { h } = w;
      const reg = await timed("register patient", () => t.api("post", "/patients", w.rec).send(patientBody()));
      if (reg.status !== 201) { unexpected("register patient", reg); continue; }
      const patient = reg.body.data as { id: string; mrn: string };
      const walk = await timed("check in (walk-in)", () => t.api("post", "/appointments/walk-in", w.rec).send({ patientId: patient.id, practitionerId: h.doctors[Math.floor(Math.random() * h.doctors.length)]!.practitionerId }));
      if (walk.status !== 201) unexpected("walk-in", walk);
      const encounterId = (walk.body.data?.encounter?.id as string | undefined);
      const q = await timed("view queue", () => t.api("get", "/queue", w.rec));
      if (q.status !== 200) unexpected("queue", q);
      const found = await timed("search patient by MRN", () => t.api("get", `/patients?q=${encodeURIComponent(patient.mrn)}`, w.rec));
      if (found.status !== 200) unexpected("search", found);
      const draft = await timed("create bill", () => t.api("post", "/invoices", w.cashier).send({ patientId: patient.id, ...(encounterId ? { encounterId } : {}), lines: [{ serviceId: h.serviceId, quantity: 1 }] }));
      if (draft.status !== 201) { unexpected("create bill", draft); continue; }
      const issued = await timed("issue bill", () => t.api("post", `/invoices/${draft.body.data.id}/issue`, w.cashier));
      if (issued.status !== 200) { unexpected("issue bill", issued); continue; }
      const paid = await timed("collect payment", () => t.api("post", `/invoices/${draft.body.data.id}/payments`, w.cashier).set("Idempotency-Key", `k-${randomUUID().slice(0, 18)}`).send({ payments: [{ method: "CASH", amount: "500.00" }] }));
      if (paid.status !== 201 && paid.status !== 200) { unexpected("collect payment", paid); continue; }
      h.created.push({ patientId: patient.id, mrn: patient.mrn, invoiceId: draft.body.data.id as string, number: issued.body.data.invoiceNumber as string, total: "500.00" });
      iterations += 1;
      await sleep(5 + Math.random() * 20);
    }
  }));
  const elapsed = (Date.now() - started) / 1000;

  // ── integrity checks ──
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  const check = (name: string, ok: boolean, detail = "") => checks.push({ name, ok, detail });
  for (const h of hospitals) {
    const tid = h.tenant.tenantId;
    const n = h.created.length;
    const [pat] = await t.prisma.$queryRawUnsafe<{ total: bigint; distinct_mrn: bigint }[]>(`SELECT count(*)::bigint total, count(DISTINCT i.value)::bigint distinct_mrn FROM "PatientIdentifier" i WHERE i."tenantId" = '${tid}'::uuid AND i.type = 'MRN'`);
    check(`${h.tenant.code}: patient numbers unique`, pat !== undefined && pat.total === pat.distinct_mrn && Number(pat.total) >= n, `${pat?.total} numbers, ${pat?.distinct_mrn} distinct, ${n} patients completed`);
    const inv = await t.prisma.invoice.findMany({ where: { tenantId: tid, status: { not: "DRAFT" } }, select: { invoiceNumber: true, total: true, paidTotal: true, status: true } });
    const numbers = inv.map((i) => i.invoiceNumber ?? "");
    check(`${h.tenant.code}: invoice numbers unique`, new Set(numbers).size === numbers.length, `${numbers.length} issued`);
    const seq = numbers.map((s) => Number(s.match(/(\d+)$/)?.[1])).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    check(`${h.tenant.code}: invoice numbers have no gaps`, seq.length > 0 && seq[seq.length - 1]! - seq[0]! + 1 === seq.length, `range ${seq[0]}..${seq[seq.length - 1]} for ${seq.length}`);
    check(`${h.tenant.code}: every completed bill is fully paid, to the paisa`, inv.every((i) => i.status === "PAID" ? i.paidTotal.toString() === i.total.toString() : true) && inv.filter((i) => i.status === "PAID").length >= n, `${inv.filter((i) => i.status === "PAID").length} paid of ${inv.length}`);
    const [pay] = await t.prisma.$queryRawUnsafe<{ s: string | null }[]>(`SELECT sum(amount)::text s FROM "Payment" WHERE "tenantId" = '${tid}'::uuid`);
    check(`${h.tenant.code}: payments add up to the invoices paid`, Number(pay?.s ?? 0) === inv.reduce((a, i) => a + Number(i.paidTotal), 0), `payments ${pay?.s}`);
  }
  // data of one hospital never reachable from another
  const a = hospitals[0]!; const b = hospitals[hospitals.length - 1]!;
  if (a !== b && a.created[0] && b.created[0]) {
    const p = await t.api("get", `/patients/${b.created[0].patientId}`, a.tenant.admin.token);
    const i = await t.api("get", `/invoices/${b.created[0].invoiceId}`, a.tenant.admin.token);
    check("another hospital's patient and bill are not reachable", p.status === 404 && i.status === 404, `patient ${p.status}, bill ${i.status}`);
  }
  const fiveXx = [...statusCounts.entries()].filter(([k]) => k.endsWith("5xx")).reduce((s, [, v]) => s + v, 0);
  check("no server errors (5xx)", fiveXx === 0, `${fiveXx}`);
  check("no unexpected responses", problems.length === 0, problems.slice(0, 3).join(" | "));

  // ── report ──
  const rows = [...samples.entries()].map(([op, v]) => { const s = [...v].sort((x, y) => x - y); return { op, n: s.length, p50: pct(s, 50), p95: pct(s, 95), p99: pct(s, 99), max: s[s.length - 1]! }; });
  const totalReq = rows.reduce((s, r) => s + r.n, 0);
  const rps = totalReq / elapsed;
  process.stdout.write(`\n${TENANTS} hospitals x ${USERS} receptionists + ${USERS} cashiers = ${workers.length} simultaneous work loops (${TENANTS * USERS * 2} logged-in users), ${elapsed.toFixed(0)} s, ${totalReq} requests, ${rps.toFixed(1)} req/s, ${iterations} complete patient journeys\n\n`);
  process.stdout.write("operation".padEnd(24) + "count".padStart(7) + "p50 ms".padStart(9) + "p95 ms".padStart(9) + "p99 ms".padStart(9) + "max ms".padStart(9) + "\n");
  for (const r of rows) process.stdout.write(r.op.padEnd(24) + String(r.n).padStart(7) + r.p50.toFixed(0).padStart(9) + r.p95.toFixed(0).padStart(9) + r.p99.toFixed(0).padStart(9) + r.max.toFixed(0).padStart(9) + "\n");
  const worst95 = Math.max(...rows.map((r) => r.p95));
  check(`slowest p95 within ${P95_BUDGET} ms`, worst95 <= P95_BUDGET, `${worst95.toFixed(0)} ms`);
  if (MIN_RPS > 0) check(`throughput at least ${MIN_RPS} req/s`, rps >= MIN_RPS, `${rps.toFixed(1)}`);
  process.stdout.write("\n");
  for (const c of checks) process.stdout.write(`${c.ok ? "PASS" : "FAIL"}  ${c.name}  ${c.detail}\n`);
  const ok = checks.every((c) => c.ok);
  process.stdout.write(`\n${ok ? "LOAD TEST PASSED" : "LOAD TEST FAILED"}\n`);
  await t.close();
  process.exit(ok ? 0 : 1);
}

main().catch((e: unknown) => { process.stderr.write(`load test crashed: ${e instanceof Error ? e.stack : String(e)}\n`); process.exit(2); });
