import { Injectable } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import type { Prisma } from "@medos/database";
import { z } from "zod";
import { AuditService, actorOf } from "../../common/audit.service";
import { IdempotencyService } from "../../common/idempotency.service";
import { PrismaService, type Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { patientScope } from "../../common/data-scope";
import { NumberingService } from "../numbering/numbering.service";
import { RegistrationFeeService, registrationSettlementSchema, type RegistrationMode } from "./registration-fee.service";
import {
  compareSeverity, currentAge, normalizeMobile, normalizeName, scoreDuplicate,
  type DuplicateReason, type DuplicateSeverity,
} from "./patient.domain";

// ───────────────────────── input schemas ─────────────────────────

const personName = z.string().trim().min(1).max(60).regex(/^[\p{L}\p{M}][\p{L}\p{M} .'’-]*$/u, "Name contains invalid characters")
  .transform((s) => s.replace(/\s+/g, " "));
const mobile = z.string().trim().max(20).transform((s, c) => {
  const n = normalizeMobile(s);
  if (!n) c.addIssue({ code: "custom", message: "Enter a valid 10-digit Indian mobile number" });
  return n as string;
});
const text = (max: number) => z.string().trim().min(1).max(max);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").transform((s, c) => {
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) c.addIssue({ code: "custom", message: "Invalid date" });
  else if (d.getTime() > Date.now()) c.addIssue({ code: "custom", message: "Date of birth cannot be in the future" });
  return d;
});

const demographics = {
  firstName: personName,
  lastName: personName,
  gender: z.enum(["MALE", "FEMALE", "OTHER", "UNKNOWN"]),
  dateOfBirth: isoDate,
  estimatedAgeYears: z.number().int().min(0).max(130),
  mobile,
  addressLine: text(200), city: text(80), district: text(80), state: text(80),
  postalCode: z.string().trim().regex(/^[0-9]{6}$/, "Postal code must be 6 digits"),
  guardianName: personName, guardianRelation: text(40), guardianMobile: mobile,
  emergencyContactName: personName, emergencyContactMobile: mobile,
  bloodGroup: z.enum(["A_POS", "A_NEG", "B_POS", "B_NEG", "AB_POS", "AB_NEG", "O_POS", "O_NEG"]),
};

const optionalFields = [
  "lastName", "dateOfBirth", "estimatedAgeYears", "mobile", "addressLine", "city", "district", "state", "postalCode",
  "guardianName", "guardianRelation", "guardianMobile", "emergencyContactName", "emergencyContactMobile", "bloodGroup",
] as const;

function ageRule(v: { dateOfBirth?: unknown; estimatedAgeYears?: unknown }, c: z.RefinementCtx, required: boolean): void {
  const hasDob = v.dateOfBirth !== undefined && v.dateOfBirth !== null;
  const hasAge = v.estimatedAgeYears !== undefined && v.estimatedAgeYears !== null;
  if (hasDob && hasAge) c.addIssue({ code: "custom", path: ["estimatedAgeYears"], message: "Provide either date of birth or estimated age, not both" });
  if (required && !hasDob && !hasAge) c.addIssue({ code: "custom", path: ["dateOfBirth"], message: "Date of birth or estimated age is required" });
}

export const duplicateProbeSchema = z.object({
  firstName: demographics.firstName, lastName: demographics.lastName.optional(),
  gender: demographics.gender, dateOfBirth: demographics.dateOfBirth.optional(),
  estimatedAgeYears: demographics.estimatedAgeYears.optional(), mobile: demographics.mobile.optional(),
}).strict().superRefine((v, c) => ageRule(v, c, true));

