/** When a video consultation can be joined (docs/telemedicine.md): from a quarter of an hour before the appointment until an hour and a half after it starts. */
export const JOIN_BEFORE_MINUTES = 15;
export const JOIN_AFTER_MINUTES = 90;

export interface JoinWindow { open: boolean; opensAt: Date; closesAt: Date }

export function joinWindow(scheduledAt: Date, now: Date): JoinWindow {
  const opensAt = new Date(scheduledAt.getTime() - JOIN_BEFORE_MINUTES * 60_000);
  const closesAt = new Date(scheduledAt.getTime() + JOIN_AFTER_MINUTES * 60_000);
  return { open: now >= opensAt && now <= closesAt, opensAt, closesAt };
}

/** The full link to a consultation's room: the hospital's template with {room} replaced by the consultation's random room name. */
export function roomUrl(template: string, roomToken: string): string {
  return template.replace("{room}", `medos-${roomToken}`);
}

/** An appointment can still have its video call while it has not been cancelled, missed or finished. */
export const LIVE_APPOINTMENT = ["BOOKED", "CHECKED_IN", "WAITING", "IN_CONSULTATION"] as const;

/** The wording version of the consent a patient agrees to before a video consultation; recorded with the agreement so a later change never rewrites it. */
export const CONSENT_VERSION = "TELE-1";

/** How the doctor confirmed who they are talking to, recorded before the call starts. */
export const IDENTITY_METHODS = ["KNOWN_PATIENT", "PHOTO_ID_SHOWN", "APP_SIGN_IN", "OTHER"] as const;
export type IdentityMethod = (typeof IDENTITY_METHODS)[number];
