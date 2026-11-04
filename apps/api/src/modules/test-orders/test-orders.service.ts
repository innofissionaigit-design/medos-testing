import { Injectable } from "@nestjs/common";
import { Decimal, DomainError } from "@medos/shared";
import type { Prisma, TestCategory } from "@medos/database";
import { z } from "zod";
import { AuditService, actorOf } from "../../common/audit.service";
import { visitScope } from "../../common/data-scope";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { fmt } from "../billing/billing.domain";
import { InvoicesService } from "../billing/invoices.service";

const uuid = z.string().uuid();
const category = z.enum(["LABORATORY", "RADIOLOGY", "CARDIOLOGY", "PROCEDURE"]);

// A price the Cashier types: any test can be billed even when the hospital's price list has no item for it. The amounts are checked here and the bill is worked out on the server.
// The checks after the pattern also run on text that failed it, so they must cope with anything.
const num = (v: string): Decimal | null => { try { return new Decimal(v); } catch { return null; } };
const price = z.string().trim().regex(/^\d{1,8}(\.\d{1,2})?$/, "Enter an amount such as 350 or 350.50").refine((v) => num(v)?.gt(0) === true, "The price must be more than zero");
const taxPct = z.string().trim().regex(/^\d{1,3}(\.\d{1,2})?$/, "Enter a tax rate such as 5 or 12.5").refine((v) => num(v)?.lte(100) === true, "The tax rate is at most 100");

export const billTestsSchema = z.object({
  encounterId: uuid,
  /** Digital tests the doctor advised. A test whose wording matched nothing on the price list needs a price-list item chosen, or a price typed. */
  orders: z.array(z.object({ orderId: uuid, serviceId: uuid.optional(), price: price.optional(), taxPercent: taxPct.optional() }).strict()
    .refine((o) => !(o.serviceId && o.price), "Choose a price-list item or type a price, not both")
    .refine((o) => !o.taxPercent || !!o.price, "A tax rate goes with a typed price")).max(50).default([]),
  /** Tests the Cashier read from the doctor's handwritten picture: chosen from the price list, or typed with a price. */
  fromPicture: z.object({
    scanId: uuid,
    tests: z.array(z.union([
      z.object({ serviceId: uuid, category: category.default("LABORATORY") }).strict(),
      z.object({ name: z.string().trim().min(2).max(120), price, taxPercent: taxPct.default("0"), category: category.default("LABORATORY") }).strict(),
    ])).min(1).max(30),
  }).strict().optional(),
  /** Bill what the Cashier saved on the visit's billing lines (docs/test-orders.md): the edited tests, the added ones, and the doctor's other tests at their price-list price. */
  fromSaved: z.literal(true).optional(),
}).strict()
  .refine((v) => v.orders.length > 0 || !!v.fromPicture || v.fromSaved === true, "Choose at least one test")
  .refine((v) => v.fromSaved !== true || (v.orders.length === 0 && !v.fromPicture), "Billing the saved lines cannot be combined with other tests");

const quantity = z.number().int().min(1).max(99);
export const saveBillingSchema = z.object({
  lines: z.array(z.object({
    /** The doctor's order this line bills. The order itself is never changed. */
    orderId: uuid.optional(),
    /** A line the Cashier added earlier and is editing again. */
    lineId: uuid.optional(),
    /** The handwritten picture a new test was read from. */
    scanId: uuid.optional(),
    name: z.string().trim().min(2).max(120),
    category: category.default("LABORATORY"),
    serviceId: uuid.optional(),
    quantity: quantity.default(1),
    price: price.optional(),
    taxPercent: taxPct.default("0"),
    removed: z.boolean().default(false),
  }).strict()
    .refine((l) => !(l.orderId && l.lineId), "A line is either the doctor's order or one the Cashier added")
    .refine((l) => !(l.orderId && l.scanId), "A picture goes with a test the Cashier adds")
    .refine((l) => l.removed || !!l.price, "A price is needed")).max(60),
}).strict();

export const cancelTestSchema = z.object({ reason: z.string().trim().min(3).max(200) }).strict();

/** One test as the Cashier will bill it. originalName is the doctor's own wording (empty for a test the Cashier added); edited tells whether the Cashier changed it. */
export interface BillingLineView {
  id: string | null; orderId: string | null; scanId: string | null; name: string; originalName: string | null; category: string; serviceId: string | null;
  quantity: number; price: string | null; taxPercent: string; removed: boolean; edited: boolean; source: string; total: string | null;
}

