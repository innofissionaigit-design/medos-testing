import { Injectable } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import { z } from "zod";
import { PrismaService } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { localDateStr } from "../../common/time";
import { createPatientSchema, PatientsService } from "../patients/patients.service";
import { currentAge, normalizeMobile } from "../patients/patient.domain";
import { AppointmentsService } from "./appointments.service";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
export const doctorsQuerySchema = z.object({
  date: day.optional(), departmentId: z.string().uuid().optional(),
  /** How many of each doctor's next free times to return. */
  slots: z.coerce.number().int().min(1).max(20).default(5),
}).strict();
export const patientLookupSchema = z.object({ mobile: z.string().trim().min(6).max(20) }).strict();
/** Only these fields can be sent by an API client; everything else (address, guardian, duplicate override…) is refused. */
export const registerPatientSchema = z.object({
  firstName: z.string(), lastName: z.string().optional(), gender: z.string(), mobile: z.string(),
  dateOfBirth: z.string().optional(), estimatedAgeYears: z.number().optional(),
}).strict();

/** The least that is needed to confirm "is this the person who is calling?": first name, last initial, gender and age. No address, no date of birth. */
interface MinimalPatient { id: string; mrn: string | null; firstName: string; lastInitial: string | null; gender: string; ageYears: number }
const minimal = (p: { id: string; firstName: string; lastName: string | null; gender: string; dateOfBirth: Date | null; estimatedAgeYears: number | null; ageRecordedOn: Date | null; identifiers: { value: string }[] }): MinimalPatient => ({
  id: p.id, mrn: p.identifiers[0]?.value ?? null, firstName: p.firstName, lastInitial: p.lastName ? `${p.lastName.charAt(0).toUpperCase()}.` : null, gender: p.gender, ageYears: currentAge(p).years,
});

/**
 * What an outside system or a voice bot needs to book an appointment in few calls (docs/integration-api.md): doctors with their next free times, a
 * minimal patient lookup by mobile number, and minimal patient registration. Deliberately small: these never return addresses, dates of birth or
 * other patients' details.
 */
@Injectable()
export class BookingApiService {
  constructor(private readonly prisma: PrismaService, private readonly appointments: AppointmentsService, private readonly patients: PatientsService) {}

  async doctors(ctx: RequestContext, q: z.infer<typeof doctorsQuerySchema>) {
    const facility = await this.prisma.facility.findFirstOrThrow({ where: { id: ctx.facilityId, tenantId: ctx.tenantId }, select: { timezone: true } });
    const date = q.date ?? localDateStr(new Date(), facility.timezone);
    const rows = await this.prisma.practitioner.findMany({
      where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "ACTIVE", ...(q.departmentId ? { departmentId: q.departmentId } : {}) },
      select: { id: true, displayName: true, specialty: true, department: { select: { id: true, name: true } } }, orderBy: { displayName: "asc" }, take: 60,
    });
    const items = await Promise.all(rows.map(async (d) => {
      const slots = await this.appointments.availability(ctx, d.id, date);
      return { id: d.id, name: d.displayName, specialty: d.specialty, department: d.department, date, nextFreeTimes: slots.filter((s) => s.available).slice(0, q.slots).map(({ startAt, endAt }) => ({ startAt, endAt })) };
    }));
    return { date, timezone: facility.timezone, doctors: items };
  }

  /** Patients with exactly this mobile number (active, not merged into another record), as minimal details. */
  async findByMobile(ctx: RequestContext, q: z.infer<typeof patientLookupSchema>) {
    const mobile = normalizeMobile(q.mobile);
    if (!mobile) throw new DomainError("VALIDATION_FAILED", "Enter a valid 10-digit Indian mobile number", 400, [{ path: "mobile", message: "Invalid mobile number" }]);
    const rows = await this.prisma.patient.findMany({
      where: { tenantId: ctx.tenantId, mobile, status: "ACTIVE", mergedIntoId: null },
      select: { id: true, firstName: true, lastName: true, gender: true, dateOfBirth: true, estimatedAgeYears: true, ageRecordedOn: true, identifiers: { where: { type: "MRN" }, select: { value: true } } },
      orderBy: { createdAt: "asc" }, take: 10,
    });
    return rows.map(minimal);
  }

  /**
   * Registers a patient for booking. The normal duplicate check applies and cannot be overridden here; when it finds someone, the answer is the same
   * "possible duplicate" error but lists the matches as minimal details only, so a bot is never handed another patient's full record.
   */
  async register(ctx: RequestContext, input: z.infer<typeof registerPatientSchema>, key: string | undefined) {
    const parsed = createPatientSchema.safeParse(input);
    if (!parsed.success) throw new DomainError("VALIDATION_FAILED", "Request validation failed", 400, parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
    try {
      const { patient, replayed } = await this.patients.create(ctx, parsed.data, key, { registration: "PENDING" });
      const row = await this.prisma.patient.findFirstOrThrow({
        where: { id: patient.id, tenantId: ctx.tenantId },
        select: { id: true, firstName: true, lastName: true, gender: true, dateOfBirth: true, estimatedAgeYears: true, ageRecordedOn: true, identifiers: { where: { type: "MRN" }, select: { value: true } } },
      });
      return { patient: minimal(row), replayed };
    } catch (e) {
      if (e instanceof DomainError && e.code === "DUPLICATE_PATIENT_SUSPECTED") {
        const ids = ((e.details as { candidates?: { patient: { id: string } }[] } | undefined)?.candidates ?? []).map((c) => c.patient.id);
        const rows = await this.prisma.patient.findMany({
          where: { tenantId: ctx.tenantId, id: { in: ids } },
          select: { id: true, firstName: true, lastName: true, gender: true, dateOfBirth: true, estimatedAgeYears: true, ageRecordedOn: true, identifiers: { where: { type: "MRN" }, select: { value: true } } },
        });
        throw new DomainError("DUPLICATE_PATIENT_SUSPECTED", "This looks like a patient who is already registered. Use the existing patient, or ask the front desk to register them.", 409, { matches: rows.map(minimal) });
      }
      throw e;
    }
  }
}
