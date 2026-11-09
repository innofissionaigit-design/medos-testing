import { DomainError } from "@medos/shared";
import type { Db } from "../../common/prisma.service";
import { endOfLocalDay, localDateStr, startOfLocalDay } from "../../common/time";
import { currentAge, normalizeName, scoreDuplicate } from "../patients/patient.domain";

/**
 * Duplicate-booking check (docs/duplicate-booking.md). The same person registered twice (for example with a different mobile number) can otherwise
 * hold two bookings. A booking is suspect when this patient, or a patient who looks like the same person (similar name with the same date of birth,
 * or the same gender and an age within two years; the mobile number is deliberately ignored), already has:
 *  - SAME_DOCTOR: a live booking with the same doctor that has not ended yet, or
 *  - SAME_DEPARTMENT_SAME_DAY: a live booking with another doctor of the same department on the same day.
 */
export type DuplicateRule = "SAME_DOCTOR" | "SAME_DEPARTMENT_SAME_DAY";
export interface DuplicateBookingMatch {
  appointmentId: string; startAt: Date; doctor: string; patientId: string; mrn: string | null; patientName: string;
  rule: DuplicateRule; match: "SAME_PATIENT" | "LIKELY_SAME_PERSON";
}

export async function findDuplicateBookings(
  db: Db, scope: { tenantId: string; facilityId: string; tz: string },
  probe: { patientId: string; practitionerId: string; departmentId: string | null; startAt: Date; endAt: Date; excludeAppointmentId?: string },
  now = new Date(),
): Promise<DuplicateBookingMatch[]> {
  const p = await db.patient.findFirst({ where: { id: probe.patientId, tenantId: scope.tenantId }, select: { firstName: true, lastName: true, gender: true, dateOfBirth: true, estimatedAgeYears: true, ageRecordedOn: true } });
  if (!p) return [];
  const name = normalizeName(p.firstName, p.lastName);
  const day = localDateStr(probe.startAt, scope.tz);
  const dayStart = startOfLocalDay(day, scope.tz);
  const dayEnd = endOfLocalDay(day, scope.tz);
  const rows = await db.$queryRaw<{
    id: string; startAt: Date; endAt: Date; practitionerId: string; patientId: string; doctor: string; firstName: string; lastName: string | null;
    gender: string; dateOfBirth: Date | null; estimatedAgeYears: number | null; ageRecordedOn: Date | null; mrn: string | null; similarity: number;
  }[]>`
    SELECT a.id, a."startAt", a."endAt", a."practitionerId", a."patientId", pr."displayName" AS doctor,
           pt."firstName", pt."lastName", pt.gender::text AS gender, pt."dateOfBirth", pt."estimatedAgeYears", pt."ageRecordedOn",
           (SELECT i.value FROM "PatientIdentifier" i WHERE i."tenantId" = pt."tenantId" AND i."patientId" = pt.id AND i.type = 'MRN' LIMIT 1) AS mrn,
           similarity(pt."searchName", ${name})::float8 AS similarity
    FROM "Appointment" a
    JOIN "Patient" pt ON pt.id = a."patientId" AND pt."tenantId" = a."tenantId"
    JOIN "Practitioner" pr ON pr.id = a."practitionerId"
    WHERE a."tenantId" = ${scope.tenantId}::uuid AND a."facilityId" = ${scope.facilityId}::uuid
      AND a.status IN ('BOOKED', 'CHECKED_IN', 'WAITING', 'IN_CONSULTATION')
      AND a.id <> COALESCE(${probe.excludeAppointmentId ?? null}::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
      AND ((a."practitionerId" = ${probe.practitionerId}::uuid AND a."endAt" > ${now})
        OR (${probe.departmentId}::uuid IS NOT NULL AND a."departmentId" = ${probe.departmentId}::uuid AND a."practitionerId" <> ${probe.practitionerId}::uuid
            AND a."startAt" >= ${dayStart} AND a."startAt" < ${dayEnd}))
      AND (a."patientId" = ${probe.patientId}::uuid OR pt."searchName" % ${name})
    ORDER BY a."startAt" LIMIT 50`;

  const probeAge = currentAge(p, now);
  const out: DuplicateBookingMatch[] = [];
  for (const r of rows) {
    const same = r.patientId === probe.patientId;
    // The same patient at the same time is already refused by the database's overlap guard (SLOT_UNAVAILABLE); that existing answer is kept.
    if (same && r.startAt < probe.endAt && r.endAt > probe.startAt) continue;
    if (!same) {
      // Mobile numbers are left out on purpose: the case this catches is the same person registered with a different number.
      const s = scoreDuplicate(
        { mobile: null, gender: p.gender, dateOfBirth: p.dateOfBirth, age: probeAge },
        { mobile: null, gender: r.gender, dateOfBirth: r.dateOfBirth, age: currentAge(r, now), similarity: r.similarity },
      );
      if (!s || s.severity === "LOW") continue;
    }
    out.push({
      appointmentId: r.id, startAt: r.startAt, doctor: r.doctor, patientId: r.patientId, mrn: r.mrn, patientName: [r.firstName, r.lastName].filter(Boolean).join(" "),
      rule: r.practitionerId === probe.practitionerId ? "SAME_DOCTOR" : "SAME_DEPARTMENT_SAME_DAY", match: same ? "SAME_PATIENT" : "LIKELY_SAME_PERSON",
    });
  }
  return out;
}

/** Stops a suspected duplicate unless the user deliberately overrides it with a reason (needs DUPLICATE_OVERRIDE). */
export function assertNoDuplicateBooking(matches: DuplicateBookingMatch[], override: { reason: string } | undefined, permissions: ReadonlySet<string>): void {
  if (matches.length === 0) return;
  if (!override) {
    const first = matches[0] as DuplicateBookingMatch;
    const what = first.rule === "SAME_DOCTOR" ? "with the same doctor" : "with another doctor of the same department on the same day";
    const who = first.match === "SAME_PATIENT" ? "This patient already has" : `A patient who looks like the same person (MRN ${first.mrn ?? "-"}) already has`;
    throw new DomainError("DUPLICATE_BOOKING_SUSPECTED", `${who} a booking ${what}. Use that booking, or book anyway with a reason.`, 409, { matches });
  }
  if (!permissions.has("DUPLICATE_OVERRIDE")) throw new DomainError("FORBIDDEN", "You do not have permission to book despite a possible duplicate", 403);
}
