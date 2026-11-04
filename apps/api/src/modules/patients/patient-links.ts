import type { Db } from "../../common/prisma.service";

/**
 * Patient merge is a link, not a move (docs/patient-merge.md): a duplicate keeps every record it ever had and points at the real patient.
 * Anything that shows "this patient's" history or safety information must read the real patient's own id AND the ids linked to it.
 */
export async function linkedPatientIds(db: Db, tenantId: string, patientId: string): Promise<string[]> {
  const rows = await db.patient.findMany({ where: { tenantId, mergedIntoId: patientId }, select: { id: true } });
  return [patientId, ...rows.map((r) => r.id)];
}

/**
 * The ids whose records make up one patient's chart: the real patient and every duplicate linked to it. Asking with a merged duplicate's id
 * gives the real patient's chart. Null when the patient does not exist in this hospital.
 */
export async function chartPatientIds(db: Db, tenantId: string, patientId: string): Promise<string[] | null> {
  const p = await db.patient.findFirst({ where: { id: patientId, tenantId }, select: { id: true, mergedIntoId: true } });
  return p ? linkedPatientIds(db, tenantId, p.mergedIntoId ?? p.id) : null;
}

/** For a list of patients: each one's own id plus the ids linked to it, in one query. */
export async function linkedIdsByPatient(db: Db, tenantId: string, patientIds: string[]): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>(patientIds.map((id) => [id, [id]]));
  if (patientIds.length === 0) return map;
  const rows = await db.patient.findMany({ where: { tenantId, mergedIntoId: { in: patientIds } }, select: { id: true, mergedIntoId: true } });
  for (const r of rows) if (r.mergedIntoId) map.get(r.mergedIntoId)?.push(r.id);
  return map;
}
