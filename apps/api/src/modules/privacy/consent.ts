import type { Db, PrismaService } from "../../common/prisma.service";
import { chartPatientIds } from "../patients/patient-links";

export type ConsentState = "GRANTED" | "WITHDRAWN" | "NONE";

/** The newest recorded decision about one purpose for a patient, across the patient and any duplicate record linked to it. */
async function consentState(db: Db | PrismaService, tenantId: string, patientId: string, purpose: "APPOINTMENT_REMINDERS" | "EMAIL_MESSAGES"): Promise<ConsentState> {
  const ids = (await chartPatientIds(db, tenantId, patientId)) ?? [patientId];
  const latest = await db.patientConsent.findFirst({
    where: { tenantId, patientId: { in: ids }, purpose },
    orderBy: [{ recordedAt: "desc" }, { id: "desc" }],
    select: { status: true },
  });
  return latest ? latest.status : "NONE";
}

/** The newest recorded decision about appointment reminders. */
export const reminderConsentState = (db: Db | PrismaService, tenantId: string, patientId: string): Promise<ConsentState> => consentState(db, tenantId, patientId, "APPOINTMENT_REMINDERS");

/** The newest recorded decision about email (docs/email.md). */
export const emailConsentState = (db: Db | PrismaService, tenantId: string, patientId: string): Promise<ConsentState> => consentState(db, tenantId, patientId, "EMAIL_MESSAGES");

/**
 * Whether a reminder SMS may be sent. A patient who withdrew never gets one. With no record on file the hospital's own setting decides
 * (REMINDERS_REQUIRE_CONSENT: off = reminders are sent unless the patient objects, on = only to patients who agreed). Which of the two
 * is right is a legal decision recorded as pending in docs/reviews/pending-decisions.md.
 */
export function remindersAllowed(state: ConsentState, requireConsent: boolean): boolean {
  if (state === "WITHDRAWN") return false;
  if (state === "GRANTED") return true;
  return !requireConsent;
}
