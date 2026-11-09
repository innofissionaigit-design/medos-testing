import { Injectable } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import { createHash, randomUUID } from "node:crypto";
import { basename } from "node:path";
import { z } from "zod";
import { actorOf, AuditService } from "../../common/audit.service";
import { PrismaService } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { chartPatientIds } from "../patients/patient-links";
import { ScanService } from "./scan.service";
import { StorageService } from "./storage.service";

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const ALLOWED_TYPES = ["image/png", "image/jpeg", "application/pdf"] as const;
type AllowedType = (typeof ALLOWED_TYPES)[number];

export const uploadQuerySchema = z.object({
  kind: z.enum(["PHOTO", "DOCUMENT"]).default("DOCUMENT"),
  filename: z.string().trim().min(1).max(200),
  title: z.string().trim().min(2).max(120).optional(),
}).strict();
export const removeFileSchema = z.object({ reason: z.string().trim().min(5).max(240) }).strict();

/** The declared content type must match the bytes: stops a script or executable being stored as an "image". */
export function sniffType(data: Buffer): AllowedType | null {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 5 && data.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  return null;
}

const cleanName = (n: string): string => basename(n.replace(/\\/g, "/")).replace(/[\u0000-\u001f"<>|*?:]/g, "").slice(0, 120) || "file";

const VIEW = { id: true, kind: true, title: true, fileName: true, contentType: true, sizeBytes: true, uploadedAt: true, uploadedById: true, patientId: true } as const;

@Injectable()
export class FilesService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly storage: StorageService, private readonly scanner: ScanService) {}

  async upload(ctx: RequestContext, patientId: string, q: z.infer<typeof uploadQuerySchema>, contentType: string | undefined, data: unknown) {
    if (!Buffer.isBuffer(data) || data.length === 0) throw new DomainError("VALIDATION_FAILED", "Send the file as the request body with its own content type (PNG, JPEG or PDF)", 415);
    if (data.length > MAX_FILE_BYTES) throw new DomainError("PAYLOAD_TOO_LARGE", `Files can be at most ${MAX_FILE_BYTES / 1024 / 1024} MB`, 413);
    const declared = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
    const real = sniffType(data);
    if (!real || declared !== real) throw new DomainError("VALIDATION_FAILED", "The file is not a valid PNG, JPEG or PDF, or its type does not match its content", 415);
    if (q.kind === "PHOTO" && real === "application/pdf") throw new DomainError("VALIDATION_FAILED", "A profile photo must be a PNG or JPEG image", 400);
    const title = q.title ?? (q.kind === "PHOTO" ? "Photo" : null);
    if (!title) throw new DomainError("VALIDATION_FAILED", "Give the document a title", 400, [{ path: "title", message: "Required for documents" }]);

    // Scan before anything is stored. Only the signature name is recorded, never the file or its name.
    const scan = await this.scanner.scan(data);
    if (scan.status === "UNAVAILABLE") throw new DomainError("SCAN_UNAVAILABLE", "Files cannot be checked for viruses right now. Please try again shortly.", 503);
    if (scan.status === "INFECTED") {
      await this.prisma.$transaction((tx) => this.audit.record(tx, actorOf(ctx), { action: "PATIENT_FILE_REJECTED", entityType: "Patient", entityId: patientId, metadata: { reason: "VIRUS_FOUND", signature: scan.signature, sizeBytes: data.length } }));
      throw new DomainError("FILE_INFECTED", "This file was rejected because the virus scan found a problem with it.", 422);
    }

    return this.prisma.$transaction(async (tx) => {
      const patient = await tx.patient.findFirst({ where: { id: patientId, tenantId: ctx.tenantId }, select: { id: true, mergedIntoId: true } });
      if (!patient) throw new DomainError("PATIENT_NOT_FOUND", "Patient not found", 404);
      if (patient.mergedIntoId) throw new DomainError("PATIENT_MERGED", "This patient record was merged into another. Add the file to the real patient.", 409, { mergedIntoId: patient.mergedIntoId });
      if (q.kind === "PHOTO") {
        await tx.patientFile.updateMany({
          where: { tenantId: ctx.tenantId, patientId, kind: "PHOTO", status: "ACTIVE" },
          data: { status: "REMOVED", removedById: ctx.userId, removedAt: new Date(), removeReason: "Replaced by a new photo" },
        });
      }
      const id = randomUUID();
      const storageKey = StorageService.keyFor(ctx.tenantId, id);
      await this.storage.put(storageKey, data); // inside the transaction: if this fails nothing is recorded
      const row = await tx.patientFile.create({
        data: {
          id, tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId, kind: q.kind, title, fileName: cleanName(q.filename), contentType: real,
          sizeBytes: data.length, sha256: createHash("sha256").update(data).digest("hex"), storageKey, uploadedById: ctx.userId,
        },
        select: VIEW,
      });
      await this.audit.record(tx, actorOf(ctx), { action: "PATIENT_FILE_UPLOADED", entityType: "PatientFile", entityId: id, metadata: { patientId, kind: q.kind, contentType: real, sizeBytes: data.length } });
      return row;
    });
  }

  async list(ctx: RequestContext, patientId: string) {
    const ids = await chartPatientIds(this.prisma, ctx.tenantId, patientId);
    if (!ids) throw new DomainError("PATIENT_NOT_FOUND", "Patient not found", 404);
    return this.prisma.patientFile.findMany({ where: { tenantId: ctx.tenantId, patientId: { in: ids }, status: "ACTIVE" }, select: VIEW, orderBy: { uploadedAt: "desc" } });
  }

  /** Returns the bytes. Viewing a document (not a profile photo) leaves an audit trail because it is access to patient records. */
  async content(ctx: RequestContext, fileId: string) {
    const f = await this.prisma.patientFile.findFirst({ where: { id: fileId, tenantId: ctx.tenantId, status: "ACTIVE" } });
    if (!f) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const data = await this.storage.get(f.storageKey);
    if (f.kind === "DOCUMENT") {
      await this.audit.record(this.prisma, actorOf(ctx), { action: "PATIENT_FILE_VIEWED", entityType: "PatientFile", entityId: f.id, metadata: { patientId: f.patientId } });
    }
    return { file: { id: f.id, kind: f.kind, fileName: f.fileName, contentType: f.contentType, sizeBytes: f.sizeBytes }, data };
  }

  async remove(ctx: RequestContext, fileId: string, reason: string) {
    return this.prisma.$transaction(async (tx) => {
      const f = await tx.patientFile.findFirst({ where: { id: fileId, tenantId: ctx.tenantId } });
      if (!f) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      const done = await tx.patientFile.updateMany({ where: { id: fileId, tenantId: ctx.tenantId, status: "ACTIVE" }, data: { status: "REMOVED", removedById: ctx.userId, removedAt: new Date(), removeReason: reason } });
      if (done.count === 0) throw new DomainError("INVALID_STATE", "This file has already been removed", 409);
      await this.audit.record(tx, actorOf(ctx), { action: "PATIENT_FILE_REMOVED", entityType: "PatientFile", entityId: fileId, metadata: { patientId: f.patientId, kind: f.kind } });
      return { id: fileId, status: "REMOVED" as const };
    });
  }
}
