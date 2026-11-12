import { Injectable } from "@nestjs/common";
import { Decimal, DomainError, type Permission } from "@medos/shared";
import { z } from "zod";
import { actorOf, AuditService } from "../../common/audit.service";
import { PrismaService } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { admissionScopeSql, visitScopeSql } from "../../common/data-scope";
import { dateOnly, endOfLocalDay, localDateStr, startOfLocalDay } from "../../common/time";
import { balanceDue, fmt } from "../billing/billing.domain";
import { doctorShare, pickRule, type EarningKind, type ShareRule } from "../earnings/earnings.domain";
import { EarningsService } from "../earnings/earnings.service";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => !Number.isNaN(dateOnly(s).getTime()) && dateOnly(s).toISOString().startsWith(s), "Invalid date");
const MAX_DAYS = 93;

export const rangeSchema = z.object({ from: day.optional(), to: day.optional() }).strict();
export const expirySchema = z.object({ withinDays: z.coerce.number().int().min(1).max(730).default(90) }).strict();
export const outstandingSchema = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25) }).strict();

/** What a person is recording when they download a report as a file (the file itself is built on their computer, so the server is told). */
export const exportLogSchema = z.object({ report: z.string().regex(/^[a-z-]{2,30}$/), from: day.optional(), to: day.optional(), rows: z.number().int().min(0).max(1_000_000) }).strict();

/** The permission that opens each report on the Reports page; REPORT_READ opens all of them except a doctor's own "my" reports. */
const EXPORT_PERMISSION: Record<string, Permission> = {
  "bookings-earnings": "REPORT_FINANCE", "my-bookings": "REPORT_MY_PRACTICE", "my-payouts": "REPORT_MY_PRACTICE",
  "opd-daily": "REPORT_OPD", "opd-doctor": "REPORT_OPD", "opd-dept": "REPORT_OPD",
  collections: "REPORT_FINANCE", registrations: "REPORT_FINANCE", "fee-skips": "REPORT_FINANCE", shifts: "REPORT_FINANCE", outstanding: "REPORT_FINANCE",
  "cur-adm": "REPORT_IPD", "adm-dis": "REPORT_IPD", "discharge-tat": "REPORT_IPD", occupancy: "REPORT_IPD",
  sales: "REPORT_PHARMACY", "consumption-cost": "REPORT_PHARMACY", movement: "REPORT_PHARMACY", stock: "REPORT_PHARMACY", low: "REPORT_PHARMACY", expiry: "REPORT_PHARMACY",
};

