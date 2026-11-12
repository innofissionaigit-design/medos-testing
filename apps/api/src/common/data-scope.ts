import { Prisma } from "@medos/database";
import { DomainError, type Permission } from "@medos/shared";
import type { Db } from "./prisma.service";
import type { DataScope, RequestContext } from "./request-context";

/**
 * Who may see which clinical data (docs/data-access.md).
 *  - DATA_SCOPE_ALL (the organisation administrator) sees everything.
 *  - DATA_SCOPE_WARD (the resident medical officer) is not narrowed to their own patients even though they are a registered practitioner.
 *  - A doctor sees only the patients, visits, records and reports of their own practitioner record.
 *  - Anyone else assigned to departments sees only those departments.
 *  - Staff who are neither (Reception, Cashier, Pharmacist, Nurse, Manager without a department) keep the access their role gives.
 * Everything here is derived from the session on the server; nothing comes from the request.
 */
export function resolveDataScope(permissions: ReadonlySet<Permission>, practitionerIds: readonly string[], departmentIds: readonly string[]): DataScope {
  // DATA_SCOPE_WARD (the resident medical officer) is a registered practitioner who covers the whole ward, so being a practitioner
  // must not narrow them to "my own patients".
  if (permissions.has("DATA_SCOPE_ALL") || permissions.has("DATA_SCOPE_WARD")) return { kind: "ALL" };
  if (practitionerIds.length > 0) return { kind: "DOCTOR", practitionerIds: [...practitionerIds] };
  if (departmentIds.length > 0) return { kind: "DEPARTMENT", departmentIds: [...departmentIds] };
  return { kind: "ALL" };
}

export const isRestricted = (ctx: RequestContext): boolean => ctx.dataScope.kind !== "ALL";

/** Appointments, visits and queue entries: they all carry a doctor and, optionally, a department. */
export function visitScope(ctx: RequestContext): { practitionerId?: { in: string[] }; OR?: { departmentId?: { in: string[] }; practitioner?: { departmentId: { in: string[] } } }[] } {
  const s = ctx.dataScope;
  if (s.kind === "ALL") return {};
  if (s.kind === "DOCTOR") return { practitionerId: { in: [...s.practitionerIds] } };
  const d = [...s.departmentIds];
  return { OR: [{ departmentId: { in: d } }, { practitioner: { departmentId: { in: d } } }] };
}

/** Admissions: the consultant is the doctor. */
export function admissionScope(ctx: RequestContext): Prisma.AdmissionWhereInput {
  const s = ctx.dataScope;
  if (s.kind === "ALL") return {};
  if (s.kind === "DOCTOR") return { consultantId: { in: [...s.practitionerIds] } };
  const d = [...s.departmentIds];
  return { OR: [{ departmentId: { in: d } }, { consultant: { departmentId: { in: d } } }] };
}

/**
 * A patient belongs to whoever treats them: a patient is visible when they have a visit, an appointment or an admission in scope
 * (also under a record that was merged into them).
 */
export function patientScope(ctx: RequestContext): Prisma.PatientWhereInput {
  if (ctx.dataScope.kind === "ALL") return {};
  const visit = visitScope(ctx);
  const adm = admissionScope(ctx);
  const own: Prisma.PatientWhereInput[] = [{ encounters: { some: visit } }, { appointments: { some: visit } }, { admissions: { some: adm } }];
  return { OR: [...own, { mergedFrom: { some: { OR: own } } }] };
}

const notFound = (): DomainError => new DomainError("NOT_FOUND", "Resource not found", 404);

/** A record outside the caller's scope looks exactly like one that does not exist. */
export async function assertEncounterVisible(db: Db, ctx: RequestContext, encounterId: string): Promise<void> {
  if (!isRestricted(ctx)) return;
  const hit = await db.encounter.findFirst({ where: { id: encounterId, tenantId: ctx.tenantId, ...visitScope(ctx) }, select: { id: true } });
  if (!hit) throw notFound();
}

export async function assertPatientVisible(db: Db, ctx: RequestContext, patientId: string): Promise<void> {
  if (!isRestricted(ctx)) return;
  const hit = await db.patient.findFirst({ where: { id: patientId, tenantId: ctx.tenantId, ...patientScope(ctx) }, select: { id: true } });
  if (!hit) throw new DomainError("PATIENT_NOT_FOUND", "Patient not found", 404);
}

/** SQL conditions for the raw-SQL reports. `alias` is the table alias of an Encounter/Appointment row (a fixed identifier, never user input). */
export function visitScopeSql(ctx: RequestContext, alias: "e" | "a"): Prisma.Sql {
  const s = ctx.dataScope;
  if (s.kind === "ALL") return Prisma.empty;
  const col = Prisma.raw(`${alias}."practitionerId"`);
  const dep = Prisma.raw(`${alias}."departmentId"`);
  const tenant = Prisma.raw(`${alias}."tenantId"`);
  if (s.kind === "DOCTOR") return Prisma.sql`AND ${col} = ANY(${[...s.practitionerIds]}::uuid[])`;
  const d = [...s.departmentIds];
  return Prisma.sql`AND (${dep} = ANY(${d}::uuid[]) OR ${col} IN (SELECT pr.id FROM "Practitioner" pr WHERE pr."tenantId" = ${tenant} AND pr."departmentId" = ANY(${d}::uuid[])))`;
}

/** The same for Admission rows (alias `a`): the consultant is the doctor. */
export function admissionScopeSql(ctx: RequestContext): Prisma.Sql {
  const s = ctx.dataScope;
  if (s.kind === "ALL") return Prisma.empty;
  if (s.kind === "DOCTOR") return Prisma.sql`AND a."consultantId" = ANY(${[...s.practitionerIds]}::uuid[])`;
  const d = [...s.departmentIds];
  return Prisma.sql`AND (a."departmentId" = ANY(${d}::uuid[]) OR a."consultantId" IN (SELECT pr.id FROM "Practitioner" pr WHERE pr."tenantId" = a."tenantId" AND pr."departmentId" = ANY(${d}::uuid[])))`;
}
