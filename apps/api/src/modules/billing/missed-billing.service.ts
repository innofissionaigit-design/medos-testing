import { Injectable } from "@nestjs/common";
import { DomainError, Decimal } from "@medos/shared";
import { z } from "zod";
import { actorOf, AuditService } from "../../common/audit.service";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { endOfLocalDay, localDateStr, startOfLocalDay } from "../../common/time";
import { coveredByPackage, DECISIONS, FLAG_LABELS, FLAG_TYPES, flagKey, parseFlagKey, reasonProblem, summarise, unchargedNights, type Decision, type FlagType } from "./missed-billing.domain";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const missedBillingQuerySchema = z.object({
  from: day.optional(), to: day.optional(),
  type: z.enum(FLAG_TYPES).optional(),
  status: z.enum(["OPEN", "REVIEWED", "ALL"]).default("OPEN"),
  /** How long a test may wait to be billed before it is pointed out. */
  graceHours: z.coerce.number().int().min(0).max(720).default(24),
}).strict();
export const reviewSchema = z.object({ flagKey: z.string().min(10).max(120), decision: z.enum(DECISIONS), reason: z.string().trim().min(1).max(300) }).strict();

const MAX_DAYS = 92;
const PER_TYPE = 200;
const D = (v: Decimal.Value | null | undefined) => new Decimal(v ?? 0);
const money = (v: Decimal | null): string | null => (v === null ? null : v.toFixed(2));

interface Found { key: string; type: FlagType; patientId: string; at: Date; amount: Decimal | null; detail: string; link: { kind: "ADMISSION" | "VISIT" | "INVOICE" | "CLAIM" | "PATIENT"; id: string } }
interface Window { from: string; to: string; start: Date; end: Date; tz: string; graceHours: number }

/**
 * The "done but not billed" check (docs/missed-billing.md). It compares what happened (tests advised, medicine given out, beds occupied, consultations completed, charges
 * added late) with what was billed, and lists the gaps for a billing person to decide on. Nothing is stored about a gap until a person decides: the flags are worked out
 * from the records each time, and each decision is kept for good (`MissedBillingReview`). It never bills anything itself.
 */