export const createPatientSchema = z.object({
  ...demographics,
  ...Object.fromEntries(optionalFields.map((k) => [k, demographics[k].optional()])) as { [K in (typeof optionalFields)[number]]: z.ZodOptional<(typeof demographics)[K]> },
  duplicateOverride: z.object({ confirmedDistinct: z.literal(true), reason: z.string().trim().max(240).optional() }).strict().optional(),
  /** The registration fee: paid (cash, UPI or card) or exempted. Needed when a registration fee is set up (docs/registration-fee.md). */
  registration: registrationSettlementSchema.optional(),
}).strict().superRefine((v, c) => ageRule(v, c, true));

export const updatePatientSchema = z.object({
  version: z.number().int().min(1),
  firstName: demographics.firstName.optional(),
  lastName: demographics.lastName.nullable().optional(),
  gender: demographics.gender.optional(),
  dateOfBirth: demographics.dateOfBirth.optional(),
  estimatedAgeYears: demographics.estimatedAgeYears.optional(),
  mobile: demographics.mobile.nullable().optional(),
  addressLine: demographics.addressLine.nullable().optional(),
  city: demographics.city.nullable().optional(),
  district: demographics.district.nullable().optional(),
  state: demographics.state.nullable().optional(),
  postalCode: demographics.postalCode.nullable().optional(),
  guardianName: demographics.guardianName.nullable().optional(),
  guardianRelation: demographics.guardianRelation.nullable().optional(),
  guardianMobile: demographics.guardianMobile.nullable().optional(),
  emergencyContactName: demographics.emergencyContactName.nullable().optional(),
  emergencyContactMobile: demographics.emergencyContactMobile.nullable().optional(),
  bloodGroup: demographics.bloodGroup.nullable().optional(),
}).strict().superRefine((v, c) => {
  ageRule(v, c, false);
  if (Object.keys(v).filter((k) => k !== "version").length === 0) c.addIssue({ code: "custom", message: "No changes supplied" });
});

export const searchPatientsSchema = z.object({
  q: z.string().trim().min(2, "Enter at least 2 characters").max(60),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
}).strict();

// ───────────────────────── views ─────────────────────────

const MRN_ONLY = { where: { type: "MRN" as const }, select: { value: true } };
const PATIENT_INCLUDE = {
  identifiers: MRN_ONLY,
  mergedInto: { select: { id: true, identifiers: MRN_ONLY } },
  mergedFrom: { select: { id: true, mergedAt: true, identifiers: MRN_ONLY }, orderBy: { mergedAt: "asc" as const } },
} satisfies Prisma.PatientInclude;
type PatientRow = Prisma.PatientGetPayload<{ include: typeof PATIENT_INCLUDE }>;

const isoDay = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);

export function toPatientView(p: PatientRow) {
  return {
    /** Set on a duplicate that was merged: the real patient to use instead. */
    mergedInto: p.mergedInto ? { id: p.mergedInto.id, mrn: p.mergedInto.identifiers[0]?.value ?? null } : null,
    /** Set on the real patient: the duplicate records linked to it, whose history this chart also shows. */
    mergedFrom: p.mergedFrom.map((m) => ({ id: m.id, mrn: m.identifiers[0]?.value ?? null, mergedAt: m.mergedAt })),
    id: p.id, mrn: p.identifiers[0]?.value ?? null,
    firstName: p.firstName, lastName: p.lastName, gender: p.gender,
    dateOfBirth: isoDay(p.dateOfBirth), age: currentAge(p),
    mobile: p.mobile, addressLine: p.addressLine, city: p.city, district: p.district, state: p.state, postalCode: p.postalCode,
    guardianName: p.guardianName, guardianRelation: p.guardianRelation, guardianMobile: p.guardianMobile,
    emergencyContactName: p.emergencyContactName, emergencyContactMobile: p.emergencyContactMobile,
    bloodGroup: p.bloodGroup, status: p.status, version: p.version, registeredFacilityId: p.registeredFacilityId, createdAt: p.createdAt,
  };
}
export type PatientView = ReturnType<typeof toPatientView>;

