import { Injectable } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import { createHash, randomUUID } from "node:crypto";
import { basename } from "node:path";
import { z } from "zod";
import { actorOf, AuditService } from "../../common/audit.service";
import { PrismaService } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { MAX_FILE_BYTES, sniffType } from "../documents/files.service";
import { ScanService } from "../documents/scan.service";
import { StorageService } from "../documents/storage.service";

export const MAX_DOCUMENTS_PER_CLAIM = 30;
export const documentUploadQuerySchema = z.object({ filename: z.string().trim().min(1).max(200), label: z.string().trim().min(2).max(60) }).strict();
export const removeDocumentSchema = z.object({ reason: z.string().trim().min(5).max(240) }).strict();

const cleanName = (n: string): string => basename(n.replace(/\\/g, "/")).replace(/[\u0000-\u001f"<>|*?:]/g, "").slice(0, 120) || "document";
const VIEW = { id: true, claimId: true, label: true, fileName: true, contentType: true, sizeBytes: true, uploadedAt: true, uploadedById: true } as const;
const FINISHED = ["REJECTED", "SETTLED", "CLOSED"];

/**
 * Supporting documents of an insurance claim (docs/claims.md): what the insurer or TPA asks for with a claim, such as the discharge summary, the policy card, an ID
 * and the reports. PNG, JPEG or PDF up to 5 MB, after the same content check and virus scan as patient documents. Opening one is audited because it is access to a
 * patient's record. A finished claim keeps the documents it had; a wrong document is removed with a reason and stays on the record.
 */
@Injectable()
export class ClaimDocumentsService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly storage: StorageService, private readonly scanner: ScanService) {}

  private async claim(ctx: RequestContext, claimId: string, db: Pick<PrismaService, "claim"> = this.prisma) {
    const c = await db.claim.findFirst({ where: { id: claimId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { id: true, patientId: true, status: true, claimNumber: true } });
    if (!c) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return c;
  }

  async upload(ctx: RequestContext, claimId: string, q: z.infer<typeof documentUploadQuerySchema>, contentType: string | undefined, data: unknown) {
    if (!Buffer.isBuffer(data) || data.length === 0) throw new DomainError("VALIDATION_FAILED", "Send the document as the request body with its own content type (PNG, JPEG or PDF)", 415);
    if (data.length > MAX_FILE_BYTES) throw new DomainError("PAYLOAD_TOO_LARGE", `Documents can be at most ${MAX_FILE_BYTES / 1024 / 1024} MB`, 413);
    const declared = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
    const real = sniffType(data);
    if (!real || declared !== real) throw new DomainError("VALIDATION_FAILED", "The file is not a valid PNG, JPEG or PDF, or its type does not match its content", 415);
    const scan = await this.scanner.scan(data);
    if (scan.status === "UNAVAILABLE") throw new DomainError("SCAN_UNAVAILABLE", "Files cannot be checked for viruses right now. Please try again shortly.", 503);
    if (scan.status === "INFECTED") {
      await this.prisma.$transaction((tx) => this.audit.record(tx, actorOf(ctx), { action: "CLAIM_DOCUMENT_REJECTED", entityType: "Claim", entityId: claimId, metadata: { reason: "VIRUS_FOUND", signature: scan.signature } }));
      throw new DomainError("FILE_INFECTED", "This file was rejected because the virus scan found a problem with it.", 422);
    }
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Claim" WHERE id = ${claimId}::uuid AND "tenantId" = ${ctx.tenantId}::uuid AND "facilityId" = ${ctx.facilityId}::uuid FOR UPDATE`;
      if (locked.length === 0) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      const c = await this.claim(ctx, claimId, tx);
      if (FINISHED.includes(c.status)) throw new DomainError("INVALID_STATE", "This claim is finished, so documents can no longer be added to it", 409);
      if (await tx.claimDocument.count({ where: { tenantId: ctx.tenantId, claimId, status: "ACTIVE" } }) >= MAX_DOCUMENTS_PER_CLAIM) {
        throw new DomainError("CONFLICT", `A claim can hold at most ${MAX_DOCUMENTS_PER_CLAIM} documents. Remove one that is not needed first`, 409);
      }
      const id = randomUUID();
      const storageKey = StorageService.keyFor(ctx.tenantId, id);
      await this.storage.put(storageKey, data); // inside the transaction: if this fails nothing is recorded
      const row = await tx.claimDocument.create({
        data: { id, tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: c.patientId, claimId, label: q.label, fileName: cleanName(q.filename), contentType: real, sizeBytes: data.length, sha256: createHash("sha256").update(data).digest("hex"), storageKey, uploadedById: ctx.userId },
        select: VIEW,
      });
      await this.audit.record(tx, actorOf(ctx), { action: "CLAIM_DOCUMENT_ADDED", entityType: "ClaimDocument", entityId: id, metadata: { claimId, claimNumber: c.claimNumber, label: q.label, contentType: real, sizeBytes: data.length } });
      return row;
    });
  }

  async list(ctx: RequestContext, claimId: string) {
    await this.claim(ctx, claimId);
    return this.prisma.claimDocument.findMany({ where: { tenantId: ctx.tenantId, claimId, status: "ACTIVE" }, select: VIEW, orderBy: [{ uploadedAt: "asc" }, { id: "asc" }], take: MAX_DOCUMENTS_PER_CLAIM });
  }

  /** The bytes of one document. Opening one leaves an audit entry. */
  async content(ctx: RequestContext, documentId: string) {
    const d = await this.prisma.claimDocument.findFirst({ where: { id: documentId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "ACTIVE" } });
    if (!d) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const data = await this.storage.get(d.storageKey);
    await this.audit.record(this.prisma, actorOf(ctx), { action: "CLAIM_DOCUMENT_VIEWED", entityType: "ClaimDocument", entityId: d.id, metadata: { claimId: d.claimId, patientId: d.patientId } });
    return { document: { id: d.id, fileName: d.fileName, contentType: d.contentType, sizeBytes: d.sizeBytes }, data };
  }

  async remove(ctx: RequestContext, documentId: string, reason: string) {
    return this.prisma.$transaction(async (tx) => {
      const d = await tx.claimDocument.findFirst({ where: { id: documentId, tenantId: ctx.tenantId, facilityId: ctx.facilityId } });
      if (!d) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      const c = await this.claim(ctx, d.claimId, tx);
      if (FINISHED.includes(c.status)) throw new DomainError("INVALID_STATE", "This claim is finished, so its documents can no longer be removed", 409);
      const res = await tx.claimDocument.updateMany({ where: { id: documentId, tenantId: ctx.tenantId, status: "ACTIVE" }, data: { status: "REMOVED", removedById: ctx.userId, removedAt: new Date(), removeReason: reason } });
      if (res.count !== 1) throw new DomainError("INVALID_STATE", "This document has already been removed", 409);
      await this.audit.record(tx, actorOf(ctx), { action: "CLAIM_DOCUMENT_REMOVED", entityType: "ClaimDocument", entityId: documentId, metadata: { claimId: d.claimId, label: d.label, reason } });
      return { id: documentId, status: "REMOVED" as const };
    });
  }
}