@Injectable()
export class MissedBillingService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  private async facilityZone(ctx: RequestContext): Promise<string> {
    return (await this.prisma.facility.findFirstOrThrow({ where: { id: ctx.facilityId, tenantId: ctx.tenantId }, select: { timezone: true } })).timezone;
  }

  private async window(ctx: RequestContext, q: { from?: string | undefined; to?: string | undefined; graceHours: number }): Promise<Window> {
    const tz = await this.facilityZone(ctx);
    const to = q.to ?? localDateStr(new Date(), tz);
    const from = q.from ?? new Date(new Date(`${to}T00:00:00Z`).getTime() - 29 * 86_400_000).toISOString().slice(0, 10);
    if (from > to) throw new DomainError("VALIDATION_FAILED", "The start date is after the end date", 400, [{ path: "from", message: "Start must not be after the end" }]);
    if ((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000 > MAX_DAYS) throw new DomainError("VALIDATION_FAILED", `Choose at most ${MAX_DAYS} days at a time`, 400, [{ path: "from", message: `At most ${MAX_DAYS} days` }]);
    return { from, to, start: startOfLocalDay(from, tz), end: endOfLocalDay(to, tz), tz, graceHours: q.graceHours };
  }

  // ───── the checks: each returns the flags of one kind, scoped to the caller's hospital and facility ─────

  /** Tests the doctor advised that are still not billed after a grace period. */
  private async testsNotBilled(db: Db, ctx: RequestContext, w: Window, onlyId?: string): Promise<Found[]> {
    const cutoff = new Date(Date.now() - w.graceHours * 3_600_000);
    const rows = await db.testOrder.findMany({
      where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "ORDERED", createdAt: { gte: w.start, lte: w.end < cutoff ? w.end : cutoff }, encounter: { status: { not: "CANCELLED" } }, ...(onlyId ? { id: onlyId } : {}) },
      orderBy: { createdAt: "asc" }, take: PER_TYPE, select: { id: true, patientId: true, encounterId: true, name: true, category: true, serviceId: true, createdAt: true },
    });
    const prices = await this.prices(db, ctx, rows.map((r) => r.serviceId));
    return rows.map((r) => ({ key: flagKey("TEST_NOT_BILLED", r.id), type: "TEST_NOT_BILLED" as const, patientId: r.patientId, at: r.createdAt, amount: r.serviceId ? prices.get(r.serviceId) ?? null : null, detail: `${r.name} (${r.category.toLowerCase()}) was advised and no bill has it`, link: { kind: "VISIT" as const, id: r.encounterId } }));
  }

  /** A test that was actually carried out (a sample taken, or a scan done) whose bill was cancelled. */
  private async testsWithCancelledBill(db: Db, ctx: RequestContext, w: Window, onlyId?: string): Promise<Found[]> {
    const rows = await db.testOrder.findMany({
      where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "BILLED", invoiceId: { not: null }, createdAt: { gte: w.start, lte: w.end }, OR: [{ labSamples: { some: { status: "COLLECTED" } } }, { radStudy: { isNot: null } }], ...(onlyId ? { id: onlyId } : {}) },
      orderBy: { createdAt: "asc" }, take: PER_TYPE * 2, select: { id: true, patientId: true, name: true, serviceId: true, invoiceId: true, createdAt: true },
    });
    if (rows.length === 0) return [];
    const cancelled = new Map((await db.invoice.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, id: { in: rows.map((r) => r.invoiceId!) }, status: "CANCELLED" }, select: { id: true, invoiceNumber: true } })).map((i) => [i.id, i.invoiceNumber]));
    const hits = rows.filter((r) => cancelled.has(r.invoiceId!)).slice(0, PER_TYPE);
    const prices = await this.prices(db, ctx, hits.map((r) => r.serviceId));
    return hits.map((r) => ({ key: flagKey("TEST_BILL_CANCELLED", r.id), type: "TEST_BILL_CANCELLED" as const, patientId: r.patientId, at: r.createdAt, amount: r.serviceId ? prices.get(r.serviceId) ?? null : null, detail: `${r.name} was carried out but bill ${cancelled.get(r.invoiceId!) ?? ""} was cancelled`.replace(/\s+/g, " "), link: { kind: "INVOICE" as const, id: r.invoiceId! } }));
  }

  /** Medicine given out at the pharmacy with no live bill, and medicine issued to a ward patient with no charge. */
  private async medicineNotBilled(db: Db, ctx: RequestContext, w: Window, onlyId?: string): Promise<Found[]> {
    const dispenses = await db.dispense.findMany({
      where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: { not: "RETURNED" }, dispensedAt: { gte: w.start, lte: w.end }, OR: [{ invoiceId: null }, { invoice: { status: "CANCELLED" } }], ...(onlyId ? { id: onlyId } : {}) },
      orderBy: { dispensedAt: "asc" }, take: PER_TYPE, select: { id: true, patientId: true, dispenseNumber: true, total: true, dispensedAt: true, invoiceId: true },
    });
    const issues = await db.stockLocationIssue.findMany({
      where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, chargeId: null, createdAt: { gte: w.start, lte: w.end }, ...(onlyId ? { id: onlyId } : {}) },
      orderBy: { createdAt: "asc" }, take: PER_TYPE, select: { id: true, patientId: true, admissionId: true, quantity: true, medicineId: true, createdAt: true },
    });
    const meds = issues.length ? new Map((await db.medicine.findMany({ where: { tenantId: ctx.tenantId, id: { in: [...new Set(issues.map((i) => i.medicineId))] } }, select: { id: true, brandName: true } })).map((m) => [m.id, m.brandName])) : new Map<string, string>();
    return [
      ...dispenses.map((d) => ({ key: flagKey("MEDICINE_NOT_BILLED", d.id), type: "MEDICINE_NOT_BILLED" as const, patientId: d.patientId, at: d.dispensedAt, amount: D(d.total), detail: `Dispense ${d.dispenseNumber} ${d.invoiceId ? "has a cancelled bill" : "has no bill"}`, link: { kind: "PATIENT" as const, id: d.patientId } })),
      ...issues.map((i) => ({ key: flagKey("MEDICINE_NOT_BILLED", i.id), type: "MEDICINE_NOT_BILLED" as const, patientId: i.patientId, at: i.createdAt, amount: null, detail: `${i.quantity} x ${meds.get(i.medicineId) ?? "medicine"} issued from a ward store with no charge on the admission`, link: { kind: "ADMISSION" as const, id: i.admissionId } })),
    ];
  }

  /** Nights a patient occupied a bed that have no bed charge. */
  private async bedNights(db: Db, ctx: RequestContext, w: Window, onlyAdmissionId?: string): Promise<Found[]> {
    const today = localDateStr(new Date(), w.tz);
    const admissions = await db.admission.findMany({
      where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: { not: "CANCELLED" }, admittedAt: { lte: w.end }, OR: [{ dischargedAt: null }, { dischargedAt: { gte: w.start } }], ...(onlyAdmissionId ? { id: onlyAdmissionId } : {}) },
      orderBy: { admittedAt: "asc" }, take: 100,
      select: { id: true, patientId: true, status: true, admissionNumber: true, assignments: { orderBy: { assignedAt: "asc" }, select: { assignedAt: true, releasedAt: true, dailyRate: true, bed: { select: { code: true } } } } },
    });
    if (admissions.length === 0) return [];
    const charges = await db.charge.findMany({ where: { tenantId: ctx.tenantId, admissionId: { in: admissions.map((a) => a.id) }, sourceKey: { startsWith: "BED:" } }, select: { admissionId: true, sourceKey: true } });
    const charged = new Map<string, Set<string>>();
    for (const c of charges) { const s = charged.get(c.admissionId) ?? new Set<string>(); s.add((c.sourceKey ?? "").split(":")[2] ?? ""); charged.set(c.admissionId, s); }
    const out: Found[] = [];
    for (const a of admissions) {
      const stays = a.assignments.map((s) => ({ fromDay: localDateStr(s.assignedAt, w.tz), toDay: s.releasedAt ? localDateStr(s.releasedAt, w.tz) : today, dailyRate: s.dailyRate, bed: s.bed.code }));
      for (const n of unchargedNights(stays, charged.get(a.id) ?? new Set(), today, a.status === "ADMITTED", w.from, w.to)) {
        out.push({ key: flagKey("BED_NIGHT_NOT_CHARGED", a.id, n.day), type: "BED_NIGHT_NOT_CHARGED", patientId: a.patientId, at: startOfLocalDay(n.day, w.tz), amount: n.rate, detail: `${a.admissionNumber}: bed ${n.bed} on ${n.day} has no bed charge`, link: { kind: "ADMISSION", id: a.id } });
      }
    }
    return out.slice(0, PER_TYPE * 2);
  }

  /** An outpatient visit that was completed with no consultation fee on any live bill. */
  private async consultationsWithoutFee(db: Db, ctx: RequestContext, w: Window, onlyId?: string): Promise<Found[]> {
    const rows = await db.encounter.findMany({
      where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, type: "OPD", status: "COMPLETED", endedAt: { gte: w.start, lte: w.end }, consultationBill: null, ...(onlyId ? { id: onlyId } : {}) },
      orderBy: { endedAt: "asc" }, take: PER_TYPE * 2, select: { id: true, patientId: true, encounterNumber: true, endedAt: true },
    });
    if (rows.length === 0) return [];
    const billed = new Set((await db.invoice.findMany({
      where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, encounterId: { in: rows.map((r) => r.id) }, status: { notIn: ["CANCELLED", "DRAFT"] }, lines: { some: { service: { category: "CONSULTATION" } } } },
      select: { encounterId: true },
    })).map((i) => i.encounterId));
    return rows.filter((r) => !billed.has(r.id)).slice(0, PER_TYPE).map((r) => ({ key: flagKey("CONSULTATION_NO_FEE", r.id), type: "CONSULTATION_NO_FEE" as const, patientId: r.patientId, at: r.endedAt ?? new Date(), amount: null, detail: `Visit ${r.encounterNumber} was completed and no consultation fee is on a bill`, link: { kind: "VISIT" as const, id: r.id } }));
  }

  /** An item a package already covers, billed again on a bill outside the claim (for example a supplementary bill). */
  private async packageBilledAgain(db: Db, ctx: RequestContext, w: Window, onlyLineId?: string): Promise<Found[]> {
    const claims = await db.claim.findMany({
      where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, packageId: { not: null }, encounterId: { not: null }, status: { notIn: ["DRAFT", "REJECTED"] }, createdAt: { lte: w.end } },
      take: 100, select: { id: true, patientId: true, encounterId: true, packageId: true, packageName: true, invoiceId: true, extraInvoices: { select: { invoiceId: true } } },
    });
    const out: Found[] = [];
    for (const c of claims) {
      const pkg = await db.insurerPackage.findFirst({ where: { id: c.packageId!, tenantId: ctx.tenantId }, select: { includesImplants: true, includesConsumables: true, inclusions: true } });
      if (!pkg) continue;
      const own = new Set([c.invoiceId, ...c.extraInvoices.map((x) => x.invoiceId)].filter((x): x is string => !!x));
      const lines = await db.invoiceLine.findMany({
        where: { tenantId: ctx.tenantId, invoice: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: c.patientId, encounterId: c.encounterId, id: { notIn: [...own] }, status: { notIn: ["CANCELLED", "DRAFT"] }, issuedAt: { gte: w.start, lte: w.end } }, ...(onlyLineId ? { id: onlyLineId } : {}) },
        take: 200, select: { id: true, description: true, lineTotal: true, sourceType: true, sourceId: true, invoice: { select: { id: true, invoiceNumber: true, issuedAt: true } } },
      });
      const chargeIds = lines.filter((l) => l.sourceType === "CHARGE" && l.sourceId).map((l) => l.sourceId!);
      const items = chargeIds.length ? await db.procedureItem.findMany({ where: { tenantId: ctx.tenantId, chargeId: { in: chargeIds }, removedAt: null }, select: { chargeId: true, kind: true } }) : [];
      const kindOf = new Map(items.map((i) => [i.chargeId, i.kind as string]));
      for (const l of lines) {
        const why = coveredByPackage({ kind: (l.sourceId && kindOf.get(l.sourceId)) || null, description: l.description }, pkg);
        if (!why || D(l.lineTotal).lte(0)) continue;
        out.push({ key: flagKey("PACKAGE_ITEM_BILLED_AGAIN", l.id), type: "PACKAGE_ITEM_BILLED_AGAIN", patientId: c.patientId, at: l.invoice.issuedAt ?? w.end, amount: D(l.lineTotal), detail: `"${l.description}" is ${why}, yet it is on bill ${l.invoice.invoiceNumber ?? ""} outside the claim (package ${c.packageName ?? ""})`.replace(/\s+/g, " "), link: { kind: "INVOICE", id: l.invoice.id } });
      }
    }
    return out.slice(0, PER_TYPE);
  }

  /** A charge added to an admission after its final bill, still waiting to be billed. */
  private async lateCharges(db: Db, ctx: RequestContext, w: Window, onlyId?: string): Promise<Found[]> {
    const rows = await db.charge.findMany({
      where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "PENDING", chargedAt: { gte: w.start, lte: w.end }, admission: { finalInvoiceId: { not: null } }, ...(onlyId ? { id: onlyId } : {}) },
      orderBy: { chargedAt: "asc" }, take: PER_TYPE * 2,
      select: { id: true, patientId: true, admissionId: true, description: true, quantity: true, unitPrice: true, taxPercent: true, chargedAt: true, admission: { select: { finalInvoice: { select: { issuedAt: true, invoiceNumber: true } } } } },
    });
    return rows.filter((r) => { const at = r.admission.finalInvoice?.issuedAt; return at !== null && at !== undefined && r.chargedAt > at; }).slice(0, PER_TYPE).map((r) => ({
      key: flagKey("LATE_CHARGE_NOT_BILLED", r.id), type: "LATE_CHARGE_NOT_BILLED" as const, patientId: r.patientId, at: r.chargedAt,
      amount: D(r.quantity).times(D(r.unitPrice)).times(D(1).plus(D(r.taxPercent).div(100))).toDecimalPlaces(2, Decimal.ROUND_HALF_UP),
      detail: `"${r.description}" was added after final bill ${r.admission.finalInvoice?.invoiceNumber ?? ""} and is not on a bill`.replace(/\s+/g, " "), link: { kind: "ADMISSION" as const, id: r.admissionId },
    }));
  }

  private async prices(db: Db, ctx: RequestContext, ids: (string | null)[]): Promise<Map<string, Decimal>> {
    const want = [...new Set(ids.filter((x): x is string => !!x))];
    if (want.length === 0) return new Map();
    const rows = await db.service.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, id: { in: want } }, select: { id: true, price: true } });
    return new Map(rows.map((r) => [r.id, D(r.price)]));
  }

  private async everything(db: Db, ctx: RequestContext, w: Window, type?: FlagType): Promise<Found[]> {
    const want = (t: FlagType) => !type || type === t;
    const parts = await Promise.all([
      want("TEST_NOT_BILLED") ? this.testsNotBilled(db, ctx, w) : [],
      want("TEST_BILL_CANCELLED") ? this.testsWithCancelledBill(db, ctx, w) : [],
      want("MEDICINE_NOT_BILLED") ? this.medicineNotBilled(db, ctx, w) : [],
      want("BED_NIGHT_NOT_CHARGED") ? this.bedNights(db, ctx, w) : [],
      want("CONSULTATION_NO_FEE") ? this.consultationsWithoutFee(db, ctx, w) : [],
      want("PACKAGE_ITEM_BILLED_AGAIN") ? this.packageBilledAgain(db, ctx, w) : [],
      want("LATE_CHARGE_NOT_BILLED") ? this.lateCharges(db, ctx, w) : [],
    ]);
    return parts.flat();
  }

  // ───── the report ─────

  /** The flags in a period, with what each billing person has decided so far. The wording says "possible": some flags will turn out to be fine. */
  async report(ctx: RequestContext, q: z.infer<typeof missedBillingQuerySchema>) {
    const w = await this.window(ctx, q);
    const found = await this.everything(this.prisma, ctx, w, q.type);
    const reviews = found.length ? await this.prisma.missedBillingReview.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, flagKey: { in: found.map((f) => f.key) } } }) : [];
    const byKey = new Map(reviews.map((r) => [r.flagKey, r]));
    const patients = await this.prisma.patient.findMany({ where: { tenantId: ctx.tenantId, id: { in: [...new Set(found.map((f) => f.patientId))] } }, select: { id: true, firstName: true, lastName: true, identifiers: { where: { type: "MRN" }, select: { value: true } } } });
    const pt = new Map(patients.map((p) => [p.id, p]));
    const all = found.sort((a, b) => b.at.getTime() - a.at.getTime()).map((f) => {
      const r = byKey.get(f.key);
      const p = pt.get(f.patientId);
      return {
        key: f.key, type: f.type, label: FLAG_LABELS[f.type], at: f.at.toISOString(), detail: f.detail, amount: money(f.amount), link: f.link,
        patient: { id: f.patientId, name: p ? [p.firstName, p.lastName].filter(Boolean).join(" ") : "", mrn: p?.identifiers[0]?.value ?? null },
        review: r ? { decision: r.decision as Decision, reason: r.reason, at: r.reviewedAt.toISOString(), byId: r.reviewedById } : null,
      };
    });
    const summary = summarise(all.map((a) => ({ type: a.type, amount: a.amount === null ? null : D(a.amount), reviewed: a.review !== null })));
    const items = all.filter((a) => (q.status === "ALL" ? true : q.status === "OPEN" ? a.review === null : a.review !== null));
    const openAmount = summary.reduce((a, s) => a.plus(s.openAmount), new Decimal(0));
    return {
      // Not "lost money": a flag only points at something a person should look at.
      note: "These are possible missed income. Some will turn out to be fine; a billing person decides on each.",
      from: w.from, to: w.to, openCount: summary.reduce((a, s) => a + s.open, 0), possibleMissedIncome: openAmount.toFixed(2), unpricedOpen: summary.reduce((a, s) => a + s.unpriced, 0),
      summary, items,
    };
  }

  // ───── a decision ─────

  /** Records what the billing person decided about one flag. The flag is checked again first, so a decision cannot be recorded for something that is not a gap. */
  async review(ctx: RequestContext, input: z.infer<typeof reviewSchema>) {
    const parsed = parseFlagKey(input.flagKey);
    if (!parsed) throw new DomainError("VALIDATION_FAILED", "That is not a flag", 400, [{ path: "flagKey", message: "Unknown flag" }]);
    const problem = reasonProblem(input.decision, input.reason);
    if (problem) throw new DomainError("VALIDATION_FAILED", problem, 400, [{ path: "reason", message: problem }]);
    const tz = await this.facilityZone(ctx);
    return this.prisma.$transaction(async (tx) => {
      const flag = await this.one(tx, ctx, tz, parsed.type, parsed.recordId, parsed.day);
      if (!flag) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      const dup = await tx.missedBillingReview.findFirst({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, flagKey: flag.key }, select: { id: true } });
      if (dup) throw new DomainError("INVALID_STATE", "This flag has already been decided", 409);
      const row = await tx.missedBillingReview.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, flagKey: flag.key, flagType: flag.type, patientId: flag.patientId, decision: input.decision, reason: input.reason.trim(), amount: flag.amount === null ? null : flag.amount.toFixed(2), reviewedById: ctx.userId } });
      await this.audit.record(tx, actorOf(ctx), { action: "MISSED_BILLING_REVIEWED", entityType: "MissedBillingReview", entityId: row.id, metadata: { flagType: flag.type, decision: input.decision, patientId: flag.patientId, ...(flag.amount ? { amount: flag.amount.toFixed(2) } : {}) } });
      return { id: row.id, flagKey: row.flagKey, decision: row.decision, reviewedAt: row.reviewedAt.toISOString() };
    });
  }

  /** Finds one named flag again, whenever its record dates from (the window is as wide as it can be, and a test has no waiting period). */
  private async one(db: Db, ctx: RequestContext, tz: string, type: FlagType, id: string, dayStr: string | null): Promise<Found | null> {
    const w: Window = { from: dayStr ?? "2000-01-01", to: dayStr ?? "2999-12-31", start: new Date("2000-01-01T00:00:00Z"), end: new Date("2999-12-31T00:00:00Z"), tz, graceHours: 0 };
    const found = type === "TEST_NOT_BILLED" ? await this.testsNotBilled(db, ctx, w, id)
      : type === "TEST_BILL_CANCELLED" ? await this.testsWithCancelledBill(db, ctx, w, id)
        : type === "MEDICINE_NOT_BILLED" ? await this.medicineNotBilled(db, ctx, w, id)
          : type === "BED_NIGHT_NOT_CHARGED" ? await this.bedNights(db, ctx, w, id)
            : type === "CONSULTATION_NO_FEE" ? await this.consultationsWithoutFee(db, ctx, w, id)
              : type === "PACKAGE_ITEM_BILLED_AGAIN" ? await this.packageBilledAgain(db, ctx, w, id)
                : await this.lateCharges(db, ctx, w, id);
    return found.find((f) => f.key === flagKey(type, id, dayStr ?? undefined)) ?? null;
  }
}
