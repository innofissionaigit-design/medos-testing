import { Injectable } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import type { Prisma } from "@medos/database";
import { z } from "zod";
import { actorOf, AuditService } from "../../common/audit.service";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { visitScope } from "../../common/data-scope";
import { ClinicianService } from "../clinical/clinician.service";
import { FilesService } from "../documents/files.service";
import { StorageService } from "../documents/storage.service";
import { SettingsService } from "../settings/settings.service";
import { OcrConfigService } from "./ocr-config.service";
import { OcrError } from "./ocr.provider";
import { orderItemSchema, PrescriptionsService } from "./prescriptions.service";
import { parsePrescriptionLines } from "./scan-parse";

export const uploadScanQuerySchema = z.object({ filename: z.string().trim().min(1).max(200), /** Add this picture as a further page of that prescription. */ scanId: z.string().uuid().optional() }).strict();
/** Pages of one handwritten prescription, the first included. */
const MAX_PAGES = 10;
export const correctScanSchema = z.object({ text: z.string().trim().min(1).max(8000) }).strict();
/** The doctor's structured medicine lines for a scan: name, strength, dose, route, frequency, food timing, duration, quantity and instructions. */
export const saveLinesSchema = z.object({ items: z.array(orderItemSchema).max(30) }).strict();
export const approveScanSchema = z.object({ acknowledgeAllergyWarnings: z.boolean().optional() }).strict();

const OCR_STATES = ["UPLOADED", "OCR_FAILED", "OCR_NOT_CONFIGURED"] as const;
const linesSchema = z.array(orderItemSchema);

/**
 * Handwritten prescriptions (docs/prescriptions.md): a photo or scan is attached to a visit (before or after the consultation is signed), optionally read by an
 * OCR service, and turned by the doctor into structured medicine lines. The image is an ordinary patient file. What the OCR service returned is kept exactly as
 * returned; the doctor's corrections and lines are stored beside it. Nothing reaches the pharmacy until a doctor approves the lines: approval creates and signs a
 * prescription (source HANDWRITTEN) that the pharmacy dispenses like any other.
 */
@Injectable()
export class ScansService {
  constructor(
    private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly settings: SettingsService,
    private readonly files: FilesService, private readonly storage: StorageService, private readonly ocrConfig: OcrConfigService,
    private readonly prescriptions: PrescriptionsService, private readonly clinicians: ClinicianService,
  ) {}

  async config(ctx: RequestContext) {
    const [uploadEnabled, ocrEnabled, provider] = await Promise.all([
      this.settings.get(this.prisma, ctx.tenantId, ctx.facilityId, "PRESCRIPTION_UPLOAD_ENABLED"),
      this.settings.get(this.prisma, ctx.tenantId, ctx.facilityId, "PRESCRIPTION_OCR_ENABLED"),
      this.ocrConfig.provider(ctx),
    ]);
    return { uploadEnabled, ocrEnabled, ocrConnected: provider.configured };
  }

  private async requireEnabled(ctx: RequestContext): Promise<void> {
    if (!(await this.settings.get(this.prisma, ctx.tenantId, ctx.facilityId, "PRESCRIPTION_UPLOAD_ENABLED"))) {
      throw new DomainError("FEATURE_DISABLED", "Uploading handwritten prescriptions is not switched on for this facility", 403);
    }
  }

