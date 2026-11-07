import { Injectable } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import { createHash, randomUUID } from "node:crypto";
import { basename } from "node:path";
import { z } from "zod";
import { actorOf, AuditService } from "../../common/audit.service";
import { visitScope } from "../../common/data-scope";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { ScanService } from "../documents/scan.service";
import { StorageService } from "../documents/storage.service";

/** Largest image the system accepts. A single DICOM slice or an exported key image is well under this; whole CT/MRI series do not belong here (docs/radiology.md). */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGES_PER_STUDY = 20;
export const IMAGE_TYPES = ["image/png", "image/jpeg", "application/dicom"] as const;
type ImageType = (typeof IMAGE_TYPES)[number];

export const imageUploadQuerySchema = z.object({ filename: z.string().trim().min(1).max(200), description: z.string().trim().min(2).max(200).optional() }).strict();
export const removeImageSchema = z.object({ reason: z.string().trim().min(5).max(240) }).strict();

/** The declared content type must match the bytes: stops a script or executable being stored as an image. A DICOM file has "DICM" after a 128-byte preamble. */
export function sniffImageType(data: Buffer): ImageType | null {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 132 && data.subarray(128, 132).toString("latin1") === "DICM") return "application/dicom";
  return null;
}

const cleanName = (n: string): string => basename(n.replace(/\\/g, "/")).replace(/[\u0000-\u001f"<>|*?:]/g, "").slice(0, 120) || "image";
const VIEW = { id: true, studyId: true, fileName: true, contentType: true, sizeBytes: true, description: true, uploadedAt: true, uploadedById: true } as const;

/**
 * Images of a radiology study (docs/radiology.md). The radiographer and radiologist add and remove them; anyone allowed to read radiology can open them, and doctors only for
 * their own visits. Every opening is audited because it is access to a patient's record. Bytes go to the same file storage as patient documents, after the same virus scan.
 */
@Injectable()
export class RadImagesService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly storage: StorageService, private readonly scanner: ScanService) {}

  /** Staff of the imaging department see every study of the facility; a doctor sees only the studies of visits they may see (data-access rules). */
  private scoped(ctx: RequestContext): boolean { return !ctx.permissions.has("RAD_PERFORM") && !ctx.permissions.has("RAD_REPORT"); }

  private async study(db: Db | PrismaService, ctx: RequestContext, studyId: string) {
    const s = await db.radStudy.findFirst({
      where: { id: studyId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, ...(this.scoped(ctx) ? { encounter: { AND: [visitScope(ctx)] } } : {}) },
      select: { id: true, patientId: true, accessionNumber: true },
    });
    if (!s) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return s;
  }

  async upload(ctx: RequestContext, studyId: string, q: z.infer<typeof imageUploadQuerySchema>, contentType: string | undefined, data: unknown) {
    if (!Buffer.isBuffer(data) || data.length === 0) throw new DomainError("VALIDATION_FAILED", "Send the image as the request body with its own content type (PNG, JPEG or DICOM)", 415);
    if (data.length > MAX_IMAGE_BYTES) throw new DomainError("PAYLOAD_TOO_LARGE", `Images can be at most ${MAX_IMAGE_BYTES / 1024 / 1024} MB`, 413);
    const declared = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
    const real = sniffImageType(data);
    if (!real || declared !== real) throw new DomainError("VALIDATION_FAILED", "The file is not a valid PNG, JPEG or DICOM image, or its type does not match its content", 415);
    const scan = await this.scanner.scan(data);
    if (scan.status === "UNAVAILABLE") throw new DomainError("SCAN_UNAVAILABLE", "Files cannot be checked for viruses right now. Please try again shortly.", 503);
    if (scan.status === "INFECTED") {
      await this.prisma.$transaction((tx) => this.audit.record(tx, actorOf(ctx), { action: "RAD_IMAGE_REJECTED", entityType: "RadStudy", entityId: studyId, metadata: { reason: "VIRUS_FOUND", signature: scan.signature } }));
      throw new DomainError("FILE_INFECTED", "This file was rejected because the virus scan found a problem with it.", 422);
    }
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "RadStudy" WHERE id = ${studyId}::uuid AND "tenantId" = ${ctx.tenantId}::uuid AND "facilityId" = ${ctx.facilityId}::uuid FOR UPDATE`;
      if (locked.length === 0) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      const study = await this.study(tx, ctx, studyId);
      if (await tx.radImage.count({ where: { tenantId: ctx.tenantId, studyId, status: "ACTIVE" } }) >= MAX_IMAGES_PER_STUDY) {
        throw new DomainError("CONFLICT", `A study can hold at most ${MAX_IMAGES_PER_STUDY} images. Remove one that is not needed first`, 409);
      }
      const id = randomUUID();
      const storageKey = StorageService.keyFor(ctx.tenantId, id);
      await this.storage.put(storageKey, data); // inside the transaction: if this fails nothing is recorded
      const row = await tx.radImage.create({
        data: {
          id, tenantId: ctx.tenantId, facilityId: ctx.facilityId, patientId: study.patientId, studyId, fileName: cleanName(q.filename), contentType: real, sizeBytes: data.length,
          sha256: createHash("sha256").update(data).digest("hex"), storageKey, description: q.description ?? null, uploadedById: ctx.userId,
        },
        select: VIEW,
      });
      await this.audit.record(tx, actorOf(ctx), { action: "RAD_IMAGE_ADDED", entityType: "RadImage", entityId: id, metadata: { studyId, accessionNumber: study.accessionNumber, contentType: real, sizeBytes: data.length } });
      return row;
    });
  }

  async list(ctx: RequestContext, studyId: string) {
    await this.study(this.prisma, ctx, studyId);
    return this.prisma.radImage.findMany({ where: { tenantId: ctx.tenantId, studyId, status: "ACTIVE" }, select: VIEW, orderBy: [{ uploadedAt: "asc" }, { id: "asc" }], take: MAX_IMAGES_PER_STUDY });
  }

  /** The bytes of one image. Opening one leaves an audit entry. */
  async content(ctx: RequestContext, imageId: string) {
    const img = await this.prisma.radImage.findFirst({ where: { id: imageId, tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "ACTIVE" } });
    if (!img) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    await this.study(this.prisma, ctx, img.studyId);
    const data = await this.storage.get(img.storageKey);
    await this.audit.record(this.prisma, actorOf(ctx), { action: "RAD_IMAGE_VIEWED", entityType: "RadImage", entityId: img.id, metadata: { studyId: img.studyId, patientId: img.patientId } });
    return { image: { id: img.id, fileName: img.fileName, contentType: img.contentType, sizeBytes: img.sizeBytes }, data };
  }

  async remove(ctx: RequestContext, imageId: string, reason: string) {
    return this.prisma.$transaction(async (tx) => {
      const img = await tx.radImage.findFirst({ where: { id: imageId, tenantId: ctx.tenantId, facilityId: ctx.facilityId } });
      if (!img) throw new DomainError("NOT_FOUND", "Resource not found", 404);
      const res = await tx.radImage.updateMany({ where: { id: imageId, tenantId: ctx.tenantId, status: "ACTIVE" }, data: { status: "REMOVED", removedById: ctx.userId, removedAt: new Date(), removeReason: reason } });
      if (res.count !== 1) throw new DomainError("INVALID_STATE", "This image has already been removed", 409);
      await this.audit.record(tx, actorOf(ctx), { action: "RAD_IMAGE_REMOVED", entityType: "RadImage", entityId: imageId, metadata: { studyId: img.studyId, reason } });
      return { id: imageId, status: "REMOVED" as const };
    });
  }
}
