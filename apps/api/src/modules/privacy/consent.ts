import type { Db } from "../../common/prisma.service";
import { chartPatientIds } from "../patients/patient-links";

export type ReminderConsentState = "GRANTED" | "WITHDRAWN" | "NONE";

/** The newest recorded decision about appointment reminders for a patient, across the patient and any duplicate record linked to it. */
export async function reminderConsentState(db: Db, tenantId: string, patientId: string): Promise<ReminderConsentState> {
  const ids = (await chartPatientIds(db, tenantId, patientId)) ?? [patientId];
  const latest = await db.patientConsent.findFirst({
    where: { tenantId, patientId: { in: ids }, purpose: "APPOINTMENT_REMINDERS" },
    orderBy: [{ recordedAt: "desc" }, { id: "desc" }],
    select: { status: true },
  });
  return latest ? latest.status : "NONE";
}

/**
 * Whether a reminder SMS may be sent. A patient who withdrew never gets one. With no record on file the hospital's own setting decides
 * (REMINDERS_REQUIRE_CONSENT: off = reminders are sent unless the patient objects, on = only to patients who agreed). Which of the two
 * is right is a legal decision recorded as pending in docs/reviews/pending-decisions.md.
 */
export function remindersAllowed(state: ReminderConsentState, requireConsent: boolean): boolean {
  if (state === "WITHDRAWN") return false;
  if (state === "GRANTED") return true;
  return !requireConsent;
}