  /** Stores the image against the visit as a new prescription or, with `scanId`, as a further page of one that is not approved yet. Reads it with OCR straight away when that is switched on. The upload succeeds even if the OCR step does not. */
  async upload(ctx: RequestContext, encounterId: string, q: z.infer<typeof uploadScanQuerySchema>, contentType: string | undefined, data: unknown) {
    await this.requireEnabled(ctx);
    const enc = await this.prisma.encounter.findFirst({ where: { id: encounterId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { id: true, patientId: true } });
    if (!enc) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    if (q.scanId) return this.addPage(ctx, enc, q.scanId, q.filename, contentType, data);
    const file = await this.files.upload(ctx, enc.patientId, { kind: "DOCUMENT", filename: q.filename, title: "Handwritten prescription" }, contentType, data);
    const scan = await this.prisma.$transaction(async (tx) => {
      const row = await tx.prescriptionScan.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: enc.patientId, encounterId, fileId: file.id, createdById: ctx.userId }, select: { id: true } });
      await this.audit.record(tx, actorOf(ctx), { action: "PRESCRIPTION_SCAN_UPLOADED", entityType: "PrescriptionScan", entityId: row.id, metadata: { encounterId, fileId: file.id } });
      return row;
    });
    if (await this.settings.get(this.prisma, ctx.tenantId, ctx.facilityId, "PRESCRIPTION_OCR_ENABLED")) await this.read(ctx, scan.id);
    return this.view(ctx, scan.id);
  }

  /** A further page of a handwritten prescription (up to 10 pages in all), added before it is approved. */
  private async addPage(ctx: RequestContext, enc: { id: string; patientId: string }, scanId: string, filename: string, contentType: string | undefined, data: unknown) {
    const scan = await this.prisma.prescriptionScan.findFirst({ where: { id: scanId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, encounterId: enc.id }, include: { pages: { select: { pageNo: true } } } });
    if (!scan) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    if (scan.approvedAt) throw new DomainError("INVALID_STATE", "This prescription was already approved, so no page can be added. Upload it as a new prescription.", 409);
    if (scan.pharmacyOutcome) throw new DomainError("INVALID_STATE", "The pharmacy has already dealt with this prescription, so no page can be added. Upload a new prescription.", 409);
    if (scan.pages.length + 1 >= MAX_PAGES) throw new DomainError("INVALID_STATE", `A prescription can have up to ${MAX_PAGES} pages`, 409);
    const pageNo = Math.max(1, ...scan.pages.map((p) => p.pageNo)) + 1;
    const file = await this.files.upload(ctx, enc.patientId, { kind: "DOCUMENT", filename, title: `Handwritten prescription, page ${pageNo}` }, contentType, data);
    const page = await this.prisma.$transaction(async (tx) => {
      const row = await tx.prescriptionScanPage.create({ data: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, scanId: scan.id, pageNo, fileId: file.id, createdById: ctx.userId }, select: { id: true } });
      await this.audit.record(tx, actorOf(ctx), { action: "PRESCRIPTION_SCAN_PAGE_ADDED", entityType: "PrescriptionScan", entityId: scan.id, metadata: { pageNo, fileId: file.id } });
      return row;
    }).catch((e: unknown) => { if ((e as { code?: string }).code === "P2002") throw new DomainError("CONFLICT", "Another page was added at the same moment. Try again.", 409); throw e; });
    if (await this.settings.get(this.prisma, ctx.tenantId, ctx.facilityId, "PRESCRIPTION_OCR_ENABLED")) await this.readPage(ctx, page.id);
    return this.view(ctx, scan.id);
  }

  /** Runs (or retries) OCR on the pages that have not been read successfully. Once text has been read it is kept; corrections are made on top of it. */
  async extract(ctx: RequestContext, scanId: string) {
    await this.requireEnabled(ctx);
    if (!(await this.settings.get(this.prisma, ctx.tenantId, ctx.facilityId, "PRESCRIPTION_OCR_ENABLED"))) throw new DomainError("FEATURE_DISABLED", "Reading handwritten prescriptions with OCR is not switched on for this facility", 403);
    const scan = await this.prisma.prescriptionScan.findFirst({ where: { id: scanId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, include: { pages: { select: { id: true, status: true }, orderBy: { pageNo: "asc" } } } });
    if (!scan) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const pending = scan.pages.filter((p) => (OCR_STATES as readonly string[]).includes(p.status));
    const first = (OCR_STATES as readonly string[]).includes(scan.status);
    if (!first && pending.length === 0) throw new DomainError("INVALID_STATE", "This prescription was already read. Correct the text instead.", 409);
    if (first) await this.read(ctx, scanId);
    for (const p of pending) await this.readPage(ctx, p.id);
    return this.view(ctx, scanId);
  }

  /** Sends one picture to the OCR service; never throws for an OCR problem. */
  private async ocrFile(ctx: RequestContext, file: { storageKey: string; contentType: string; fileName: string }) {
    const ocr = await this.ocrConfig.provider(ctx).catch((e: unknown) => { if (e instanceof DomainError) return null; throw e; });
    if (!ocr || !ocr.configured) return { ok: false as const, status: "OCR_NOT_CONFIGURED" as const, provider: null, error: "No OCR service is connected. Type what the prescription says instead." };
    try {
      const r = await ocr.extract({ bytes: await this.storage.get(file.storageKey), contentType: file.contentType, fileName: file.fileName });
      return { ok: true as const, provider: ocr.name, text: r.text, confidence: r.confidence };
    } catch (e) {
      return { ok: false as const, status: "OCR_FAILED" as const, provider: ocr.name, error: e instanceof OcrError ? e.message : "The prescription could not be read" };
    }
  }

  private async read(ctx: RequestContext, scanId: string): Promise<void> {
    const scan = await this.prisma.prescriptionScan.findFirst({ where: { id: scanId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, include: { file: true } });
    if (!scan) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    if (!(OCR_STATES as readonly string[]).includes(scan.status)) throw new DomainError("INVALID_STATE", "This prescription was already read. Correct the text instead.", 409);
    const now = new Date();
    const where = { tenantId: ctx.tenantId, id: scan.id, status: { in: [...OCR_STATES] } };
    const o = await this.ocrFile(ctx, scan.file);
    if (o.ok) {
      const done = await this.prisma.prescriptionScan.updateMany({ where, data: { status: "OCR_DONE", ocrProvider: o.provider, ocrText: o.text, ocrConfidence: o.confidence === null ? null : o.confidence.toFixed(4), ocrError: null, ocrAttempts: { increment: 1 }, ocrAt: now } });
      if (done.count === 1) await this.prisma.$transaction((tx) => this.audit.record(tx, actorOf(ctx), { action: "PRESCRIPTION_SCAN_OCR_DONE", entityType: "PrescriptionScan", entityId: scan.id, metadata: { provider: o.provider, characters: o.text.length, pageNo: 1 } }));
      return;
    }
    await this.prisma.prescriptionScan.updateMany({ where, data: { status: o.status, ocrProvider: o.provider, ocrError: o.error, ocrAttempts: { increment: 1 }, ocrAt: now } });
    await this.prisma.$transaction((tx) => this.audit.record(tx, actorOf(ctx), o.status === "OCR_NOT_CONFIGURED"
      ? { action: "PRESCRIPTION_SCAN_OCR_SKIPPED", entityType: "PrescriptionScan", entityId: scan.id, metadata: { reason: "NOT_CONFIGURED", pageNo: 1 } }
      : { action: "PRESCRIPTION_SCAN_OCR_FAILED", entityType: "PrescriptionScan", entityId: scan.id, metadata: { provider: o.provider, reason: o.error, pageNo: 1 } }));
  }

  private async readPage(ctx: RequestContext, pageId: string): Promise<void> {
    const page = await this.prisma.prescriptionScanPage.findFirst({ where: { id: pageId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, include: { file: true } });
    if (!page || !(OCR_STATES as readonly string[]).includes(page.status)) return;
    const now = new Date();
    const where = { tenantId: ctx.tenantId, id: page.id, status: { in: [...OCR_STATES] } };
    const o = await this.ocrFile(ctx, page.file);
    if (o.ok) {
      const done = await this.prisma.prescriptionScanPage.updateMany({ where, data: { status: "OCR_DONE", ocrProvider: o.provider, ocrText: o.text, ocrConfidence: o.confidence === null ? null : o.confidence.toFixed(4), ocrError: null, ocrAttempts: { increment: 1 }, ocrAt: now } });
      if (done.count === 1) await this.prisma.$transaction((tx) => this.audit.record(tx, actorOf(ctx), { action: "PRESCRIPTION_SCAN_OCR_DONE", entityType: "PrescriptionScan", entityId: page.scanId, metadata: { provider: o.provider, characters: o.text.length, pageNo: page.pageNo } }));
      return;
    }
    await this.prisma.prescriptionScanPage.updateMany({ where, data: { status: o.status, ocrProvider: o.provider, ocrError: o.error, ocrAttempts: { increment: 1 }, ocrAt: now } });
    await this.prisma.$transaction((tx) => this.audit.record(tx, actorOf(ctx), o.status === "OCR_NOT_CONFIGURED"
      ? { action: "PRESCRIPTION_SCAN_OCR_SKIPPED", entityType: "PrescriptionScan", entityId: page.scanId, metadata: { reason: "NOT_CONFIGURED", pageNo: page.pageNo } }
      : { action: "PRESCRIPTION_SCAN_OCR_FAILED", entityType: "PrescriptionScan", entityId: page.scanId, metadata: { provider: o.provider, reason: o.error, pageNo: page.pageNo } }));
  }

  async list(ctx: RequestContext, encounterId: string) {
    const enc = await this.prisma.encounter.findFirst({ where: { id: encounterId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, AND: [visitScope(ctx)] }, select: { id: true } });
    if (!enc) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const ids = (await this.prisma.prescriptionScan.findMany({ where: { tenantId: ctx.tenantId, encounterId }, orderBy: { createdAt: "desc" }, select: { id: true }, take: 50 })).map((s) => s.id);
    return Promise.all(ids.map((id) => this.view(ctx, id)));
  }

  /** The doctor's correction of what OCR read (or the text they typed when nothing could be read). The original OCR text is never overwritten. */
  async correct(ctx: RequestContext, scanId: string, input: z.infer<typeof correctScanSchema>) {
    await this.requireEnabled(ctx);
    return this.prisma.$transaction(async (tx) => {
      await this.requireOpen(tx, ctx, scanId);
      await tx.prescriptionScan.updateMany({ where: { id: scanId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, approvedAt: null }, data: { correctedText: input.text, correctedById: ctx.userId, correctedAt: new Date() } });
      await this.audit.record(tx, actorOf(ctx), { action: "PRESCRIPTION_SCAN_CORRECTED", entityType: "PrescriptionScan", entityId: scanId, metadata: { characters: input.text.length } });
      return this.view(ctx, scanId, tx);
    });
  }

  /** Saves the doctor's structured lines as a draft. Nothing is ordered: the pharmacy sees these only after approval. */
  async saveLines(ctx: RequestContext, scanId: string, input: z.infer<typeof saveLinesSchema>) {
    await this.requireEnabled(ctx);
    return this.prisma.$transaction(async (tx) => {
      await this.requireOpen(tx, ctx, scanId);
      await tx.prescriptionScan.updateMany({
        where: { id: scanId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, approvedAt: null },
        data: { lines: input.items as Prisma.InputJsonArray, linesById: ctx.userId, linesAt: new Date() },
      });
      await this.audit.record(tx, actorOf(ctx), { action: "PRESCRIPTION_SCAN_LINES_SAVED", entityType: "PrescriptionScan", entityId: scanId, metadata: { lines: input.items.length } });
      return this.view(ctx, scanId, tx);
    });
  }

  /**
   * The doctor verifies the saved lines against the handwriting and approves them. This creates the signed prescription the pharmacy dispenses from, and
   * freezes the scan, its text and the lines. Needs a registered practitioner with PRESCRIPTION_SIGN; recorded allergies are checked like any prescription.
   */
  async approve(ctx: RequestContext, scanId: string, input: z.infer<typeof approveScanSchema>) {
    await this.requireEnabled(ctx);
    return this.prisma.$transaction(async (tx) => {
      await this.clinicians.requireActive(tx, ctx);
      const scan = await tx.prescriptionScan.findFirst({ where: { id: scanId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, include: { encounter: { select: { type: true, status: true } } } });
      if (!scan) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      if (scan.approvedAt) throw new DomainError("INVALID_STATE", "This prescription was already approved", 409);
      if (scan.encounter.type !== "OPD") throw new DomainError("INVALID_STATE", "A handwritten prescription can be approved for outpatient visits only", 409);
      if (scan.encounter.status === "CANCELLED") throw new DomainError("INVALID_STATE", "This visit was cancelled", 409);
      const parsed = linesSchema.safeParse(scan.lines ?? []);
      if (!parsed.success || parsed.data.length === 0) throw new DomainError("INVALID_STATE", "Add the medicines from the handwriting and save them first", 409);
      const order = await this.prescriptions.createApprovedFromScan(tx, ctx, { id: scan.id, encounterId: scan.encounterId, patientId: scan.patientId }, parsed.data, input.acknowledgeAllergyWarnings === true);
      const res = await tx.prescriptionScan.updateMany({ where: { id: scan.id, tenantId: ctx.tenantId, approvedAt: null }, data: { approvedAt: new Date(), approvedById: ctx.userId, medicationOrderId: order.id } });
      if (res.count !== 1) throw new DomainError("INVALID_STATE", "This prescription was approved by someone else", 409);
      await this.audit.record(tx, actorOf(ctx), { action: "PRESCRIPTION_SCAN_APPROVED", entityType: "PrescriptionScan", entityId: scan.id, metadata: { orderNumber: order.orderNumber, lines: parsed.data.length, ocrRead: scan.status === "OCR_DONE", textCorrected: !!scan.correctedText } });
      return this.view(ctx, scan.id, tx);
    });
  }

  private async requireOpen(tx: Db, ctx: RequestContext, scanId: string): Promise<void> {
    const s = await tx.prescriptionScan.findFirst({ where: { id: scanId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { approvedAt: true } });
    if (!s) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    if (s.approvedAt) throw new DomainError("INVALID_STATE", "This prescription was already approved and can no longer be changed", 409);
  }

  /** The text of a picture (the doctor's corrected text, else what OCR read), for building a draft prescription. Only for pictures of visits the caller may see. */
  async textOf(ctx: RequestContext, scanId: string): Promise<{ encounterId: string; patientId: string; text: string | null; ocrError: string | null }> {
    const hit = await this.prisma.prescriptionScan.findFirst({ where: { id: scanId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, encounter: { AND: [visitScope(ctx)] } }, select: { id: true, encounterId: true, patientId: true } });
    if (!hit) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const v = await this.view(ctx, scanId);
    return { encounterId: hit.encounterId, patientId: hit.patientId, text: v.text, ocrError: v.ocr.error };
  }

  private async view(ctx: RequestContext, scanId: string, db: Pick<PrismaService, "prescriptionScan" | "user"> = this.prisma) {
    const s = await db.prescriptionScan.findFirstOrThrow({
      where: { id: scanId, tenantId: ctx.tenantId },
      include: { file: { select: { id: true, contentType: true, fileName: true, uploadedAt: true, status: true } }, medicationOrder: { select: { id: true, orderNumber: true } }, pages: { orderBy: { pageNo: "asc" }, include: { file: { select: { id: true, contentType: true, fileName: true, status: true } } } } },
    });
    const people = new Map((await db.user.findMany({ where: { tenantId: ctx.tenantId, id: { in: [s.createdById, ...(s.approvedById ? [s.approvedById] : []), ...(s.pharmacyById ? [s.pharmacyById] : [])] } }, select: { id: true, fullName: true } })).map((u) => [u.id, u.fullName]));
    const parts = [s.ocrText, ...s.pages.map((p) => p.ocrText)].filter((t): t is string => !!t);
    const ocrText = parts.length > 0 ? parts.join("\n") : null;
    const text = s.correctedText ?? ocrText;
    const pending = [s.status, ...s.pages.map((p) => p.status)].some((st) => (OCR_STATES as readonly string[]).includes(st));
    const lines = linesSchema.safeParse(s.lines ?? []);
    return {
      id: s.id, encounterId: s.encounterId, status: s.status, uploadedAt: s.createdAt, uploadedBy: people.get(s.createdById) ?? null,
      file: { id: s.file.id, contentType: s.file.contentType, fileName: s.file.fileName, removed: s.file.status !== "ACTIVE" },
      ocr: { provider: s.ocrProvider, text: ocrText, confidence: s.ocrConfidence === null ? null : Number(s.ocrConfidence.toString()), error: s.ocrError ?? s.pages.find((p) => p.ocrError)?.ocrError ?? null, attempts: s.ocrAttempts, at: s.ocrAt },
      /** True while some page has not been read successfully (and can be read again). */
      needsReading: pending,
      /** Every page in order, the first one included. */
      pages: [
        { pageNo: 1, file: { id: s.file.id, contentType: s.file.contentType, fileName: s.file.fileName, removed: s.file.status !== "ACTIVE" }, status: s.status, error: s.ocrError },
        ...s.pages.map((p) => ({ pageNo: p.pageNo, file: { id: p.file.id, contentType: p.file.contentType, fileName: p.file.fileName, removed: p.file.status !== "ACTIVE" }, status: p.status, error: p.ocrError })),
      ],
      /** The doctor typed or corrected the text, and a page was added after that (its text is not part of the doctor's text). */
      correctedStale: !!s.correctedAt && s.pages.some((p) => p.createdAt > (s.correctedAt as Date)),
      correctedText: s.correctedText, text,
      /** Medicine lines read from the text, as suggestions only. */
      suggestions: text ? parsePrescriptionLines(text) : [],
      /** The doctor's structured lines (a draft until approved). */
      lines: lines.success ? lines.data : [], linesSavedAt: s.linesAt,
      /** What the pharmacy did with the picture: still waiting (outcome null), dispensed, or could not use it (with the reason). */
      pharmacy: { outcome: s.pharmacyOutcome, at: s.pharmacyAt, by: s.pharmacyById ? people.get(s.pharmacyById) ?? null : null, note: s.pharmacyNote },
      approved: s.approvedAt ? { at: s.approvedAt, by: people.get(s.approvedById ?? "") ?? null, prescriptionId: s.medicationOrder?.id ?? null, prescriptionNumber: s.medicationOrder?.orderNumber ?? null } : null,
    };
  }
}