/** What the doctor wrote in the consultation: each list is a kind of test (docs/prescriptions.md). */
interface AdvisedContent {
  investigationsAdvised?: string[] | undefined;
  otherTestsAdvised?: string[] | undefined;
  cardiologyAdvised?: string[] | undefined;
  proceduresAdvised?: string[] | undefined;
}
const LISTS: [keyof AdvisedContent, TestCategory][] = [
  ["investigationsAdvised", "LABORATORY"], ["otherTestsAdvised", "RADIOLOGY"], ["cardiologyAdvised", "CARDIOLOGY"], ["proceduresAdvised", "PROCEDURE"],
];
const norm = (s: string): string => s.trim().replace(/\s+/g, " ").toLowerCase();
const key = (c: string, n: string): string => `${c}|${norm(n)}`;

/**
 * Tests the doctor advised (docs/test-orders.md). Signing the consultation turns them into orders matched to the price list; the Cashier bills
 * them (an issued bill, collected as any other) or, for a handwritten picture, reads the tests off the picture and bills those.
 */
@Injectable()
export class TestOrdersService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly invoices: InvoicesService) {}

  /** Called when the doctor signs or amends: orders what is advised, cancels what was taken out and is not yet billed, never touches billed tests. */
  async syncFromConsultation(tx: Db, ctx: RequestContext, enc: { id: string; patientId: string }, content: AdvisedContent, version: number): Promise<void> {
    const wanted = new Map<string, { category: TestCategory; name: string }>();
    for (const [field, cat] of LISTS) for (const raw of content[field] ?? []) { const name = raw.trim().replace(/\s+/g, " "); if (name && !wanted.has(key(cat, name))) wanted.set(key(cat, name), { category: cat, name }); }
    const existing = await tx.testOrder.findMany({ where: { tenantId: ctx.tenantId, encounterId: enc.id, source: "DIGITAL", status: { in: ["ORDERED", "BILLED"] } }, select: { id: true, category: true, name: true, status: true } });
    const have = new Set(existing.map((o) => key(o.category, o.name)));
    const toCancel = existing.filter((o) => o.status === "ORDERED" && !wanted.has(key(o.category, o.name)));
    const toCreate = [...wanted.entries()].filter(([k]) => !have.has(k)).map(([, v]) => v);

    if (toCancel.length) {
      await tx.testOrder.updateMany({ where: { id: { in: toCancel.map((o) => o.id) }, tenantId: ctx.tenantId, status: "ORDERED" }, data: { status: "CANCELLED", cancelReason: `Taken off the prescription (version ${version})` } });
      await this.audit.record(tx, actorOf(ctx), { action: "TEST_ORDERS_CANCELLED", entityType: "Encounter", entityId: enc.id, metadata: { count: toCancel.length, version } });
    }
    if (toCreate.length) {
      const services = await tx.service.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "ACTIVE" }, select: { id: true, name: true, code: true } });
      const byText = new Map<string, string>();
      for (const s of services) { byText.set(norm(s.name), s.id); if (!byText.has(norm(s.code))) byText.set(norm(s.code), s.id); }
      await tx.testOrder.createMany({
        data: toCreate.map((t) => ({
          tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: enc.patientId, encounterId: enc.id, category: t.category, name: t.name,
          serviceId: byText.get(norm(t.name)) ?? null, source: "DIGITAL", orderedById: ctx.userId, consultationVersion: version,
        })),
      });
      await this.audit.record(tx, actorOf(ctx), { action: "TEST_ORDERS_PLACED", entityType: "Encounter", entityId: enc.id, metadata: { count: toCreate.length, version } });
    }
  }

  /** The Cashier's list: visits with tests waiting to be billed (with the price list's price), and handwritten pictures nobody has read the tests from yet. */
  async queue(ctx: RequestContext) {
    const orders = await this.prisma.testOrder.findMany({
      where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "ORDERED" }, orderBy: { createdAt: "asc" }, take: 500,
      select: { id: true, encounterId: true, patientId: true, category: true, name: true, serviceId: true, createdAt: true },
    });
    const serviceIds = [...new Set(orders.flatMap((o) => (o.serviceId ? [o.serviceId] : [])))];
    const services = serviceIds.length ? await this.prisma.service.findMany({ where: { tenantId: ctx.tenantId, id: { in: serviceIds } }, select: { id: true, name: true, price: true, taxPercent: true } }) : [];
    const svc = new Map(services.map((s) => [s.id, s]));

    const scans = await this.prisma.prescriptionScan.findMany({
      // Not sent back as unusable. (A plain NOT on a column that may be empty would drop every picture the pharmacy has not dealt with yet.)
      where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, OR: [{ pharmacyOutcome: null }, { pharmacyOutcome: { not: "REJECTED" } }] }, orderBy: { createdAt: "desc" }, take: 300,
      select: { id: true, encounterId: true, patientId: true, createdAt: true, file: { select: { id: true, fileName: true, contentType: true, status: true } }, pages: { orderBy: { pageNo: "asc" }, select: { pageNo: true, file: { select: { id: true, fileName: true, contentType: true, status: true } } } } },
    });
    const reviewed = scans.length ? new Set((await this.prisma.scanTestReview.findMany({ where: { tenantId: ctx.tenantId, scanId: { in: scans.map((s) => s.id) } }, select: { scanId: true } })).map((r) => r.scanId)) : new Set<string>();
    const open = scans.filter((s) => !reviewed.has(s.id));

    const encIds = [...new Set([...orders.map((o) => o.encounterId), ...open.map((s) => s.encounterId)])];
    const patientIds = [...new Set([...orders.map((o) => o.patientId), ...open.map((s) => s.patientId)])];
    const [encs, patients] = await Promise.all([
      encIds.length ? this.prisma.encounter.findMany({ where: { tenantId: ctx.tenantId, id: { in: encIds } }, select: { id: true, startedAt: true, practitioner: { select: { displayName: true } } } }) : [],
      patientIds.length ? this.prisma.patient.findMany({ where: { tenantId: ctx.tenantId, id: { in: patientIds } }, select: { id: true, firstName: true, lastName: true, identifiers: { where: { type: "MRN" }, select: { value: true }, take: 1 } } }) : [],
    ]);
    const encById = new Map(encs.map((e) => [e.id, e]));
    const patById = new Map(patients.map((p) => [p.id, { name: [p.firstName, p.lastName].filter(Boolean).join(" "), mrn: p.identifiers[0]?.value ?? null }]));
    const head = (encounterId: string, patientId: string) => ({
      encounterId, patientId, patientName: patById.get(patientId)?.name ?? "", mrn: patById.get(patientId)?.mrn ?? null,
      doctorName: encById.get(encounterId)?.practitioner?.displayName ?? null, visitDate: encById.get(encounterId)?.startedAt ?? null,
    });

    const visits = new Map<string, { encounterId: string; patientId: string; tests: unknown[]; total: Decimal; unpriced: number }>();
    for (const o of orders) {
      const v = visits.get(o.encounterId) ?? { encounterId: o.encounterId, patientId: o.patientId, tests: [], total: new Decimal(0), unpriced: 0 };
      const s = o.serviceId ? svc.get(o.serviceId) : undefined;
      if (s) v.total = v.total.plus(new Decimal(s.price.toString()).times(new Decimal(s.taxPercent.toString()).div(100).plus(1))); else v.unpriced++;
      v.tests.push({ id: o.id, category: o.category, name: o.name, serviceId: o.serviceId, priceListName: s?.name ?? null, price: s ? fmt(s.price.toString()) : null, taxPercent: s ? s.taxPercent.toString() : null });
      visits.set(o.encounterId, v);
    }
    return {
      visits: [...visits.values()].map((v) => ({ ...head(v.encounterId, v.patientId), tests: v.tests, estimatedTotal: fmt(v.total), testsWithoutPrice: v.unpriced })),
      handwritten: open.map((s) => ({
        scanId: s.id, ...head(s.encounterId, s.patientId), uploadedAt: s.createdAt,
        pages: [{ pageNo: 1, file: s.file }, ...s.pages].filter((p) => p.file.status === "ACTIVE").map((p) => ({ pageNo: p.pageNo, fileId: p.file.id, fileName: p.file.fileName, contentType: p.file.contentType })),
      })),
    };
  }

  async bill(ctx: RequestContext, input: z.infer<typeof billTestsSchema>) {
    return this.prisma.$transaction((tx) => (input.fromSaved ? this.billSavedInTx(tx, ctx, input.encounterId) : this.billInTx(tx, ctx, input)));
  }

  /** Bills tests chosen in the request (the original path): tests from the doctor's orders and tests read off a picture. */
  private async billInTx(tx: Db, ctx: RequestContext, input: z.infer<typeof billTestsSchema>) {
    {
      const enc = await tx.encounter.findFirst({ where: { id: input.encounterId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { id: true, patientId: true } });
      if (!enc) throw new DomainError("NOT_FOUND", "Resource not found", 404);

      const orderIds = input.orders.map((o) => o.orderId);
      const orders = orderIds.length ? await tx.testOrder.findMany({ where: { id: { in: orderIds }, tenantId: ctx.tenantId, facilityId: ctx.facilityId, encounterId: enc.id, status: "ORDERED" } }) : [];
      if (orders.length !== new Set(orderIds).size) throw new DomainError("INVALID_STATE", "A test is no longer waiting to be billed. Refresh the list.", 409);
      const chosen = new Map(input.orders.map((o) => [o.orderId, o.serviceId]));

      const picture = input.fromPicture;
      if (picture) {
        const scan = await tx.prescriptionScan.findFirst({ where: { id: picture.scanId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, encounterId: enc.id }, select: { id: true, pharmacyOutcome: true } });
        if (!scan) throw new DomainError("NOT_FOUND", "Resource not found", 404);
        if (scan.pharmacyOutcome === "REJECTED") throw new DomainError("INVALID_STATE", "The pharmacy sent this picture back as unusable", 409);
        if (await tx.scanTestReview.findUnique({ where: { scanId: scan.id } })) throw new DomainError("INVALID_STATE", "The tests on this picture were already dealt with", 409);
      }

      const typed = new Map(input.orders.flatMap((o) => (o.price ? [[o.orderId, { price: o.price, taxPercent: o.taxPercent ?? "0" }] as const] : [])));
      const pictureTests = picture?.tests ?? [];
      const wantedServiceIds = [...new Set([...orders.map((o) => chosen.get(o.id) ?? o.serviceId), ...pictureTests.map((t) => ("serviceId" in t ? t.serviceId : null))].filter((x): x is string => !!x))];
      const services = wantedServiceIds.length ? await tx.service.findMany({ where: { id: { in: wantedServiceIds }, tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "ACTIVE" } }) : [];
      const svc = new Map(services.map((s) => [s.id, s]));
      for (const o of orders) if (typed.has(o.id) && (o.serviceId || chosen.get(o.id))) throw new DomainError("VALIDATION_FAILED", `"${o.name}" already has a price-list price`, 400);
      const unpriced = orders.filter((o) => !(chosen.get(o.id) ?? o.serviceId) && !typed.has(o.id));
      if (unpriced.length) throw new DomainError("TEST_NEEDS_PRICE", "Choose a price-list item or type a price for: " + unpriced.map((o) => o.name).join(", "), 409, { tests: unpriced.map((o) => ({ id: o.id, name: o.name })) });
      for (const id of wantedServiceIds) if (!svc.has(id)) throw new DomainError("VALIDATION_FAILED", "A selected price-list item does not exist or is inactive", 400);

      // One billing line per test: a price-list item at its price and tax, or the name and price the Cashier typed.
      interface Line { id: string; description: string; unitPrice: Decimal; taxPercent: Decimal; hsnSac: string | null }
      const fromService = (id: string, serviceId: string): Line => { const s = svc.get(serviceId) as NonNullable<ReturnType<typeof svc.get>>; return { id, description: s.name, unitPrice: new Decimal(s.price.toString()), taxPercent: new Decimal(s.taxPercent.toString()), hsnSac: s.sacCode }; };
      const lines: Line[] = [];
      for (const o of orders) {
        const t = typed.get(o.id);
        lines.push(t ? { id: o.id, description: o.name, unitPrice: new Decimal(t.price), taxPercent: new Decimal(t.taxPercent), hsnSac: null } : fromService(o.id, (chosen.get(o.id) ?? o.serviceId) as string));
        const picked = chosen.get(o.id);
        if (picked && picked !== o.serviceId) await tx.testOrder.update({ where: { id: o.id }, data: { serviceId: picked } });
      }
      // Tests read off a picture become orders now, so every billed test has an order record.
      for (const t of pictureTests) {
        const serviceId = "serviceId" in t ? t.serviceId : null;
        const name = "serviceId" in t ? (svc.get(t.serviceId) as NonNullable<ReturnType<typeof svc.get>>).name : t.name;
        const o = await tx.testOrder.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: enc.patientId, encounterId: enc.id, category: t.category, name, serviceId, source: "HANDWRITTEN", scanId: picture!.scanId, orderedById: ctx.userId }, select: { id: true } });
        lines.push("serviceId" in t ? fromService(o.id, t.serviceId) : { id: o.id, description: t.name, unitPrice: new Decimal(t.price), taxPercent: new Decimal(t.taxPercent), hsnSac: null });
      }
      const toBill = lines;
      const typedCount = typed.size + pictureTests.filter((t) => !("serviceId" in t)).length;

      const inv = await this.invoices.createIssuedFromSource(tx, ctx, {
        patientId: enc.patientId, encounterId: enc.id,
        // OTHER, not OPD: the consultation's own bill and the doctor's share are worked out from OPD bills, and tests are neither.
        kind: "OTHER", notes: "Tests advised by the doctor",
        lines: lines.map((l) => ({ description: l.description, quantity: new Decimal(1), unitPrice: l.unitPrice, taxPercent: l.taxPercent, hsnSac: l.hsnSac, sourceType: "TEST_ORDER", sourceId: l.id })),
      });
      const done = await tx.testOrder.updateMany({ where: { id: { in: toBill.map((o) => o.id) }, tenantId: ctx.tenantId, status: "ORDERED" }, data: { status: "BILLED", invoiceId: inv.id, billedAt: new Date(), billedById: ctx.userId } });
      if (done.count !== toBill.length) throw new DomainError("CONFLICT", "Another cashier billed these tests first. Refresh the list.", 409);
      if (picture) await tx.scanTestReview.create({ data: { scanId: picture.scanId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, encounterId: enc.id, outcome: "BILLED", reviewedById: ctx.userId } });
      await this.audit.record(tx, actorOf(ctx), { action: "TEST_ORDERS_BILLED", entityType: "Invoice", entityId: inv.id, metadata: { encounterId: enc.id, invoiceNumber: inv.invoiceNumber, tests: toBill.length, total: fmt(inv.total), fromPicture: !!picture, typedPrices: typedCount } });
      return { invoiceId: inv.id, invoiceNumber: inv.invoiceNumber, total: fmt(inv.total), tests: toBill.length };
    }
  }

  // ───── what the Cashier will bill: lines kept apart from the doctor's orders ─────

  /**
   * One cashier at a time works on a visit's billing lines: two transactions creating the same visit's lines in different orders can wait on each other
   * (a deadlock the database settles by cancelling one). Taking the visit first makes them queue instead; the second then finds the tests already billed.
   */
  private async lockVisit(tx: Db, ctx: RequestContext, encounterId: string): Promise<void> {
    const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Encounter" WHERE id = ${encounterId}::uuid AND "tenantId" = ${ctx.tenantId}::uuid AND "facilityId" = ${ctx.facilityId}::uuid FOR UPDATE`;
    if (rows.length === 0) throw new DomainError("NOT_FOUND", "Resource not found", 404);
  }

  /**
   * The billing lines of visits: for each of the doctor's tests still to bill, the Cashier's saved line if there is one (edited) or the default (the doctor's
   * wording at the price-list price, not yet saved); plus the tests the Cashier added. The doctor's orders are read, never changed.
   */
  async billingLinesFor(db: Db | PrismaService, ctx: RequestContext, encounterIds: string[]) {
    const out = new Map<string, { lines: BillingLineView[]; total: string; unpriced: number }>();
    if (!encounterIds.length) return out;
    const where = { tenantId: ctx.tenantId, facilityId: ctx.facilityId, encounterId: { in: encounterIds } };
    const [orders, drafts] = await Promise.all([
      db.testOrder.findMany({ where: { ...where, status: "ORDERED" }, orderBy: { createdAt: "asc" }, select: { id: true, encounterId: true, category: true, name: true, serviceId: true, source: true } }),
      db.testBillingLine.findMany({ where: { ...where, status: "DRAFT" }, orderBy: { createdAt: "asc" } }),
    ]);
    const serviceIds = [...new Set([...orders.flatMap((o) => (o.serviceId ? [o.serviceId] : [])), ...drafts.flatMap((d) => (d.serviceId ? [d.serviceId] : []))])];
    const services = serviceIds.length ? await db.service.findMany({ where: { tenantId: ctx.tenantId, id: { in: serviceIds } }, select: { id: true, price: true, taxPercent: true } }) : [];
    const svc = new Map(services.map((x) => [x.id, x]));
    const view = (v: Omit<BillingLineView, "total">): BillingLineView => ({ ...v, total: v.price === null || v.removed ? null : fmt(new Decimal(v.price).times(v.quantity).times(new Decimal(v.taxPercent).div(100).plus(1))) });
    for (const id of encounterIds) {
      const lines: BillingLineView[] = [];
      for (const o of orders.filter((x) => x.encounterId === id)) {
        const d = drafts.find((x) => x.testOrderId === o.id);
        const s = o.serviceId ? svc.get(o.serviceId) : undefined;
        lines.push(d
          ? view({ id: d.id, orderId: o.id, scanId: d.scanId, name: d.name, originalName: o.name, category: d.category, serviceId: d.serviceId, quantity: d.quantity, price: d.unitPrice.toString(), taxPercent: d.taxPercent.toString(), removed: d.removed, edited: true, source: o.source })
          : view({ id: null, orderId: o.id, scanId: null, name: o.name, originalName: o.name, category: o.category, serviceId: o.serviceId, quantity: 1, price: s ? s.price.toString() : null, taxPercent: s ? s.taxPercent.toString() : "0", removed: false, edited: false, source: o.source }));
      }
      for (const d of drafts.filter((x) => x.encounterId === id && !x.testOrderId)) {
        lines.push(view({ id: d.id, orderId: null, scanId: d.scanId, name: d.name, originalName: null, category: d.category, serviceId: d.serviceId, quantity: d.quantity, price: d.unitPrice.toString(), taxPercent: d.taxPercent.toString(), removed: d.removed, edited: true, source: d.scanId ? "HANDWRITTEN" : "CASHIER" }));
      }
      const live = lines.filter((l) => !l.removed);
      out.set(id, { lines, total: fmt(live.reduce((n, l) => (l.total ? n.plus(l.total) : n), new Decimal(0))), unpriced: live.filter((l) => l.price === null).length });
    }
    return out;
  }

  /**
   * Saves the Cashier's edits of a visit's tests as billing lines: name, price, quantity, tests added, tests taken off. The doctor's orders are not touched; each
   * edit is recorded on a separate line with who made it. Nothing is billed yet: the Cashier saves, checks the total, then bills (and collects).
   */
  async saveBillingLines(ctx: RequestContext, encounterId: string, input: z.infer<typeof saveBillingSchema>) {
    return this.prisma.$transaction(async (tx) => {
      await this.lockVisit(tx, ctx, encounterId);
      const enc = await tx.encounter.findFirst({ where: { id: encounterId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { id: true, patientId: true } });
      if (!enc) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      const orders = await tx.testOrder.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, encounterId, status: "ORDERED" }, select: { id: true } });
      const orderIds = new Set(orders.map((o) => o.id));
      const drafts = await tx.testBillingLine.findMany({ where: { tenantId: ctx.tenantId, encounterId, status: "DRAFT" } });
      const byOrder = new Map(drafts.flatMap((d) => (d.testOrderId ? [[d.testOrderId, d] as const] : [])));
      const extras = new Map(drafts.filter((d) => !d.testOrderId).map((d) => [d.id, d]));

      const serviceIds = [...new Set(input.lines.flatMap((l) => (l.serviceId ? [l.serviceId] : [])))];
      if (serviceIds.length && (await tx.service.count({ where: { id: { in: serviceIds }, tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "ACTIVE" } })) !== serviceIds.length) throw new DomainError("VALIDATION_FAILED", "A selected price-list item does not exist or is inactive", 400);
      const scanIds = [...new Set(input.lines.flatMap((l) => (l.scanId ? [l.scanId] : [])))];
      if (scanIds.length) {
        if ((await tx.prescriptionScan.count({ where: { id: { in: scanIds }, tenantId: ctx.tenantId, facilityId: ctx.facilityId, encounterId } })) !== scanIds.length) throw new DomainError("NOT_FOUND", "Resource not found", 404);
        if (await tx.scanTestReview.count({ where: { scanId: { in: scanIds } } })) throw new DomainError("INVALID_STATE", "The tests on this picture were already dealt with", 409);
      }

      let edited = 0, added = 0, removed = 0;
      const kept = new Set<string>();
      for (const l of input.lines) {
        const data = { name: l.name, category: l.category, serviceId: l.serviceId ?? null, quantity: l.quantity, unitPrice: l.price ?? "0", taxPercent: l.taxPercent, removed: l.removed, updatedById: ctx.userId };
        if (l.removed) removed++;
        if (l.orderId) {
          if (!orderIds.has(l.orderId)) throw new DomainError("INVALID_STATE", "A test is no longer waiting to be billed. Refresh the list.", 409);
          const ex = byOrder.get(l.orderId);
          if (ex) await tx.testBillingLine.update({ where: { id: ex.id }, data: { ...data, version: { increment: 1 } } });
          else await tx.testBillingLine.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: enc.patientId, encounterId, testOrderId: l.orderId, ...data, createdById: ctx.userId } });
          edited++;
        } else if (l.lineId) {
          const ex = extras.get(l.lineId);
          if (!ex) throw new DomainError("NOT_FOUND", "Resource not found", 404);
          await tx.testBillingLine.update({ where: { id: ex.id }, data: { ...data, version: { increment: 1 } } });
          kept.add(ex.id);
        } else {
          await tx.testBillingLine.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: enc.patientId, encounterId, scanId: l.scanId ?? null, ...data, createdById: ctx.userId } });
          added++;
        }
      }
      // A test the Cashier added and then took out of the list is dropped (kept as a record, not deleted).
      const gone = [...extras.values()].filter((d) => !kept.has(d.id));
      if (gone.length) await tx.testBillingLine.updateMany({ where: { id: { in: gone.map((d) => d.id) }, tenantId: ctx.tenantId, status: "DRAFT" }, data: { status: "DROPPED", removed: true, updatedById: ctx.userId } });
      await this.audit.record(tx, actorOf(ctx), { action: "TEST_BILLING_SAVED", entityType: "Encounter", entityId: encounterId, metadata: { lines: input.lines.length, ofDoctorsOrders: edited, added, removed, dropped: gone.length } });
      return (await this.billingLinesFor(tx, ctx, [encounterId])).get(encounterId) ?? { lines: [], total: "0.00", unpriced: 0 };
    });
  }

  /**
   * Bills a visit's tests from the Cashier's billing lines (creating the default line for any of the doctor's tests the Cashier did not touch), as one issued
   * bill. Tests taken off are closed without a charge. Runs in the caller's transaction so a payment can be taken in the same step.
   */
  async billSavedInTx(tx: Db, ctx: RequestContext, encounterId: string) {
    await this.lockVisit(tx, ctx, encounterId);
    const enc = await tx.encounter.findFirst({ where: { id: encounterId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { id: true, patientId: true } });
    if (!enc) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const orders = await tx.testOrder.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, encounterId, status: "ORDERED" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
    let drafts = await tx.testBillingLine.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, encounterId, status: "DRAFT" }, orderBy: { createdAt: "asc" } });
    const serviceIds = [...new Set([...orders.flatMap((o) => (o.serviceId ? [o.serviceId] : [])), ...drafts.flatMap((d) => (d.serviceId ? [d.serviceId] : []))])];
    const services = serviceIds.length ? await tx.service.findMany({ where: { tenantId: ctx.tenantId, id: { in: serviceIds } } }) : [];
    const svc = new Map(services.map((x) => [x.id, x]));

    // Every one of the doctor's tests still to bill gets a line: the Cashier's, or the default made now.
    const haveLine = new Set(drafts.flatMap((d) => (d.testOrderId ? [d.testOrderId] : [])));
    const unpriced = orders.filter((o) => !haveLine.has(o.id) && !(o.serviceId && svc.get(o.serviceId)));
    if (unpriced.length) throw new DomainError("TEST_NEEDS_PRICE", "Edit these tests and give each a price: " + unpriced.map((o) => o.name).join(", "), 409, { tests: unpriced.map((o) => ({ id: o.id, name: o.name })) });
    for (const o of orders.filter((x) => !haveLine.has(x.id))) {
      const s = svc.get(o.serviceId as string) as NonNullable<ReturnType<typeof svc.get>>;
      await tx.testBillingLine.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: enc.patientId, encounterId, testOrderId: o.id, name: o.name, category: o.category, serviceId: o.serviceId, quantity: 1, unitPrice: s.price.toString(), taxPercent: s.taxPercent.toString(), createdById: ctx.userId, updatedById: ctx.userId } });
    }
    if (orders.some((o) => !haveLine.has(o.id))) drafts = await tx.testBillingLine.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, encounterId, status: "DRAFT" }, orderBy: { createdAt: "asc" } });
    if (drafts.length === 0) throw new DomainError("INVALID_STATE", "There are no tests waiting to be billed on this visit", 409);

    const active = drafts.filter((d) => !d.removed);
    const taken = drafts.filter((d) => d.removed);
    let invoice: { id: string; invoiceNumber: string | null; total: Decimal } | null = null;
    if (active.length) {
      // A test the Cashier added becomes an order of its own (marked as added by the Cashier, or read from the picture) so every billed test has an order record.
      for (const d of active.filter((x) => !x.testOrderId)) {
        const o = await tx.testOrder.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: enc.patientId, encounterId, category: d.category, name: d.name, serviceId: d.serviceId, source: d.scanId ? "HANDWRITTEN" : "CASHIER", scanId: d.scanId, orderedById: ctx.userId }, select: { id: true } });
        await tx.testBillingLine.update({ where: { id: d.id }, data: { testOrderId: o.id } });
        d.testOrderId = o.id;
      }
      invoice = await this.invoices.createIssuedFromSource(tx, ctx, {
        patientId: enc.patientId, encounterId,
        // OTHER, not OPD: the consultation's own bill and the doctor's share are worked out from OPD bills, and tests are neither.
        kind: "OTHER", notes: "Tests advised by the doctor",
        lines: active.map((d) => ({ description: d.name, quantity: new Decimal(d.quantity), unitPrice: new Decimal(d.unitPrice.toString()), taxPercent: new Decimal(d.taxPercent.toString()), hsnSac: d.serviceId ? svc.get(d.serviceId)?.sacCode ?? null : null, sourceType: "TEST_BILLING_LINE", sourceId: d.id })),
      });
      const lines = await tx.testBillingLine.updateMany({ where: { id: { in: active.map((d) => d.id) }, tenantId: ctx.tenantId, status: "DRAFT" }, data: { status: "BILLED", invoiceId: invoice.id, updatedById: ctx.userId } });
      const done = await tx.testOrder.updateMany({ where: { id: { in: active.map((d) => d.testOrderId as string) }, tenantId: ctx.tenantId, status: "ORDERED" }, data: { status: "BILLED", invoiceId: invoice.id, billedAt: new Date(), billedById: ctx.userId } });
      if (lines.count !== active.length || done.count !== active.length) throw new DomainError("CONFLICT", "Another cashier billed these tests first. Refresh the list.", 409);
    }
    // Tests taken off the bill: the doctor's order is closed as "taken off at billing" (its wording is unchanged); the line is kept as the record.
    const takenOrders = taken.flatMap((d) => (d.testOrderId ? [d.testOrderId] : []));
    if (takenOrders.length) await tx.testOrder.updateMany({ where: { id: { in: takenOrders }, tenantId: ctx.tenantId, status: "ORDERED" }, data: { status: "CANCELLED", cancelReason: "Taken off the bill by the Cashier" } });
    if (taken.length) await tx.testBillingLine.updateMany({ where: { id: { in: taken.map((d) => d.id) }, tenantId: ctx.tenantId, status: "DRAFT" }, data: { status: "DROPPED", updatedById: ctx.userId } });
    // A handwritten picture whose tests were billed is dealt with.
    for (const scanId of [...new Set(active.flatMap((d) => (d.scanId ? [d.scanId] : [])))]) {
      if (!(await tx.scanTestReview.findUnique({ where: { scanId } }))) await tx.scanTestReview.create({ data: { scanId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, encounterId, outcome: "BILLED", reviewedById: ctx.userId } });
    }
    await this.audit.record(tx, actorOf(ctx), { action: "TEST_ORDERS_BILLED", entityType: invoice ? "Invoice" : "Encounter", entityId: invoice?.id ?? encounterId, metadata: { encounterId, invoiceNumber: invoice?.invoiceNumber ?? null, tests: active.length, takenOff: taken.length, total: invoice ? fmt(invoice.total) : "0.00", viaSavedLines: true } });
    return { invoiceId: invoice?.id ?? null, invoiceNumber: invoice?.invoiceNumber ?? null, total: invoice ? fmt(invoice.total) : "0.00", tests: active.length };
  }

  /** The Cashier takes a test off (the patient will not have it done here). Billed tests cannot be taken off: they are reversed through the bill. */
  async cancel(ctx: RequestContext, id: string, input: z.infer<typeof cancelTestSchema>) {
    return this.prisma.$transaction(async (tx) => {
      const res = await tx.testOrder.updateMany({ where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "ORDERED" }, data: { status: "CANCELLED", cancelReason: input.reason } });
      if (res.count !== 1) {
        const exists = await tx.testOrder.findFirst({ where: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { status: true } });
        if (!exists) throw new DomainError("NOT_FOUND", "Resource not found", 404);
        throw new DomainError("INVALID_STATE", "This test is already billed or taken off", 409);
      }
      await this.audit.record(tx, actorOf(ctx), { action: "TEST_ORDER_CANCELLED", entityType: "TestOrder", entityId: id, metadata: { reason: input.reason } });
      return { id, status: "CANCELLED" as const };
    });
  }

  /** The picture holds no tests to bill. */
  async noTests(ctx: RequestContext, scanId: string) {
    return this.prisma.$transaction(async (tx) => {
      const scan = await tx.prescriptionScan.findFirst({ where: { id: scanId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { id: true, encounterId: true } });
      if (!scan) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (await tx.scanTestReview.findUnique({ where: { scanId } })) throw new DomainError("INVALID_STATE", "This picture was already dealt with", 409);
      await tx.scanTestReview.create({ data: { scanId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, encounterId: scan.encounterId, outcome: "NONE", reviewedById: ctx.userId } });
      await this.audit.record(tx, actorOf(ctx), { action: "SCAN_TESTS_REVIEWED", entityType: "PrescriptionScan", entityId: scanId, metadata: { outcome: "NONE" } });
      return { scanId, outcome: "NONE" as const };
    });
  }

  /** What was advised on a visit and where each test stands (for the doctor's screen). */
  async forEncounter(ctx: RequestContext, encounterId: string) {
    const enc = await this.prisma.encounter.findFirst({ where: { id: encounterId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, AND: [visitScope(ctx)] }, select: { id: true } });
    if (!enc) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return this.listFor(this.prisma, ctx, [enc.id]).then((m) => m.get(enc.id) ?? []);
  }

  /** The tests of each visit, newest first, with the bill number once billed. Used by the pharmacy queue as well. */
  async listFor(db: Db | PrismaService, ctx: RequestContext, encounterIds: string[]): Promise<Map<string, { id: string; category: TestCategory; name: string; status: string; source: string; invoiceNumber: string | null }[]>> {
    const out = new Map<string, { id: string; category: TestCategory; name: string; status: string; source: string; invoiceNumber: string | null }[]>();
    if (!encounterIds.length) return out;
    const rows = await db.testOrder.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, encounterId: { in: encounterIds } } as Prisma.TestOrderWhereInput, orderBy: { createdAt: "asc" }, select: { id: true, encounterId: true, category: true, name: true, status: true, source: true, invoiceId: true } });
    const invoiceIds = [...new Set(rows.flatMap((r) => (r.invoiceId ? [r.invoiceId] : [])))];
    const invs = invoiceIds.length ? await db.invoice.findMany({ where: { tenantId: ctx.tenantId, id: { in: invoiceIds } }, select: { id: true, invoiceNumber: true } }) : [];
    const num = new Map(invs.map((i) => [i.id, i.invoiceNumber]));
    for (const r of rows) {
      const list = out.get(r.encounterId) ?? [];
      list.push({ id: r.id, category: r.category, name: r.name, status: r.status, source: r.source, invoiceNumber: r.invoiceId ? num.get(r.invoiceId) ?? null : null });
      out.set(r.encounterId, list);
    }
    return out;
  }
}