export interface DuplicateCandidate {
  patient: Pick<PatientView, "id" | "mrn" | "firstName" | "lastName" | "gender" | "dateOfBirth" | "age" | "mobile">;
  severity: DuplicateSeverity;
  reasons: DuplicateReason[];
  similarity: number;
}

// ───────────────────────── service ─────────────────────────

@Injectable()
export class PatientsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly numbering: NumberingService,
    private readonly idempotency: IdempotencyService,
    private readonly registrationFee: RegistrationFeeService,
  ) {}

  async search(ctx: RequestContext, q: z.infer<typeof searchPatientsSchema>) {
    const text = q.q.trim();
    const digits = text.replace(/\D/g, "");
    const normalized = normalizeName(text);
    const idMatch: Prisma.PatientIdentifierWhereInput = { tenantId: ctx.tenantId, value: { contains: text, mode: "insensitive" } };
    // A merged duplicate is not offered; searching its old number finds the real patient instead.
    const or: Prisma.PatientWhereInput[] = [{ identifiers: { some: idMatch } }, { mergedFrom: { some: { identifiers: { some: idMatch } } } }];
    // Only a letter-free query is read as a phone number: an MRN such as "DEMO-000992" must not also match
    // unrelated patients whose mobile happens to contain its digits.
    if (digits.length >= 3 && !/\p{L}/u.test(text)) or.push({ mobile: { contains: digits } });
    if (digits.length >= 6 && !/\p{L}/u.test(text)) or.push({ abhaLinks: { some: { tenantId: ctx.tenantId, removedAt: null, abhaNumber: { contains: digits } } } });
    if (/\p{L}/u.test(text) && normalized.length >= 2) or.push({ searchName: { contains: normalized } });
    const where: Prisma.PatientWhereInput = { tenantId: ctx.tenantId, mergedIntoId: null, OR: or, AND: [patientScope(ctx)] };
    const [rows, total] = await Promise.all([
      this.prisma.patient.findMany({ where, include: PATIENT_INCLUDE, orderBy: [{ createdAt: "desc" }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      this.prisma.patient.count({ where }),
    ]);
    return { items: rows.map(toPatientView), total };
  }

  async get(ctx: RequestContext, id: string): Promise<PatientView> {
    const p = await this.prisma.patient.findFirst({ where: { id, tenantId: ctx.tenantId, AND: [patientScope(ctx)] }, include: PATIENT_INCLUDE });
    if (!p) throw new DomainError("PATIENT_NOT_FOUND", "Patient not found", 404);
    return toPatientView(p);
  }

  async findDuplicates(db: Db, ctx: RequestContext, probe: z.infer<typeof duplicateProbeSchema>): Promise<DuplicateCandidate[]> {
    const name = normalizeName(probe.firstName, probe.lastName);
    const today = new Date();
    const probeAge = probe.dateOfBirth
      ? currentAge({ dateOfBirth: probe.dateOfBirth, estimatedAgeYears: null, ageRecordedOn: null }, today)
      : { years: probe.estimatedAgeYears ?? 0, estimated: true };
    const mobileParam = probe.mobile ?? null;
    const rows = await db.$queryRaw<{
      id: string; mobile: string | null; gender: string; dateOfBirth: Date | null; estimatedAgeYears: number | null;
      ageRecordedOn: Date | null; similarity: number;
    }[]>`
      SELECT p.id, p.mobile, p.gender::text AS gender, p."dateOfBirth", p."estimatedAgeYears", p."ageRecordedOn",
             similarity(p."searchName", ${name})::float8 AS similarity
      FROM "Patient" p
      WHERE p."tenantId" = ${ctx.tenantId}::uuid AND p.status = 'ACTIVE'
        AND (p."searchName" % ${name} OR (${mobileParam}::text IS NOT NULL AND p.mobile = ${mobileParam}::text))
      ORDER BY similarity DESC
      LIMIT 50`;

    const scored: { id: string; severity: DuplicateSeverity; reasons: DuplicateReason[]; similarity: number }[] = [];
    for (const r of rows) {
      const s = scoreDuplicate(
        { mobile: probe.mobile ?? null, gender: probe.gender, dateOfBirth: probe.dateOfBirth ?? null, age: probeAge },
        { mobile: r.mobile, gender: r.gender, dateOfBirth: r.dateOfBirth, age: currentAge(r, today), similarity: r.similarity },
      );
      if (s) scored.push({ id: r.id, ...s, similarity: Math.round(r.similarity * 100) / 100 });
    }
    scored.sort((a, b) => compareSeverity(a.severity, b.severity) || b.similarity - a.similarity);
    const top = scored.slice(0, 10);
    if (top.length === 0) return [];
    const patients = await db.patient.findMany({ where: { tenantId: ctx.tenantId, id: { in: top.map((t) => t.id) } }, include: PATIENT_INCLUDE });
    const byId = new Map(patients.map((p) => [p.id, toPatientView(p)]));
    return top.flatMap((t) => {
      const v = byId.get(t.id);
      if (!v) return [];
      const { id, mrn, firstName, lastName, gender, dateOfBirth, age, mobile } = v;
      return [{ patient: { id, mrn, firstName, lastName, gender, dateOfBirth, age, mobile }, severity: t.severity, reasons: t.reasons, similarity: t.similarity }];
    });
  }

  async duplicateCheck(ctx: RequestContext, probe: z.infer<typeof duplicateProbeSchema>) {
    return this.findDuplicates(this.prisma, ctx, probe);
  }

  /** `extras.legacyId` is the patient's number in the hospital's previous system (data migration); it is saved as a LEGACY identifier in the same transaction. */
  async create(ctx: RequestContext, input: z.infer<typeof createPatientSchema>, idempotencyKey: string | undefined, extras: { legacyId?: string; /** COLLECT (default): the fee is settled in this same step. PENDING: left for the front desk. NONE: no fee (data migration). */ registration?: RegistrationMode } = {}) {
    const { duplicateOverride, registration, ...fields } = input;
    const { result, replayed } = await this.idempotency.run(ctx.tenantId, "PATIENT_CREATE", idempotencyKey, input, async (tx) => {
      const candidates = await this.findDuplicates(tx, ctx, {
        firstName: fields.firstName, lastName: fields.lastName, gender: fields.gender,
        dateOfBirth: fields.dateOfBirth, estimatedAgeYears: fields.estimatedAgeYears, mobile: fields.mobile,
      });
      if (candidates.length > 0) {
        if (!duplicateOverride) {
          throw new DomainError("DUPLICATE_PATIENT_SUSPECTED", "Possible duplicate patients found. Select an existing patient or confirm this is a different person.", 409, { candidates });
        }
        if (!ctx.permissions.has("DUPLICATE_OVERRIDE")) {
          throw new DomainError("FORBIDDEN", "You do not have permission to register a patient despite possible duplicates", 403);
        }
      }

      const mrn = await this.numbering.next(tx, ctx.tenantId, ctx.facilityId, "MRN");
      const today = new Date();
      const todayDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
      const { dateOfBirth, estimatedAgeYears, ...rest } = fields;
      const created = await tx.patient.create({
        data: {
          ...rest,
          tenantId: ctx.tenantId, registeredFacilityId: ctx.facilityId, createdById: ctx.userId,
          searchName: normalizeName(fields.firstName, fields.lastName),
          dateOfBirth: dateOfBirth ?? null,
          estimatedAgeYears: dateOfBirth ? null : estimatedAgeYears ?? null,
          ageRecordedOn: dateOfBirth ? null : todayDate,
        },
      });
      await tx.patientIdentifier.create({ data: { tenantId: ctx.tenantId, patientId: created.id, type: "MRN", value: mrn } });
      if (extras.legacyId) await tx.patientIdentifier.create({ data: { tenantId: ctx.tenantId, patientId: created.id, type: "LEGACY", value: extras.legacyId } });
      await this.audit.record(tx, actorOf(ctx), { action: "PATIENT_CREATED", entityType: "Patient", entityId: created.id, metadata: { mrn, ...(extras.legacyId ? { legacyId: extras.legacyId } : {}) } });
      // The fee is settled in this same transaction: if it cannot be (no payment given, wrong amount, no open shift for cash), the patient and the Patient ID are not created.
      const fee = await this.registrationFee.onRegister(tx, ctx, created.id, extras.registration ?? "COLLECT", registration);
      const view = { ...toPatientView({ ...created, identifiers: [{ value: mrn }], mergedInto: null, mergedFrom: [] }), registration: fee };
      if (candidates.length > 0 && duplicateOverride) {
        await this.audit.record(tx, actorOf(ctx), {
          action: "PATIENT_DUPLICATE_OVERRIDDEN", entityType: "Patient", entityId: created.id,
          metadata: { candidateIds: candidates.map((c) => c.patient.id), reason: duplicateOverride.reason ?? null },
        });
      }
      return view;
    });
    return { patient: result, replayed };
  }

  async update(ctx: RequestContext, id: string, input: z.infer<typeof updatePatientSchema>): Promise<PatientView> {
    const { version, ...changes } = input;
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.patient.findFirst({ where: { id, tenantId: ctx.tenantId } });
      if (!existing) throw new DomainError("PATIENT_NOT_FOUND", "Patient not found", 404);
      if (existing.mergedIntoId) throw new DomainError("PATIENT_MERGED", "This patient record was merged into another. Update the real patient instead.", 409, { mergedIntoId: existing.mergedIntoId });

      const data: Prisma.PatientUncheckedUpdateManyInput = {};
      const diff: Record<string, [unknown, unknown]> = {};
      const set = <K extends keyof typeof existing>(k: K, v: (typeof existing)[K]) => {
        const before = existing[k];
        const same = before instanceof Date && v instanceof Date ? before.getTime() === v.getTime() : before === v;
        if (!same) { (data as Record<string, unknown>)[k as string] = v; diff[k as string] = [before instanceof Date ? isoDay(before) : before, v instanceof Date ? isoDay(v) : v]; }
      };

      for (const [k, v] of Object.entries(changes)) {
        if (v === undefined || k === "dateOfBirth" || k === "estimatedAgeYears") continue;
        set(k as keyof typeof existing, v as never);
      }
      if (changes.dateOfBirth) {
        set("dateOfBirth", changes.dateOfBirth);
        set("estimatedAgeYears", null);
        set("ageRecordedOn", null);
      } else if (changes.estimatedAgeYears !== undefined) {
        const t = new Date();
        set("estimatedAgeYears", changes.estimatedAgeYears);
        set("ageRecordedOn", new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate())));
        set("dateOfBirth", null);
      }
      if (changes.firstName !== undefined || changes.lastName !== undefined) {
        const first = changes.firstName ?? existing.firstName;
        const last = changes.lastName === undefined ? existing.lastName : changes.lastName;
        data.searchName = normalizeName(first, last);
      }
      if (Object.keys(diff).length === 0) throw new DomainError("VALIDATION_FAILED", "No changes supplied", 400);

      const res = await tx.patient.updateMany({ where: { id, tenantId: ctx.tenantId, version }, data: { ...data, version: { increment: 1 } } });
      if (res.count !== 1) {
        throw new DomainError("STALE_VERSION", "This patient record was changed by someone else. Reload and try again.", 409, { currentVersion: existing.version });
      }
      await this.audit.record(tx, actorOf(ctx), { action: "PATIENT_UPDATED", entityType: "Patient", entityId: id, metadata: { changes: diff as unknown as Prisma.InputJsonObject } });
      const updated = await tx.patient.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId }, include: PATIENT_INCLUDE });
      return toPatientView(updated);
    });
  }
}
