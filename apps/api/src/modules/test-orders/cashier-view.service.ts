import { Injectable } from "@nestjs/common";
import { calculateQuantity, Decimal } from "@medos/shared";
import { visitScope } from "../../common/data-scope";
import { PrismaService } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { balanceDue, fmt } from "../billing/billing.domain";
import { TestOrdersService } from "./test-orders.service";

/** How far back a prescription is looked at for the Cashier's view. Tests still waiting to be billed are shown whatever their age. */
const WINDOW_DAYS = 30;
const CAP = 500;

const notSentBack = [{ pharmacyOutcome: null }, { pharmacyOutcome: { not: "REJECTED" } }];

/**
 * The Cashier's one place per patient (docs/test-orders.md): what the doctor prescribed on paper or on screen, the medicines (digital and handwritten) with
 * where the pharmacy stands, the tests (digital and handwritten), and the bills with what is still to collect. Read-only: billing tests and taking payment
 * are done through the existing bill actions. Medicine names and quantities and test names are shown, never the diagnosis or the consultation note.
 */
@Injectable()
export class CashierViewService {
  constructor(private readonly prisma: PrismaService, private readonly tests: TestOrdersService) {}

  async patients(ctx: RequestContext) {
    const base = { tenantId: ctx.tenantId, facilityId: ctx.facilityId };
    const since = new Date(Date.now() - WINDOW_DAYS * 86_400_000);

    // 1. Visits with something still to do, from every source.
    const [orderedTests, scans, signedOrders, dueBills] = await Promise.all([
      this.prisma.testOrder.findMany({ where: { ...base, status: "ORDERED" }, select: { encounterId: true }, take: CAP }),
      this.prisma.prescriptionScan.findMany({ where: { ...base, createdAt: { gte: since }, OR: notSentBack }, select: { id: true, encounterId: true, pharmacyOutcome: true }, take: CAP }),
      this.prisma.medicationOrder.findMany({
        where: { ...base, status: "SIGNED", signedAt: { gte: since }, items: { some: { status: "ACTIVE", OR: [{ quantity: null, dispensedQuantity: 0 }, { quantity: { gt: 0 } }] } } },
        select: { encounterId: true, items: { select: { status: true, quantity: true, dispensedQuantity: true } } }, take: CAP,
      }),
      this.prisma.invoice.findMany({ where: { ...base, kind: { in: ["PHARMACY", "OTHER"] }, status: { in: ["ISSUED", "PARTIALLY_PAID"] }, encounterId: { not: null } }, select: { encounterId: true }, take: CAP }),
    ]);
    const reviewed = scans.length ? new Set((await this.prisma.scanTestReview.findMany({ where: { tenantId: ctx.tenantId, scanId: { in: scans.map((s) => s.id) } }, select: { scanId: true } })).map((r) => r.scanId)) : new Set<string>();
    const open = new Set<string>();
    for (const t of orderedTests) open.add(t.encounterId);
    for (const s of scans) if (!reviewed.has(s.id) || s.pharmacyOutcome === null) open.add(s.encounterId);
    for (const o of signedOrders) if (o.items.some((i) => i.status === "ACTIVE" && (i.quantity === null ? i.dispensedQuantity === 0 : i.dispensedQuantity < i.quantity))) open.add(o.encounterId);
    for (const b of dueBills) if (b.encounterId) open.add(b.encounterId);
    if (open.size === 0) return { patients: [] };
    const ids = [...open];

    // 2. Everything about those visits (limited to the visits this user may see, like every other list).
    const encounters = await this.prisma.encounter.findMany({
      where: { tenantId: ctx.tenantId, id: { in: ids }, AND: [visitScope(ctx)] },
      select: { id: true, patientId: true, startedAt: true, practitioner: { select: { displayName: true } }, patient: { select: { firstName: true, lastName: true, identifiers: { where: { type: "MRN" }, select: { value: true }, take: 1 } } } },
    });
    const visible = encounters.map((e) => e.id);
    const [orders, pictures, tests, invoices] = await Promise.all([
      this.prisma.medicationOrder.findMany({
        where: { tenantId: ctx.tenantId, encounterId: { in: visible }, status: "SIGNED" }, orderBy: { signedAt: "asc" },
        select: { id: true, encounterId: true, orderNumber: true, source: true, items: { orderBy: { lineNo: "asc" }, select: { id: true, genericName: true, brandName: true, strength: true, dosage: true, frequency: true, frequencyText: true, durationDays: true, quantity: true, dispensedQuantity: true, status: true } } },
      }),
      this.prisma.prescriptionScan.findMany({
        where: { tenantId: ctx.tenantId, encounterId: { in: visible } }, orderBy: { createdAt: "asc" },
        select: { id: true, encounterId: true, pharmacyOutcome: true, createdAt: true, file: { select: { id: true, fileName: true, contentType: true, status: true } }, pages: { orderBy: { pageNo: "asc" }, select: { pageNo: true, file: { select: { id: true, fileName: true, contentType: true, status: true } } } } },
      }),
      this.prisma.testOrder.findMany({ where: { tenantId: ctx.tenantId, encounterId: { in: visible } }, orderBy: { createdAt: "asc" }, select: { id: true, encounterId: true, category: true, name: true, serviceId: true, source: true, status: true, invoiceId: true } }),
      this.prisma.invoice.findMany({
        where: { tenantId: ctx.tenantId, encounterId: { in: visible }, kind: { in: ["PHARMACY", "OTHER"] }, status: { notIn: ["DRAFT", "CANCELLED"] } }, orderBy: { createdAt: "asc" },
        select: { id: true, encounterId: true, invoiceNumber: true, kind: true, status: true, total: true, paidTotal: true, refundedTotal: true, creditedTotal: true, lines: { orderBy: { lineNo: "asc" }, take: 30, select: { description: true, quantity: true, lineTotal: true } } },
      }),
    ]);
    const billing = await this.tests.billingLinesFor(this.prisma, ctx, visible);
    const reviewedAll = pictures.length ? new Set((await this.prisma.scanTestReview.findMany({ where: { tenantId: ctx.tenantId, scanId: { in: pictures.map((p) => p.id) } }, select: { scanId: true } })).map((r) => r.scanId)) : new Set<string>();
    const serviceIds = [...new Set(tests.flatMap((t) => (t.serviceId ? [t.serviceId] : [])))];
    const services = serviceIds.length ? await this.prisma.service.findMany({ where: { tenantId: ctx.tenantId, id: { in: serviceIds } }, select: { id: true, name: true, price: true, taxPercent: true } }) : [];
    const svc = new Map(services.map((s) => [s.id, s]));
    const invNumber = new Map(invoices.map((i) => [i.id, i.invoiceNumber]));
    const group = <T extends { encounterId: string }>(rows: T[]) => { const m = new Map<string, T[]>(); for (const r of rows) m.set(r.encounterId, [...(m.get(r.encounterId) ?? []), r]); return m; };
    const byOrders = group(orders); const byPictures = group(pictures); const byTests = group(tests); const byInvoices = group(invoices.flatMap((i) => (i.encounterId ? [{ ...i, encounterId: i.encounterId }] : [])));

    // 3. One card per patient, newest visit first.
    const patients = new Map<string, { patientId: string; patientName: string; mrn: string | null; latest: number; visits: unknown[]; due: Decimal; testsToBill: number; medicinesWaiting: number; picturesToRead: number }>();
    for (const e of [...encounters].sort((x, y) => y.startedAt.getTime() - x.startedAt.getTime())) {
      const p = patients.get(e.patientId) ?? { patientId: e.patientId, patientName: [e.patient.firstName, e.patient.lastName].filter(Boolean).join(" "), mrn: e.patient.identifiers[0]?.value ?? null, latest: e.startedAt.getTime(), visits: [], due: new Decimal(0), testsToBill: 0, medicinesWaiting: 0, picturesToRead: 0 };
      const medicines = (byOrders.get(e.id) ?? []).map((o) => {
        const active = o.items.filter((i) => i.status === "ACTIVE");
        const remaining = active.some((i) => (i.quantity === null ? i.dispensedQuantity === 0 : i.dispensedQuantity < i.quantity));
        const started = active.some((i) => i.dispensedQuantity > 0);
        const pharmacy = remaining ? (started ? "PARTLY_GIVEN" : "WAITING") : "GIVEN";
        if (remaining) p.medicinesWaiting++;
        return {
          orderNumber: o.orderNumber, source: o.source, pharmacy,
          items: o.items.map((i) => ({ id: i.id, name: i.brandName ? `${i.brandName} (${i.genericName})` : i.genericName, strength: i.strength, dosage: i.dosage, frequency: i.frequencyText ?? i.frequency, days: i.durationDays, quantity: i.quantity, suggestedQuantity: i.quantity === null ? calculateQuantity(i.dosage, i.frequency, i.durationDays) : null, given: i.dispensedQuantity, status: i.status })),
        };
      });
      const pics = (byPictures.get(e.id) ?? []).map((s) => {
        const toRead = !reviewedAll.has(s.id) && s.pharmacyOutcome !== "REJECTED";
        if (toRead) p.picturesToRead++;
        // A picture the pharmacy has not dealt with is medicine still waiting there, unless the doctor's approved lines already show as a prescription above.
        if (s.pharmacyOutcome === null && !medicines.some((m) => m.source === "HANDWRITTEN")) p.medicinesWaiting++;
        return {
          scanId: s.id, uploadedAt: s.createdAt, pharmacy: s.pharmacyOutcome === "DISPENSED" ? "GIVEN" : s.pharmacyOutcome === "REJECTED" ? "SENT_BACK" : "WAITING", testsRead: reviewedAll.has(s.id),
          pages: [{ pageNo: 1, file: s.file }, ...s.pages].filter((pg) => pg.file.status === "ACTIVE").map((pg) => ({ pageNo: pg.pageNo, fileId: pg.file.id, fileName: pg.file.fileName, contentType: pg.file.contentType })),
        };
      });
      const visitTests = (byTests.get(e.id) ?? []).map((t) => {
        const s = t.serviceId ? svc.get(t.serviceId) : undefined;
        if (t.status === "ORDERED") p.testsToBill++;
        return { id: t.id, category: t.category, name: t.name, source: t.source, status: t.status, price: s ? fmt(s.price.toString()) : null, taxPercent: s ? s.taxPercent.toString() : null, invoiceNumber: t.invoiceId ? invNumber.get(t.invoiceId) ?? null : null };
      });
      const bills = (byInvoices.get(e.id) ?? []).map((i) => {
        const due = i.status === "ISSUED" || i.status === "PARTIALLY_PAID" ? balanceDue({ total: i.total, paidTotal: i.paidTotal, refundedTotal: i.refundedTotal, creditedTotal: i.creditedTotal }) : new Decimal(0);
        p.due = p.due.plus(due);
        return { invoiceId: i.id, invoiceNumber: i.invoiceNumber, kind: i.kind, status: i.status, total: fmt(i.total.toString()), balanceDue: fmt(due), lines: i.lines.map((l) => ({ description: l.description, quantity: l.quantity.toString(), total: fmt(l.lineTotal.toString()) })) };
      });
      p.visits.push({ encounterId: e.id, visitDate: e.startedAt, doctorName: e.practitioner?.displayName ?? null, medicines, pictures: pics, tests: visitTests, billing: billing.get(e.id) ?? { lines: [], total: "0.00", unpriced: 0 }, bills });
      patients.set(e.patientId, p);
    }
    return {
      patients: [...patients.values()].sort((a, b) => b.latest - a.latest).slice(0, 100)
        .map(({ latest: _latest, due, ...p }) => ({ ...p, toCollect: fmt(due) })),
    };
  }
}