interface Range { from: string; to: string; start: Date; end: Date; tz: string }

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService, private readonly earnings: EarningsService, private readonly audit: AuditService) {}

  /** Writes "report exported" to the audit trail: who, which report, which dates, how many rows. The rows themselves are never stored. */
  async logExport(ctx: RequestContext, q: z.infer<typeof exportLogSchema>): Promise<{ logged: true }> {
    const need = EXPORT_PERMISSION[q.report];
    if (!need) throw new DomainError("VALIDATION_FAILED", "Unknown report", 400);
    const mayOpen = ctx.permissions.has(need) || (need !== "REPORT_MY_PRACTICE" && ctx.permissions.has("REPORT_READ"));
    if (!mayOpen) throw new DomainError("FORBIDDEN", "You do not have permission to perform this action", 403);
    await this.audit.recordStandalone(actorOf(ctx), { action: "REPORT_EXPORTED", entityType: "Report", metadata: { report: q.report, ...(q.from ? { from: q.from } : {}), ...(q.to ? { to: q.to } : {}), rows: q.rows } });
    return { logged: true };
  }

  /** Facility-local calendar range (default: today). Bounds are converted to UTC instants once. */
  private async range(ctx: RequestContext, q: z.infer<typeof rangeSchema>): Promise<Range> {
    const f = await this.prisma.facility.findFirstOrThrow({ where: { id: ctx.facilityId, tenantId: ctx.tenantId }, select: { timezone: true } });
    const today = localDateStr(new Date(), f.timezone);
    const from = q.from ?? q.to ?? today;
    const to = q.to ?? q.from ?? today;
    if (from > to) throw new DomainError("VALIDATION_FAILED", "The start date must not be after the end date", 400);
    if ((dateOnly(to).getTime() - dateOnly(from).getTime()) / 86_400_000 >= MAX_DAYS) throw new DomainError("VALIDATION_FAILED", `Choose a range of at most ${MAX_DAYS} days`, 400);
    return { from, to, start: startOfLocalDay(from, f.timezone), end: endOfLocalDay(to, f.timezone), tz: f.timezone };
  }

  // ───── OPD ─────

  async opdDaily(ctx: RequestContext, q: z.infer<typeof rangeSchema>) {
    const r = await this.range(ctx, q);
    const rows = await this.prisma.$queryRaw<{ day: string; visits: number; completed: number }[]>`
      SELECT to_char(("startedAt" AT TIME ZONE ${r.tz})::date, 'YYYY-MM-DD') AS day, COUNT(*)::int AS visits, COUNT(*) FILTER (WHERE status = 'COMPLETED')::int AS completed
      FROM "Encounter" e WHERE e."tenantId" = ${ctx.tenantId}::uuid AND e."facilityId" = ${ctx.facilityId}::uuid AND e.type = 'OPD' AND e.status <> 'CANCELLED'
        AND e."startedAt" >= ${r.start} AND e."startedAt" < ${r.end} ${visitScopeSql(ctx, "e")} GROUP BY 1 ORDER BY 1`;
    return { from: r.from, to: r.to, total: rows.reduce((n, x) => n + x.visits, 0), days: rows };
  }

  async opdByDoctor(ctx: RequestContext, q: z.infer<typeof rangeSchema>) {
    const r = await this.range(ctx, q);
    const rows = await this.prisma.$queryRaw<{ practitionerId: string | null; doctor: string | null; visits: number; completed: number }[]>`
      SELECT e."practitionerId" AS "practitionerId", p."displayName" AS doctor, COUNT(*)::int AS visits, COUNT(*) FILTER (WHERE e.status = 'COMPLETED')::int AS completed
      FROM "Encounter" e LEFT JOIN "Practitioner" p ON p.id = e."practitionerId" AND p."tenantId" = e."tenantId"
      WHERE e."tenantId" = ${ctx.tenantId}::uuid AND e."facilityId" = ${ctx.facilityId}::uuid AND e.type = 'OPD' AND e.status <> 'CANCELLED'
        AND e."startedAt" >= ${r.start} AND e."startedAt" < ${r.end} ${visitScopeSql(ctx, "e")} GROUP BY 1, 2 ORDER BY visits DESC, doctor`;
    return { from: r.from, to: r.to, rows };
  }

  async opdByDepartment(ctx: RequestContext, q: z.infer<typeof rangeSchema>) {
    const r = await this.range(ctx, q);
    const rows = await this.prisma.$queryRaw<{ departmentId: string | null; department: string | null; visits: number; completed: number }[]>`
      SELECT e."departmentId" AS "departmentId", d.name AS department, COUNT(*)::int AS visits, COUNT(*) FILTER (WHERE e.status = 'COMPLETED')::int AS completed
      FROM "Encounter" e LEFT JOIN "Department" d ON d.id = e."departmentId" AND d."tenantId" = e."tenantId"
      WHERE e."tenantId" = ${ctx.tenantId}::uuid AND e."facilityId" = ${ctx.facilityId}::uuid AND e.type = 'OPD' AND e.status <> 'CANCELLED'
        AND e."startedAt" >= ${r.start} AND e."startedAt" < ${r.end} ${visitScopeSql(ctx, "e")} GROUP BY 1, 2 ORDER BY visits DESC, department`;
    return { from: r.from, to: r.to, rows };
  }

  // ───── money ─────

  /** Receipts received minus refunds paid, per local day and per payment mode. Credit notes are not cash and are shown separately. */
  async collections(ctx: RequestContext, q: z.infer<typeof rangeSchema>) {
    const r = await this.range(ctx, q);
    const t = ctx.tenantId;
    const f = ctx.facilityId;
    const [received, refunded, byMode, credits] = await Promise.all([
      this.prisma.$queryRaw<{ day: string; amount: string }[]>`
        SELECT day, COALESCE(SUM(amount), 0)::numeric(14,2)::text AS amount FROM (
          SELECT to_char((r."receivedAt" AT TIME ZONE ${r.tz})::date, 'YYYY-MM-DD') AS day, p.amount
          FROM "Payment" p JOIN "Receipt" r ON r.id = p."receiptId" AND r."tenantId" = p."tenantId"
          WHERE r."tenantId" = ${t}::uuid AND r."facilityId" = ${f}::uuid AND r."receivedAt" >= ${r.start} AND r."receivedAt" < ${r.end} AND p."advanceUseId" IS NULL
          UNION ALL
          SELECT to_char(("receivedAt" AT TIME ZONE ${r.tz})::date, 'YYYY-MM-DD'), amount
          FROM "AdvanceDeposit" WHERE "tenantId" = ${t}::uuid AND "facilityId" = ${f}::uuid AND "receivedAt" >= ${r.start} AND "receivedAt" < ${r.end}
        ) x GROUP BY day`,
      this.prisma.$queryRaw<{ day: string; amount: string }[]>`
        SELECT day, COALESCE(SUM(amount), 0)::numeric(14,2)::text AS amount FROM (
          SELECT to_char(("createdAt" AT TIME ZONE ${r.tz})::date, 'YYYY-MM-DD') AS day, amount - "advanceReturned" AS amount
          FROM "Refund" WHERE "tenantId" = ${t}::uuid AND "facilityId" = ${f}::uuid AND "createdAt" >= ${r.start} AND "createdAt" < ${r.end}
          UNION ALL
          SELECT to_char(("createdAt" AT TIME ZONE ${r.tz})::date, 'YYYY-MM-DD'), amount
          FROM "AdvanceRefund" WHERE "tenantId" = ${t}::uuid AND "facilityId" = ${f}::uuid AND "createdAt" >= ${r.start} AND "createdAt" < ${r.end}
        ) x GROUP BY day`,
      this.prisma.$queryRaw<{ method: string; received: string; refunded: string }[]>`
        SELECT m.method::text AS method, COALESCE(rc.amount, 0)::numeric(14,2)::text AS received, COALESCE(rf.amount, 0)::numeric(14,2)::text AS refunded
        FROM (SELECT unnest(enum_range(NULL::"PaymentMethod")) AS method) m
        LEFT JOIN (SELECT method, SUM(amount) AS amount FROM (
                     SELECT p.method, p.amount FROM "Payment" p JOIN "Receipt" r ON r.id = p."receiptId" AND r."tenantId" = p."tenantId"
                     WHERE r."tenantId" = ${t}::uuid AND r."facilityId" = ${f}::uuid AND r."receivedAt" >= ${r.start} AND r."receivedAt" < ${r.end} AND p."advanceUseId" IS NULL
                     UNION ALL
                     SELECT a.method, a.amount FROM "AdvanceTender" a JOIN "AdvanceDeposit" d ON d.id = a."depositId" AND d."tenantId" = a."tenantId"
                     WHERE d."tenantId" = ${t}::uuid AND d."facilityId" = ${f}::uuid AND d."receivedAt" >= ${r.start} AND d."receivedAt" < ${r.end}
                   ) y GROUP BY method) rc ON rc.method = m.method
        LEFT JOIN (SELECT method, SUM(amount) AS amount FROM (
                     SELECT method, amount - "advanceReturned" AS amount FROM "Refund" WHERE "tenantId" = ${t}::uuid AND "facilityId" = ${f}::uuid AND "createdAt" >= ${r.start} AND "createdAt" < ${r.end}
                     UNION ALL
                     SELECT method, amount FROM "AdvanceRefund" WHERE "tenantId" = ${t}::uuid AND "facilityId" = ${f}::uuid AND "createdAt" >= ${r.start} AND "createdAt" < ${r.end}
                   ) z GROUP BY method) rf ON rf.method = m.method
        ORDER BY m.method`,
      this.prisma.$queryRaw<{ amount: string }[]>`
        SELECT COALESCE(SUM(amount), 0)::numeric(14,2)::text AS amount FROM "CreditNote" WHERE "tenantId" = ${t}::uuid AND "facilityId" = ${f}::uuid AND "createdAt" >= ${r.start} AND "createdAt" < ${r.end}`,
    ]);
    const days = new Map<string, { day: string; received: string; refunded: string }>();
    for (const x of received) days.set(x.day, { day: x.day, received: x.amount, refunded: "0.00" });
    for (const x of refunded) days.set(x.day, { day: x.day, received: days.get(x.day)?.received ?? "0.00", refunded: x.amount });
    const dayRows = [...days.values()].sort((a, b) => a.day.localeCompare(b.day)).map((d) => ({ ...d, net: fmt(new Decimal(d.received).minus(d.refunded)) }));
    const totalReceived = byMode.reduce((n, m) => n.plus(m.received), new Decimal(0));
    const totalRefunded = byMode.reduce((n, m) => n.plus(m.refunded), new Decimal(0));
    return {
      from: r.from, to: r.to, days: dayRows,
      byMode: byMode.map((m) => ({ ...m, net: fmt(new Decimal(m.received).minus(m.refunded)) })),
      totals: { received: fmt(totalReceived), refunded: fmt(totalRefunded), net: fmt(totalReceived.minus(totalRefunded)), creditNotes: credits[0]?.amount ?? "0.00" },
    };
  }

  /**
   * Patient registrations of the period with their registration fee: who was registered, by whom, the bill, the receipt, how it was paid and whether it was
   * paid, exempted (with the reason) or is still due. Read by the Cashier, Manager and Administrator; it is live data, so a registration at Reception shows here at once.
   */
  async registrations(ctx: RequestContext, q: z.infer<typeof rangeSchema>) {
    const r = await this.range(ctx, q);
    const where = { tenantId: ctx.tenantId, facilityId: ctx.facilityId };
    const rows = await this.prisma.patientRegistration.findMany({
      where: { ...where, createdAt: { gte: r.start, lt: r.end } }, orderBy: { createdAt: "desc" }, take: 1000,
      include: {
        patient: { select: { id: true, firstName: true, lastName: true, mobile: true, identifiers: { where: { type: "MRN" }, select: { value: true } } } },
        invoice: { select: { id: true, invoiceNumber: true, status: true, total: true, paidTotal: true, refundedTotal: true, receipts: { orderBy: { receivedAt: "asc" }, select: { id: true, receiptNumber: true, payments: { select: { method: true, amount: true } } } } } },
      },
    });
    const ids = [...new Set(rows.flatMap((x) => [x.createdById, x.settledById].filter((v): v is string => !!v)))];
    const users = new Map((await this.prisma.user.findMany({ where: { tenantId: ctx.tenantId, id: { in: ids } }, select: { id: true, fullName: true } })).map((u) => [u.id, u.fullName]));
    const zero = new Decimal(0);
    const byMethod = new Map<string, Decimal>();
    let collected = zero; let exempted = zero; let pending = zero;
    const count = { paid: 0, exempted: 0, pending: 0 };
    const out = rows.map((x) => {
      const pays = x.invoice?.receipts.flatMap((rc) => rc.payments) ?? [];
      const net = x.invoice ? new Decimal(x.invoice.paidTotal.toString()).minus(x.invoice.refundedTotal.toString()) : zero;
      if (x.status === "PAID") { count.paid += 1; collected = collected.plus(net); for (const p of pays) byMethod.set(p.method, (byMethod.get(p.method) ?? zero).plus(p.amount.toString())); }
      else if (x.status === "EXEMPTED") { count.exempted += 1; exempted = exempted.plus(x.amount.toString()); }
      else { count.pending += 1; pending = pending.plus(x.amount.toString()); }
      return {
        registeredAt: x.createdAt, patientId: x.patientId, patient: [x.patient.firstName, x.patient.lastName].filter(Boolean).join(" "), mrn: x.patient.identifiers[0]?.value ?? null, mobile: x.patient.mobile,
        registeredBy: users.get(x.createdById) ?? null, status: x.status, fee: fmt(x.amount.toString()), amountPaid: x.status === "PAID" ? fmt(net) : "0.00",
        paymentMethods: pays.map((p) => `${p.method} ${fmt(p.amount.toString())}`).join(" + ") || null, invoiceId: x.invoice?.id ?? null, invoiceNumber: x.invoice?.invoiceNumber ?? null, invoiceStatus: x.invoice?.status ?? null,
        receiptId: x.invoice?.receipts[0]?.id ?? null, receiptNumber: x.invoice?.receipts[0]?.receiptNumber ?? null,
        exemptionReason: x.exemptionReason, settledBy: (x.settledById && users.get(x.settledById)) || null, settledAt: x.settledAt,
      };
    });
    const due = await this.prisma.patientRegistration.aggregate({ where: { ...where, status: "PENDING" }, _count: true, _sum: { amount: true } });
    return {
      from: r.from, to: r.to,
      totals: { registrations: rows.length, paid: count.paid, exempted: count.exempted, pending: count.pending, collected: fmt(collected), exemptedAmount: fmt(exempted), pendingAmount: fmt(pending) },
      byMethod: [...byMethod.entries()].map(([method, amount]) => ({ method, amount: fmt(amount) })),
      /** Every registration fee still waiting to be collected, whatever its date. */
      stillDue: { count: due._count, amount: fmt(due._sum.amount?.toString() ?? 0) },
      rows: out,
    };
  }

  /** Booking fees that were skipped in the period, with who skipped them and why, so special cases can be reviewed. */
  async bookingFeeSkips(ctx: RequestContext, q: z.infer<typeof rangeSchema>) {
    const r = await this.range(ctx, q);
    const rows = await this.prisma.appointment.findMany({
      where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, feeSkippedAt: { gte: r.start, lt: r.end } },
      orderBy: { feeSkippedAt: "asc" }, take: 2000,
      select: { feeSkippedAt: true, startAt: true, bookingFee: true, feeSkipReason: true, feeSkipNote: true, feeSkippedById: true, patient: { select: { firstName: true, lastName: true, identifiers: { where: { type: "MRN" }, select: { value: true } } } } },
    });
    const users = await this.prisma.user.findMany({ where: { tenantId: ctx.tenantId, id: { in: [...new Set(rows.map((x) => x.feeSkippedById).filter((x): x is string => !!x))] } }, select: { id: true, fullName: true } });
    const name = new Map(users.map((u) => [u.id, u.fullName]));
    const byReason = new Map<string, { reason: string; count: number; amount: Decimal }>();
    let total = new Decimal(0);
    for (const x of rows) {
      const fee = new Decimal(x.bookingFee?.toString() ?? 0);
      total = total.plus(fee);
      const g = byReason.get(x.feeSkipReason ?? "") ?? { reason: x.feeSkipReason ?? "", count: 0, amount: new Decimal(0) };
      g.count += 1; g.amount = g.amount.plus(fee); byReason.set(g.reason, g);
    }
    return {
      from: r.from, to: r.to, skipped: rows.length, feeNotCollected: fmt(total),
      byReason: [...byReason.values()].sort((a, b) => b.count - a.count).map((g) => ({ reason: g.reason, count: g.count, amount: fmt(g.amount) })),
      rows: rows.map((x) => ({
        skippedAt: x.feeSkippedAt, appointmentAt: x.startAt, patient: [x.patient.firstName, x.patient.lastName].filter(Boolean).join(" "), mrn: x.patient.identifiers[0]?.value ?? null,
        fee: fmt(x.bookingFee?.toString() ?? 0), reason: x.feeSkipReason, note: x.feeSkipNote, skippedBy: (x.feeSkippedById && name.get(x.feeSkippedById)) || null,
      })),
    };
  }

  /** Everyone's shifts for holders of REPORT_READ; otherwise (a cashier with REPORT_FINANCE) only the caller's own shifts. */
  async shifts(ctx: RequestContext, q: z.infer<typeof rangeSchema>) {
    const r = await this.range(ctx, q);
    const ownOnly = !ctx.permissions.has("REPORT_READ");
    const rows = await this.prisma.$queryRaw<{
      id: string; cashier: string | null; status: string; openedAt: Date; closedAt: Date | null; openingCash: string; receipts: string; cashReceived: string; cashRefunded: string;
      expectedCash: string | null; actualCash: string | null; difference: string | null;
    }[]>`
      SELECT s.id, u."fullName" AS cashier, s.status::text AS status, s."openedAt", s."closedAt", s."openingCash"::numeric(14,2)::text AS "openingCash",
        (COALESCE((SELECT SUM(p.amount) FROM "Payment" p JOIN "Receipt" r ON r.id = p."receiptId" AND r."tenantId" = p."tenantId" WHERE r."shiftId" = s.id AND r."tenantId" = s."tenantId" AND p."advanceUseId" IS NULL), 0)
          + COALESCE((SELECT SUM(d.amount) FROM "AdvanceDeposit" d WHERE d."shiftId" = s.id AND d."tenantId" = s."tenantId"), 0))::numeric(14,2)::text AS receipts,
        (COALESCE((SELECT SUM(p.amount) FROM "Payment" p JOIN "Receipt" r ON r.id = p."receiptId" AND r."tenantId" = p."tenantId" WHERE r."shiftId" = s.id AND r."tenantId" = s."tenantId" AND p.method = 'CASH' AND p."advanceUseId" IS NULL), 0)
          + COALESCE((SELECT SUM(a.amount) FROM "AdvanceTender" a JOIN "AdvanceDeposit" d ON d.id = a."depositId" AND d."tenantId" = a."tenantId" WHERE d."shiftId" = s.id AND d."tenantId" = s."tenantId" AND a.method = 'CASH'), 0))::numeric(14,2)::text AS "cashReceived",
        (COALESCE((SELECT SUM(f.amount) FROM "Refund" f WHERE f."shiftId" = s.id AND f."tenantId" = s."tenantId" AND f.method = 'CASH'), 0)
          + COALESCE((SELECT SUM(f.amount) FROM "AdvanceRefund" f WHERE f."shiftId" = s.id AND f."tenantId" = s."tenantId" AND f.method = 'CASH'), 0))::numeric(14,2)::text AS "cashRefunded",
        s."expectedCash"::numeric(14,2)::text AS "expectedCash", s."actualCash"::numeric(14,2)::text AS "actualCash", s.difference::numeric(14,2)::text AS difference
      FROM "CashierShift" s LEFT JOIN "User" u ON u.id = s."cashierId" AND u."tenantId" = s."tenantId"
      WHERE s."tenantId" = ${ctx.tenantId}::uuid AND s."facilityId" = ${ctx.facilityId}::uuid AND s."openedAt" >= ${r.start} AND s."openedAt" < ${r.end}
        AND (NOT ${ownOnly}::boolean OR s."cashierId" = ${ctx.userId}::uuid) ORDER BY s."openedAt"`;
    return { from: r.from, to: r.to, scope: ownOnly ? "Your shifts only" : "All cashiers", rows };
  }

  async outstanding(ctx: RequestContext, q: z.infer<typeof outstandingSchema>) {
    const where = { tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: { in: ["ISSUED", "PARTIALLY_PAID"] as ("ISSUED" | "PARTIALLY_PAID")[] } };
    const [rows, total] = await Promise.all([
      this.prisma.invoice.findMany({
        where, orderBy: [{ issuedAt: "asc" }, { id: "asc" }], skip: (q.page - 1) * q.pageSize, take: q.pageSize,
        select: { id: true, invoiceNumber: true, issuedAt: true, total: true, paidTotal: true, refundedTotal: true, creditedTotal: true, patient: { select: { firstName: true, lastName: true } } },
      }),
      this.prisma.invoice.count({ where }),
    ]);
    const items = rows.map((i) => ({
      id: i.id, invoiceNumber: i.invoiceNumber, issuedAt: i.issuedAt, patientName: [i.patient.firstName, i.patient.lastName].filter(Boolean).join(" "),
      total: fmt(i.total), balanceDue: fmt(balanceDue(i)),
    }));
    const agg = await this.prisma.$queryRaw<{ due: string }[]>`
      SELECT COALESCE(SUM(GREATEST(0, (total - "creditedTotal") - ("paidTotal" - "refundedTotal"))), 0)::numeric(14,2)::text AS due
      FROM "Invoice" WHERE "tenantId" = ${ctx.tenantId}::uuid AND "facilityId" = ${ctx.facilityId}::uuid AND status IN ('ISSUED', 'PARTIALLY_PAID')`;
    return { items, total, totalDue: agg[0]?.due ?? "0.00" };
  }

  // ───── IPD ─────

  async currentAdmissions(ctx: RequestContext) {
    const rows = await this.prisma.$queryRaw<{ id: string; admissionNumber: string; patientName: string; mrn: string | null; ward: string | null; bed: string | null; consultant: string | null; admittedAt: Date; days: number }[]>`
      SELECT a.id, a."admissionNumber", trim(p."firstName" || ' ' || COALESCE(p."lastName", '')) AS "patientName",
        (SELECT value FROM "PatientIdentifier" i WHERE i."patientId" = p.id AND i."tenantId" = p."tenantId" AND i.type = 'MRN' LIMIT 1) AS mrn,
        w.name AS ward, b.code AS bed, pr."displayName" AS consultant, a."admittedAt", GREATEST(1, CEIL(EXTRACT(EPOCH FROM (now() - a."admittedAt")) / 86400))::int AS days
      FROM "Admission" a JOIN "Patient" p ON p.id = a."patientId" AND p."tenantId" = a."tenantId"
      LEFT JOIN "BedAssignment" ba ON ba."admissionId" = a.id AND ba."tenantId" = a."tenantId" AND ba."releasedAt" IS NULL
      LEFT JOIN "Bed" b ON b.id = ba."bedId" AND b."tenantId" = a."tenantId" LEFT JOIN "Ward" w ON w.id = b."wardId" AND w."tenantId" = a."tenantId"
      LEFT JOIN "Practitioner" pr ON pr.id = a."consultantId" AND pr."tenantId" = a."tenantId"
      WHERE a."tenantId" = ${ctx.tenantId}::uuid AND a."facilityId" = ${ctx.facilityId}::uuid AND a.status = 'ADMITTED' ${admissionScopeSql(ctx)} ORDER BY a."admittedAt"`;
    return { total: rows.length, rows };
  }

  /** Admissions and discharges per local day. Cancelled admissions are excluded. */
  async admissionsAndDischarges(ctx: RequestContext, q: z.infer<typeof rangeSchema>) {
    const r = await this.range(ctx, q);
    const [adm, dis] = await Promise.all([
      this.prisma.$queryRaw<{ day: string; count: number }[]>`
        SELECT to_char(("admittedAt" AT TIME ZONE ${r.tz})::date, 'YYYY-MM-DD') AS day, COUNT(*)::int AS count FROM "Admission" a
        WHERE a."tenantId" = ${ctx.tenantId}::uuid AND a."facilityId" = ${ctx.facilityId}::uuid AND a.status <> 'CANCELLED' AND a."admittedAt" >= ${r.start} AND a."admittedAt" < ${r.end} ${admissionScopeSql(ctx)} GROUP BY 1`,
      this.prisma.$queryRaw<{ day: string; count: number }[]>`
        SELECT to_char(("dischargedAt" AT TIME ZONE ${r.tz})::date, 'YYYY-MM-DD') AS day, COUNT(*)::int AS count FROM "Admission" a
        WHERE a."tenantId" = ${ctx.tenantId}::uuid AND a."facilityId" = ${ctx.facilityId}::uuid AND a.status = 'DISCHARGED' AND a."dischargedAt" >= ${r.start} AND a."dischargedAt" < ${r.end} ${admissionScopeSql(ctx)} GROUP BY 1`,
    ]);
    const days = [...new Set([...adm.map((x) => x.day), ...dis.map((x) => x.day)])].sort();
    return {
      from: r.from, to: r.to, totalAdmissions: adm.reduce((n, x) => n + x.count, 0), totalDischarges: dis.reduce((n, x) => n + x.count, 0),
      days: days.map((d) => ({ day: d, admissions: adm.find((x) => x.day === d)?.count ?? 0, discharges: dis.find((x) => x.day === d)?.count ?? 0 })),
    };
  }

  /**
   * Discharge turnaround (docs/discharge-stages.md): for stays discharged in the range, how long each part of the discharge took, from the doctor's advice to the bed being ready,
   * with the average, median and slowest tenth for each part, and the stage that was slowest to clear. Times come from the records the checklist already keeps.
   */
  async dischargeTurnaround(ctx: RequestContext, q: z.infer<typeof rangeSchema>) {
    const r = await this.range(ctx, q);
    const rows = await this.prisma.$queryRaw<{ id: string; admissionNumber: string; dischargedAt: Date; clearances: Record<string, string> | null; summarySignedAt: Date | null; summaryVerifiedAt: Date | null; billIssuedAt: Date | null; paidAt: Date | null; departedAt: Date | null; bedReadyAt: Date | null }[]>`
      SELECT a.id, a."admissionNumber", a."dischargedAt",
        (SELECT jsonb_object_agg(c.step::text, c.at) FROM "DischargeClearance" c WHERE c."admissionId" = a.id AND c."tenantId" = a."tenantId") AS clearances,
        (SELECT d."signedAt" FROM "ClinicalDocument" d WHERE d."encounterId" = a."encounterId" AND d."tenantId" = a."tenantId" AND d.kind = 'DISCHARGE_SUMMARY') AS "summarySignedAt",
        (SELECT min(v.at) FROM "DischargeSummaryVerification" v WHERE v."admissionId" = a.id AND v."tenantId" = a."tenantId") AS "summaryVerifiedAt",
        (SELECT i."issuedAt" FROM "Invoice" i WHERE i.id = a."finalInvoiceId" AND i."tenantId" = a."tenantId") AS "billIssuedAt",
        (SELECT max(rc."receivedAt") FROM "Receipt" rc WHERE rc."invoiceId" = a."finalInvoiceId" AND rc."tenantId" = a."tenantId") AS "paidAt",
        (SELECT dep."departedAt" FROM "AdmissionDeparture" dep WHERE dep."admissionId" = a.id AND dep."tenantId" = a."tenantId") AS "departedAt",
        (SELECT t."readyAt" FROM "BedTurnover" t WHERE t."admissionId" = a.id AND t."tenantId" = a."tenantId") AS "bedReadyAt"
      FROM "Admission" a
      WHERE a."tenantId" = ${ctx.tenantId}::uuid AND a."facilityId" = ${ctx.facilityId}::uuid AND a.status = 'DISCHARGED' AND a."dischargedAt" >= ${r.start} AND a."dischargedAt" < ${r.end} ${admissionScopeSql(ctx)}
      ORDER BY a."dischargedAt" DESC, a.id LIMIT 1000`;
    // Lab, OT and insurance clear on their own and keep no time of their own, so only the stages that do are measured.
    const STEPS: [string, string][] = [["NURSING", "Nursing clearance"], ["CHARGES_REVIEWED", "Charges review"], ["PHARMACY", "Pharmacy clearance"], ["BILLING", "Final bill issued"], ["FINANCIAL_RELEASE", "Dues paid or released"]];
    const mins = (from: Date | string | null | undefined, to: Date | string | null | undefined): number | null => {
      if (!from || !to) return null;
      const d = (new Date(to).getTime() - new Date(from).getTime()) / 60_000;
      return Number.isFinite(d) ? Math.max(0, Math.round(d)) : null;
    };
    const acc = new Map<string, number[]>();
    const add = (k: string, v: number | null) => { if (v !== null) (acc.get(k) ?? acc.set(k, []).get(k)!).push(v); };
    const out = rows.map((a) => {
      const cl: Record<string, string | Date | null> = { ...(a.clearances ?? {}) };
      // The final bill and the payment are timed from the bill and its receipts (a waived release, which has its own time, takes precedence).
      if (a.billIssuedAt) cl["BILLING"] = a.billIssuedAt;
      if (!cl["FINANCIAL_RELEASE"] && a.paidAt) cl["FINANCIAL_RELEASE"] = a.paidAt;
      const advised = (cl["MEDICALLY_FIT"] as string | Date | null | undefined) ?? null;
      const times = STEPS.map(([s]) => cl[s]).filter((x): x is string | Date => !!x);
      const allCleared = times.length ? times.reduce((m, x) => (new Date(x) > new Date(m) ? x : m)) : null;
      for (const [s] of STEPS) add(s, mins(advised, cl[s]));
      const m = {
        summary: mins(advised, a.summarySignedAt), verify: mins(a.summarySignedAt, a.summaryVerifiedAt), cleared: mins(advised, allCleared), toDischarge: mins(allCleared ?? advised, a.dischargedAt),
        advice: mins(advised, a.dischargedAt), exit: mins(a.dischargedAt, a.departedAt), bed: mins(a.departedAt, a.bedReadyAt), total: mins(advised, a.bedReadyAt),
      };
      add("SUMMARY", m.summary); add("VERIFY", m.verify); add("CLEARED", m.cleared); add("TO_DISCHARGE", m.toDischarge); add("ADVICE", m.advice); add("EXIT", m.exit); add("BED", m.bed); add("TOTAL", m.total);
      return { admissionNumber: a.admissionNumber, dischargedAt: a.dischargedAt, adviceToDischargeMinutes: m.advice, dischargeToDepartureMinutes: m.exit, departureToBedReadyMinutes: m.bed, adviceToBedReadyMinutes: m.total };
    });
    const stat = (key: string, label: string) => {
      const v = [...(acc.get(key) ?? [])].sort((x, y) => x - y);
      const at = (p: number) => v[Math.min(v.length - 1, Math.max(0, Math.ceil(p * v.length) - 1))] ?? null;
      return { stage: label, cases: v.length, averageMinutes: v.length ? Math.round((v.reduce((n, x) => n + x, 0) / v.length) * 10) / 10 : null, medianMinutes: v.length ? (v.length % 2 ? v[(v.length - 1) / 2]! : Math.round(((v[v.length / 2 - 1]! + v[v.length / 2]!) / 2) * 10) / 10) : null, slowestTenthMinutes: at(0.9) };
    };
    const clearing = STEPS.map(([k, label]) => stat(k, `${label}, after the doctor's advice`));
    const slowest = clearing.filter((s) => s.cases > 0).sort((a, b) => (b.medianMinutes ?? 0) - (a.medianMinutes ?? 0))[0];
    return {
      from: r.from, to: r.to, discharges: rows.length, slowestToClear: slowest ? slowest.stage.replace(", after the doctor's advice", "") : null,
      stages: [
        stat("SUMMARY", "Summary signed, after the doctor's advice"), stat("VERIFY", "Summary verified, after it was signed"), ...clearing, stat("CLEARED", "Every measured clearance done, after the doctor's advice"),
        stat("TO_DISCHARGE", "Discharge completed, after the last clearance"), stat("ADVICE", "Advice to discharge completed"), stat("EXIT", "Discharge completed to patient leaving"), stat("BED", "Patient leaving to bed ready"), stat("TOTAL", "Whole journey: advice to bed ready"),
      ],
      admissions: out,
    };
  }

  /**
   * Stock purchased, consumed and still held, at cost (docs/procurement.md): what was received (accepted into stock) in the range, what was used up by selling, ward issues,
   * procedures and department use, what was written off or returned to suppliers, and the value of the stock now in the main store and in the locations. Every figure is units
   * times the batch's purchase price (before GST) read from the stock ledgers, so it can be checked against them.
   */
  async consumptionCost(ctx: RequestContext, q: z.infer<typeof rangeSchema>) {
    const r = await this.range(ctx, q);
    const t = ctx.tenantId;
    const f = ctx.facilityId;
    const [bought, main, issues, uses, valueMain, valueLoc, byLocation, byProcedure] = await Promise.all([
      this.prisma.$queryRaw<{ units: number; rejected: number; cost: string }[]>`
        SELECT COALESCE(SUM(pi.quantity), 0)::int AS units, COALESCE(SUM(pi."rejectedQuantity"), 0)::int AS rejected, COALESCE(SUM(pi.quantity * pi."purchasePrice"), 0)::numeric(14,2)::text AS cost
        FROM "PurchaseItem" pi JOIN "Purchase" p ON p.id = pi."purchaseId" AND p."tenantId" = pi."tenantId"
        WHERE p."tenantId" = ${t}::uuid AND p."facilityId" = ${f}::uuid AND p."receivedAt" >= ${r.start} AND p."receivedAt" < ${r.end}`,
      this.prisma.$queryRaw<{ type: string; direction: string; units: number; cost: string }[]>`
        SELECT l.type::text AS type, l.direction::text AS direction, SUM(l.quantity)::int AS units, SUM(l.quantity * b."purchasePrice")::numeric(14,2)::text AS cost
        FROM "StockLedger" l JOIN "MedicineBatch" b ON b.id = l."batchId" AND b."tenantId" = l."tenantId"
        WHERE l."tenantId" = ${t}::uuid AND l."facilityId" = ${f}::uuid AND l."createdAt" >= ${r.start} AND l."createdAt" < ${r.end} AND l.type IN ('SALE', 'PATIENT_RETURN', 'DAMAGE', 'ADJUSTMENT', 'PURCHASE_RETURN')
        GROUP BY 1, 2`,
      this.prisma.$queryRaw<{ units: number; cost: string }[]>`
        SELECT COALESCE(SUM(i.quantity), 0)::int AS units, COALESCE(SUM(i.quantity * b."purchasePrice"), 0)::numeric(14,2)::text AS cost
        FROM "StockLocationIssue" i JOIN "MedicineBatch" b ON b.id = i."batchId" AND b."tenantId" = i."tenantId"
        WHERE i."tenantId" = ${t}::uuid AND i."facilityId" = ${f}::uuid AND i."createdAt" >= ${r.start} AND i."createdAt" < ${r.end}`,
      this.prisma.$queryRaw<{ kind: string; units: number; cost: string }[]>`
        SELECT c.kind::text AS kind, SUM(c.quantity)::int AS units, SUM(c."totalCost")::numeric(14,2)::text AS cost FROM "StockConsumption" c
        WHERE c."tenantId" = ${t}::uuid AND c."facilityId" = ${f}::uuid AND c."createdAt" >= ${r.start} AND c."createdAt" < ${r.end} GROUP BY 1`,
      this.prisma.$queryRaw<{ cost: string }[]>`
        SELECT COALESCE(SUM(sb.quantity * b."purchasePrice"), 0)::numeric(14,2)::text AS cost FROM "StockBalance" sb JOIN "MedicineBatch" b ON b.id = sb."batchId" AND b."tenantId" = sb."tenantId"
        WHERE sb."tenantId" = ${t}::uuid AND sb."facilityId" = ${f}::uuid`,
      this.prisma.$queryRaw<{ cost: string }[]>`
        SELECT COALESCE(SUM(lb.quantity * b."purchasePrice"), 0)::numeric(14,2)::text AS cost FROM "StockLocationBalance" lb JOIN "MedicineBatch" b ON b.id = lb."batchId" AND b."tenantId" = lb."tenantId"
        WHERE lb."tenantId" = ${t}::uuid AND lb."facilityId" = ${f}::uuid`,
      this.prisma.$queryRaw<{ location: string; wardIssues: string; procedures: string; departmentUse: string }[]>`
        SELECT s.name AS location,
          COALESCE((SELECT SUM(i.quantity * b."purchasePrice") FROM "StockLocationIssue" i JOIN "MedicineBatch" b ON b.id = i."batchId" AND b."tenantId" = i."tenantId" WHERE i."locationId" = s.id AND i."tenantId" = s."tenantId" AND i."createdAt" >= ${r.start} AND i."createdAt" < ${r.end}), 0)::numeric(14,2)::text AS "wardIssues",
          COALESCE((SELECT SUM(c."totalCost") FROM "StockConsumption" c WHERE c."locationId" = s.id AND c."tenantId" = s."tenantId" AND c.kind = 'PROCEDURE' AND c."createdAt" >= ${r.start} AND c."createdAt" < ${r.end}), 0)::numeric(14,2)::text AS procedures,
          COALESCE((SELECT SUM(c."totalCost") FROM "StockConsumption" c WHERE c."locationId" = s.id AND c."tenantId" = s."tenantId" AND c.kind = 'DEPARTMENT_USE' AND c."createdAt" >= ${r.start} AND c."createdAt" < ${r.end}), 0)::numeric(14,2)::text AS "departmentUse"
        FROM "StockLocation" s WHERE s."tenantId" = ${t}::uuid AND s."facilityId" = ${f}::uuid ORDER BY s.name`,
      this.prisma.$queryRaw<{ procedure: string; units: number; cost: string }[]>`
        SELECT p.name AS procedure, SUM(c.quantity)::int AS units, SUM(c."totalCost")::numeric(14,2)::text AS cost FROM "StockConsumption" c JOIN "Procedure" p ON p.id = c."procedureId" AND p."tenantId" = c."tenantId"
        WHERE c."tenantId" = ${t}::uuid AND c."facilityId" = ${f}::uuid AND c."createdAt" >= ${r.start} AND c."createdAt" < ${r.end} AND c.kind = 'PROCEDURE' GROUP BY p.name ORDER BY SUM(c."totalCost") DESC LIMIT 20`,
    ]);
    const D = (v: string | undefined) => new Decimal(v ?? "0");
    const pick = (type: string, direction: string) => main.find((m) => m.type === type && m.direction === direction);
    const sold = { units: (pick("SALE", "OUT")?.units ?? 0) - (pick("PATIENT_RETURN", "IN")?.units ?? 0), cost: D(pick("SALE", "OUT")?.cost).minus(D(pick("PATIENT_RETURN", "IN")?.cost)) };
    const procedures = uses.find((u) => u.kind === "PROCEDURE");
    const dept = uses.find((u) => u.kind === "DEPARTMENT_USE");
    const damaged = { units: pick("DAMAGE", "OUT")?.units ?? 0, cost: D(pick("DAMAGE", "OUT")?.cost) };
    const addedBy = { units: pick("ADJUSTMENT", "IN")?.units ?? 0, cost: D(pick("ADJUSTMENT", "IN")?.cost) };
    const removedBy = { units: pick("ADJUSTMENT", "OUT")?.units ?? 0, cost: D(pick("ADJUSTMENT", "OUT")?.cost) };
    const returned = { units: pick("PURCHASE_RETURN", "OUT")?.units ?? 0, cost: D(pick("PURCHASE_RETURN", "OUT")?.cost) };
    const used = sold.cost.plus(D(issues[0]?.cost)).plus(D(procedures?.cost)).plus(D(dept?.cost));
    return {
      from: r.from, to: r.to,
      received: { units: bought[0]?.units ?? 0, cost: fmt(D(bought[0]?.cost)), rejectedUnits: bought[0]?.rejected ?? 0 },
      soldToPatients: { units: sold.units, cost: fmt(sold.cost) },
      wardIssues: { units: issues[0]?.units ?? 0, cost: fmt(D(issues[0]?.cost)) },
      procedures: { units: procedures?.units ?? 0, cost: fmt(D(procedures?.cost)) },
      departmentUse: { units: dept?.units ?? 0, cost: fmt(D(dept?.cost)) },
      totalConsumptionCost: fmt(used),
      writtenOffDamaged: { units: damaged.units, cost: fmt(damaged.cost) },
      stockAddedByAdjustment: { units: addedBy.units, cost: fmt(addedBy.cost) },
      stockRemovedByAdjustment: { units: removedBy.units, cost: fmt(removedBy.cost) },
      returnedToSuppliers: { units: returned.units, cost: fmt(returned.cost) },
      stockValue: { mainStore: fmt(D(valueMain[0]?.cost)), locations: fmt(D(valueLoc[0]?.cost)), total: fmt(D(valueMain[0]?.cost).plus(D(valueLoc[0]?.cost))) },
      byLocation: byLocation.map((l) => ({ ...l, total: fmt(D(l.wardIssues).plus(D(l.procedures)).plus(D(l.departmentUse))) })),
      byProcedure,
    };
  }

  async bedOccupancy(ctx: RequestContext) {
    const rows = await this.prisma.$queryRaw<{ wardId: string; ward: string; total: number; available: number; occupied: number; reserved: number; cleaning: number; maintenance: number }[]>`
      SELECT w.id AS "wardId", w.name AS ward, COUNT(b.id)::int AS total,
        COUNT(*) FILTER (WHERE b.status = 'AVAILABLE')::int AS available, COUNT(*) FILTER (WHERE b.status = 'OCCUPIED')::int AS occupied,
        COUNT(*) FILTER (WHERE b.status = 'RESERVED')::int AS reserved, COUNT(*) FILTER (WHERE b.status = 'CLEANING')::int AS cleaning,
        COUNT(*) FILTER (WHERE b.status = 'MAINTENANCE')::int AS maintenance
      FROM "Ward" w JOIN "Bed" b ON b."wardId" = w.id AND b."tenantId" = w."tenantId" AND b.active = 'ACTIVE'
      WHERE w."tenantId" = ${ctx.tenantId}::uuid AND w."facilityId" = ${ctx.facilityId}::uuid GROUP BY w.id, w.name ORDER BY w.name`;
    const sum = (k: "total" | "occupied") => rows.reduce((n, x) => n + x[k], 0);
    const total = sum("total");
    const occupied = sum("occupied");
    return { wards: rows.map((x) => ({ ...x, occupancyPercent: x.total ? Math.round((x.occupied / x.total) * 1000) / 10 : 0 })), total, occupied, occupancyPercent: total ? Math.round((occupied / total) * 1000) / 10 : 0 };
  }

  // ───── pharmacy ─────

  async pharmacySales(ctx: RequestContext, q: z.infer<typeof rangeSchema>) {
    const r = await this.range(ctx, q);
    const t = ctx.tenantId;
    const f = ctx.facilityId;
    const [days, top] = await Promise.all([
      this.prisma.$queryRaw<{ day: string; dispenses: number; gross: string; returns: string }[]>`
        SELECT to_char((d."dispensedAt" AT TIME ZONE ${r.tz})::date, 'YYYY-MM-DD') AS day, COUNT(DISTINCT d.id)::int AS dispenses,
          COALESCE(SUM(i."lineTotal"), 0)::numeric(14,2)::text AS gross, COALESCE(SUM(i."returnedQuantity" * i."unitPrice"), 0)::numeric(14,2)::text AS returns
        FROM "Dispense" d JOIN "DispenseItem" i ON i."dispenseId" = d.id AND i."tenantId" = d."tenantId"
        WHERE d."tenantId" = ${t}::uuid AND d."facilityId" = ${f}::uuid AND d."dispensedAt" >= ${r.start} AND d."dispensedAt" < ${r.end} GROUP BY 1 ORDER BY 1`,
      this.prisma.$queryRaw<{ medicineId: string; medicine: string; quantity: number; amount: string }[]>`
        SELECT m.id AS "medicineId", trim(m."brandName" || ' ' || COALESCE(m.strength, '')) AS medicine, SUM(i.quantity - i."returnedQuantity")::int AS quantity,
          COALESCE(SUM((i.quantity - i."returnedQuantity") * i."unitPrice"), 0)::numeric(14,2)::text AS amount
        FROM "Dispense" d JOIN "DispenseItem" i ON i."dispenseId" = d.id AND i."tenantId" = d."tenantId" JOIN "Medicine" m ON m.id = i."medicineId" AND m."tenantId" = d."tenantId"
        WHERE d."tenantId" = ${t}::uuid AND d."facilityId" = ${f}::uuid AND d."dispensedAt" >= ${r.start} AND d."dispensedAt" < ${r.end}
        GROUP BY m.id, m."brandName", m.strength HAVING SUM(i.quantity - i."returnedQuantity") > 0 ORDER BY SUM((i.quantity - i."returnedQuantity") * i."unitPrice") DESC LIMIT 10`,
    ]);
    const gross = days.reduce((n, x) => n.plus(x.gross), new Decimal(0));
    const returns = days.reduce((n, x) => n.plus(x.returns), new Decimal(0));
    return {
      from: r.from, to: r.to, days: days.map((x) => ({ ...x, net: fmt(new Decimal(x.gross).minus(x.returns)) })), topMedicines: top,
      totals: { dispenses: days.reduce((n, x) => n + x.dispenses, 0), gross: fmt(gross), returns: fmt(returns), net: fmt(gross.minus(returns)) },
    };
  }

  /**
   * Units in and out per medicine over the range, by movement type, from the append-only stock ledger.
   * Closing = current balance minus everything recorded after the range; opening = closing minus the range's net movement.
   * (The database keeps StockBalance reconciled to the ledger, so only ledger rows from the range start onward are read.)
   */
  async stockMovement(ctx: RequestContext, q: z.infer<typeof rangeSchema>) {
    const r = await this.range(ctx, q);
    const t = ctx.tenantId;
    const f = ctx.facilityId;
    const rows = await this.prisma.$queryRaw<{
      medicineId: string; medicine: string; opening: number; purchased: number; patientReturns: number; adjustedIn: number; transferredIn: number;
      sold: number; returnedToSupplier: number; damaged: number; adjustedOut: number; transferredOut: number; totalIn: number; totalOut: number; closing: number;
    }[]>`
      WITH bal AS (
        SELECT "medicineId", SUM(quantity)::int AS qty FROM "StockBalance" WHERE "tenantId" = ${t}::uuid AND "facilityId" = ${f}::uuid GROUP BY 1
      ), mv AS (
        SELECT "medicineId",
          COALESCE(SUM(CASE WHEN direction = 'IN' THEN quantity ELSE -quantity END) FILTER (WHERE "createdAt" >= ${r.end}), 0)::int AS after,
          COALESCE(SUM(quantity) FILTER (WHERE "createdAt" < ${r.end} AND direction = 'IN'), 0)::int AS "totalIn",
          COALESCE(SUM(quantity) FILTER (WHERE "createdAt" < ${r.end} AND direction = 'OUT'), 0)::int AS "totalOut",
          COALESCE(SUM(quantity) FILTER (WHERE "createdAt" < ${r.end} AND direction = 'IN' AND type = 'PURCHASE'), 0)::int AS purchased,
          COALESCE(SUM(quantity) FILTER (WHERE "createdAt" < ${r.end} AND direction = 'IN' AND type = 'PATIENT_RETURN'), 0)::int AS "patientReturns",
          COALESCE(SUM(quantity) FILTER (WHERE "createdAt" < ${r.end} AND direction = 'IN' AND type = 'ADJUSTMENT'), 0)::int AS "adjustedIn",
          COALESCE(SUM(quantity) FILTER (WHERE "createdAt" < ${r.end} AND direction = 'IN' AND type = 'TRANSFER'), 0)::int AS "transferredIn",
          COALESCE(SUM(quantity) FILTER (WHERE "createdAt" < ${r.end} AND direction = 'OUT' AND type = 'SALE'), 0)::int AS sold,
          COALESCE(SUM(quantity) FILTER (WHERE "createdAt" < ${r.end} AND direction = 'OUT' AND type = 'PURCHASE_RETURN'), 0)::int AS "returnedToSupplier",
          COALESCE(SUM(quantity) FILTER (WHERE "createdAt" < ${r.end} AND direction = 'OUT' AND type = 'DAMAGE'), 0)::int AS damaged,
          COALESCE(SUM(quantity) FILTER (WHERE "createdAt" < ${r.end} AND direction = 'OUT' AND type = 'ADJUSTMENT'), 0)::int AS "adjustedOut",
          COALESCE(SUM(quantity) FILTER (WHERE "createdAt" < ${r.end} AND direction = 'OUT' AND type = 'TRANSFER'), 0)::int AS "transferredOut"
        FROM "StockLedger" WHERE "tenantId" = ${t}::uuid AND "facilityId" = ${f}::uuid AND "createdAt" >= ${r.start} GROUP BY 1
      )
      SELECT m.id AS "medicineId", trim(m."brandName" || ' ' || COALESCE(m.strength, '')) AS medicine,
        (COALESCE(bal.qty, 0) - COALESCE(mv.after, 0) - COALESCE(mv."totalIn", 0) + COALESCE(mv."totalOut", 0))::int AS opening,
        COALESCE(mv.purchased, 0) AS purchased, COALESCE(mv."patientReturns", 0) AS "patientReturns", COALESCE(mv."adjustedIn", 0) AS "adjustedIn",
        COALESCE(mv."transferredIn", 0) AS "transferredIn", COALESCE(mv.sold, 0) AS sold, COALESCE(mv."returnedToSupplier", 0) AS "returnedToSupplier",
        COALESCE(mv.damaged, 0) AS damaged, COALESCE(mv."adjustedOut", 0) AS "adjustedOut", COALESCE(mv."transferredOut", 0) AS "transferredOut",
        COALESCE(mv."totalIn", 0) AS "totalIn", COALESCE(mv."totalOut", 0) AS "totalOut",
        (COALESCE(bal.qty, 0) - COALESCE(mv.after, 0))::int AS closing
      FROM "Medicine" m LEFT JOIN bal ON bal."medicineId" = m.id LEFT JOIN mv ON mv."medicineId" = m.id
      WHERE m."tenantId" = ${t}::uuid AND (bal."medicineId" IS NOT NULL OR mv."medicineId" IS NOT NULL) ORDER BY medicine`;
    const moved = rows.filter((x) => x.opening !== 0 || x.closing !== 0 || x.totalIn !== 0 || x.totalOut !== 0);
    return { from: r.from, to: r.to, medicines: moved.length, rows: moved };
  }

  /**
   * Stock per medicine. `quantity` is the main store (what the pharmacy counter sells from); `inLocations` is what ward stores and other locations hold
   * (docs/stock-transfers.md); `total` is both. The value columns are at purchase price.
   */
  async currentStock(ctx: RequestContext) {
    const rows = await this.prisma.$queryRaw<{ medicineId: string; medicine: string; genericName: string; quantity: number; inLocations: number; total: number; batches: number; reorderLevel: number; value: string; locationValue: string }[]>`
      WITH loc AS (
        SELECT lb."medicineId", SUM(lb.quantity)::int AS qty, SUM(lb.quantity * b."purchasePrice")::numeric(14,2) AS value
        FROM "StockLocationBalance" lb JOIN "MedicineBatch" b ON b.id = lb."batchId" AND b."tenantId" = lb."tenantId"
        WHERE lb."tenantId" = ${ctx.tenantId}::uuid AND lb."facilityId" = ${ctx.facilityId}::uuid GROUP BY 1
      )
      SELECT m.id AS "medicineId", trim(m."brandName" || ' ' || COALESCE(m.strength, '')) AS medicine, m."genericName" AS "genericName",
        COALESCE(SUM(sb.quantity), 0)::int AS quantity, COALESCE(MAX(loc.qty), 0)::int AS "inLocations", (COALESCE(SUM(sb.quantity), 0) + COALESCE(MAX(loc.qty), 0))::int AS total,
        COUNT(sb."batchId") FILTER (WHERE sb.quantity > 0)::int AS batches, m."reorderLevel" AS "reorderLevel",
        COALESCE(SUM(sb.quantity * b."purchasePrice"), 0)::numeric(14,2)::text AS value, COALESCE(MAX(loc.value), 0)::numeric(14,2)::text AS "locationValue"
      FROM "Medicine" m LEFT JOIN "StockBalance" sb ON sb."medicineId" = m.id AND sb."tenantId" = m."tenantId" AND sb."facilityId" = ${ctx.facilityId}::uuid
      LEFT JOIN "MedicineBatch" b ON b.id = sb."batchId" AND b."tenantId" = sb."tenantId"
      LEFT JOIN loc ON loc."medicineId" = m.id
      WHERE m."tenantId" = ${ctx.tenantId}::uuid AND m.status = 'ACTIVE' GROUP BY m.id ORDER BY medicine`;
    return { rows, totalValue: fmt(rows.reduce((n, x) => n.plus(x.value).plus(x.locationValue), new Decimal(0))) };
  }

  /** Medicines at or below their reorder level in the main store (the counter's stock), with what the locations hold shown beside it. */
  async lowStock(ctx: RequestContext) {
    const { rows } = await this.currentStock(ctx);
    return { rows: rows.filter((x) => x.reorderLevel > 0 && x.quantity <= x.reorderLevel).map((x) => ({ medicineId: x.medicineId, medicine: x.medicine, quantity: x.quantity, inLocations: x.inLocations, total: x.total, reorderLevel: x.reorderLevel })) };
  }

  /** Batches holding stock that are expired or expire within the window (expired first), in the main store and in every location (the `place` column). */
  async nearExpiry(ctx: RequestContext, q: z.infer<typeof expirySchema>) {
    const f = await this.prisma.facility.findFirstOrThrow({ where: { id: ctx.facilityId, tenantId: ctx.tenantId }, select: { timezone: true } });
    const today = localDateStr(new Date(), f.timezone);
    const cutoff = new Date(dateOnly(today).getTime() + q.withinDays * 86_400_000);
    const rows = await this.prisma.$queryRaw<{ batchId: string; place: string; medicine: string; batchNo: string; expiryDate: Date; quantity: number; value: string; expired: boolean }[]>`
      SELECT * FROM (
        SELECT b.id AS "batchId", 'Main store' AS place, trim(m."brandName" || ' ' || COALESCE(m.strength, '')) AS medicine, b."batchNo" AS "batchNo", b."expiryDate" AS "expiryDate", sb.quantity AS quantity,
          (sb.quantity * b."purchasePrice")::numeric(14,2)::text AS value, b."expiryDate" < ${dateOnly(today)}::date AS expired
        FROM "StockBalance" sb JOIN "MedicineBatch" b ON b.id = sb."batchId" AND b."tenantId" = sb."tenantId" JOIN "Medicine" m ON m.id = b."medicineId" AND m."tenantId" = b."tenantId"
        WHERE sb."tenantId" = ${ctx.tenantId}::uuid AND sb."facilityId" = ${ctx.facilityId}::uuid AND sb.quantity > 0 AND b."expiryDate" <= ${cutoff}::date
        UNION ALL
        SELECT b.id, l.name, trim(m."brandName" || ' ' || COALESCE(m.strength, '')), b."batchNo", b."expiryDate", lb.quantity,
          (lb.quantity * b."purchasePrice")::numeric(14,2)::text, b."expiryDate" < ${dateOnly(today)}::date
        FROM "StockLocationBalance" lb JOIN "StockLocation" l ON l.id = lb."locationId" AND l."tenantId" = lb."tenantId"
        JOIN "MedicineBatch" b ON b.id = lb."batchId" AND b."tenantId" = lb."tenantId" JOIN "Medicine" m ON m.id = b."medicineId" AND m."tenantId" = b."tenantId"
        WHERE lb."tenantId" = ${ctx.tenantId}::uuid AND lb."facilityId" = ${ctx.facilityId}::uuid AND lb.quantity > 0 AND b."expiryDate" <= ${cutoff}::date
      ) x ORDER BY x."expiryDate", x.medicine, x.place`;
    return { asOf: today, withinDays: q.withinDays, rows: rows.map((x) => ({ ...x, expiryDate: x.expiryDate.toISOString().slice(0, 10) })) };
  }

  // ───── bookings and earnings (docs/earnings-and-reports.md) ─────

  /**
   * One row per appointment in the range, with the money collected for it: what was received (less refunds) on the visit's OPD bill, which includes any booking
   * fee that was set against it, plus a cancellation charge kept when it was cancelled. Money is counted when received, so a bill still unpaid adds nothing yet.
   */
  private async bookingRows(ctx: RequestContext, r: Range, practitionerId: string | null) {
    return this.prisma.$queryRaw<{ id: string; practitionerId: string; day: string; source: string; status: string; collected: string }[]>`
      SELECT a.id, a."practitionerId", to_char((a."startAt" AT TIME ZONE ${r.tz})::date, 'YYYY-MM-DD') AS day, a.source::text AS source, a.status::text AS status,
        (COALESCE((SELECT SUM(i."paidTotal" - i."refundedTotal") FROM "Invoice" i
                    WHERE i."tenantId" = a."tenantId" AND i."encounterId" = a."encounterId" AND i.kind = 'OPD' AND i.status <> 'DRAFT'), 0)
         + COALESCE((SELECT SUM(i."paidTotal" - i."refundedTotal") FROM "Invoice" i
                    WHERE i."tenantId" = a."tenantId" AND i.status <> 'DRAFT'
                      AND i.id IN (SELECT l."invoiceId" FROM "InvoiceLine" l WHERE l."tenantId" = a."tenantId" AND l."sourceType" = 'APPOINTMENT_CANCELLATION' AND l."sourceId" = a.id)), 0))::numeric(14,2)::text AS collected
      FROM "Appointment" a
      WHERE a."tenantId" = ${ctx.tenantId}::uuid AND a."facilityId" = ${ctx.facilityId}::uuid AND a."startAt" >= ${r.start} AND a."startAt" < ${r.end}
        AND (${practitionerId}::uuid IS NULL OR a."practitionerId" = ${practitionerId}::uuid) ${visitScopeSql(ctx, "a")}
      LIMIT 60000`;
  }

  /** Counts and money for a set of appointment rows, with the doctor/hospital split worked out visit by visit under the rule in force that day. */
  private tally(rows: { practitionerId: string; day: string; source: string; status: string; collected: string }[], rules: ShareRule[]) {
    const t = { booked: 0, walkIns: 0, cancelled: 0, noShow: 0, consulted: 0, bookedAndConsulted: 0, stillOpen: 0, collected: new Decimal(0), doctorShare: new Decimal(0) };
    for (const a of rows) {
      if (a.source === "SCHEDULED") t.booked++; else t.walkIns++;
      if (a.status === "CANCELLED") t.cancelled++;
      else if (a.status === "NO_SHOW") t.noShow++;
      else if (a.status === "COMPLETED") { t.consulted++; if (a.source === "SCHEDULED") t.bookedAndConsulted++; }
      else t.stillOpen++;
      // Money counts for visits that happened and for cancellation charges; anything else (for example a fee still held) is not earned yet.
      const kind: EarningKind | null = a.status === "COMPLETED" ? "CONSULTED" : a.status === "CANCELLED" ? "CANCELLATION_CHARGE" : null;
      if (!kind) continue;
      const amount = new Decimal(a.collected);
      t.collected = t.collected.plus(amount);
      t.doctorShare = t.doctorShare.plus(doctorShare(pickRule(rules, a.practitionerId, a.day), amount, kind));
    }
    return t;
  }

  private describeRule(rule: ShareRule | null): string {
    if (!rule) return "No share set: the hospital keeps everything collected";
    const pct = new Decimal(rule.percent?.toString() ?? 0).toFixed(2).replace(/\.00$/, "");
    const fixed = fmt(rule.fixedAmount?.toString() ?? 0);
    return rule.mode === "PERCENT" ? `${pct}% of the amount collected` : rule.mode === "FIXED" ? `${fixed} for each consulted visit` : `${fixed} for each consulted visit plus ${pct}% of the amount collected`;
  }

  /** Organisation view: every doctor of the facility side by side, with the hospital's and the doctors' shares. For REPORT_READ and REPORT_FINANCE. */
  async bookingsByDoctor(ctx: RequestContext, q: z.infer<typeof rangeSchema>) {
    const r = await this.range(ctx, q);
    const [rows, rules, doctors] = await Promise.all([
      this.bookingRows(ctx, r, null), this.earnings.rulesFor(this.prisma, ctx),
      this.prisma.practitioner.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { id: true, displayName: true, department: { select: { name: true } } }, orderBy: { displayName: "asc" } }),
    ]);
    const out = (x: ReturnType<ReportsService["tally"]>) => ({
      booked: x.booked, walkIns: x.walkIns, cancelled: x.cancelled, noShow: x.noShow, consulted: x.consulted, bookedAndConsulted: x.bookedAndConsulted, stillOpen: x.stillOpen,
      collected: fmt(x.collected), hospitalShare: fmt(x.collected.minus(x.doctorShare)), doctorShare: fmt(x.doctorShare),
    });
    const perDoctor = doctors.map((d) => ({ practitionerId: d.id, doctor: d.displayName, department: d.department?.name ?? null, shareRule: this.describeRule(pickRule(rules, d.id, r.to)), ...out(this.tally(rows.filter((a) => a.practitionerId === d.id), rules)) }))
      .filter((d) => d.booked + d.walkIns > 0);
    const days = [...new Set(rows.map((a) => a.day))].sort().map((d) => ({ day: d, ...out(this.tally(rows.filter((a) => a.day === d), rules)) }));
    return { from: r.from, to: r.to, basis: "Bookings by appointment date. Collected = money received for the visit's OPD bill (including a booking fee set against it) plus cancellation charges kept.", doctors: perDoctor, days, totals: out(this.tally(rows, rules)) };
  }

  /** The doctor's own view: only their own bookings, and their share. Never another doctor's numbers, and no hospital share. */
  async myBookings(ctx: RequestContext, q: z.infer<typeof rangeSchema>) {
    const me = await this.prisma.practitioner.findFirst({
      where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, userId: ctx.userId, status: "ACTIVE" }, select: { id: true, displayName: true, department: { select: { name: true } } },
    });
    if (!me) throw new DomainError("FORBIDDEN", "This report is for doctors. Your login is not linked to a doctor record at this facility.", 403);
    const r = await this.range(ctx, q);
    const [rows, rules] = await Promise.all([this.bookingRows(ctx, r, me.id), this.earnings.rulesFor(this.prisma, ctx)]);
    const out = (x: ReturnType<ReportsService["tally"]>) => ({
      booked: x.booked, walkIns: x.walkIns, cancelled: x.cancelled, noShow: x.noShow, consulted: x.consulted, bookedAndConsulted: x.bookedAndConsulted, stillOpen: x.stillOpen,
      collectedForMyVisits: fmt(x.collected), myShare: fmt(x.doctorShare),
    });
    const days = [...new Set(rows.map((a) => a.day))].sort().map((d) => ({ day: d, ...out(this.tally(rows.filter((a) => a.day === d), rules)) }));
    return {
      from: r.from, to: r.to, doctor: me.displayName, department: me.department?.name ?? null, myShareRule: this.describeRule(pickRule(rules, me.id, r.to)),
      basis: "Your bookings by appointment date. My share is your part of the money received for your consulted visits.", days, totals: out(this.tally(rows, rules)),
    };
  }
}
