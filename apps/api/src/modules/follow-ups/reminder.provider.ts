import { logJson } from "../../common/logger";

/** One outgoing reminder. `to` is the patient's normalised 10-digit Indian mobile; `text` is the complete message. */
export interface ReminderMessage { reminderId: string; appointmentId: string; to: string; text: string }
export interface ReminderDelivery { providerMessageId: string }

/**
 * Delivery channel for follow-up reminders (docs/follow-ups.md explains how to add a real SMS gateway).
 * Implementations throw on failure so the worker can retry, finish well inside the 30 s transaction timeout,
 * and never log message text or full phone numbers.
 */
export interface ReminderProvider {
  readonly name: string;
  send(message: ReminderMessage): Promise<ReminderDelivery>;
}

export const REMINDER_PROVIDER = Symbol("REMINDER_PROVIDER");

/** Message ids from the log-only provider carry this prefix, so the UI can say that nothing was actually sent. */
export const LOG_ONLY_PREFIX = "log-only:";

export const maskMobile = (m: string): string => (m.length > 4 ? `${"*".repeat(m.length - 4)}${m.slice(-4)}` : "****");

/** Default when no SMS gateway is configured: records the reminder and writes a log line. Nothing leaves the server. */
export class LogReminderProvider implements ReminderProvider {
  readonly name = "log";

  async send(m: ReminderMessage): Promise<ReminderDelivery> {
    logJson("info", "reminder_logged_not_sent", { reminderId: m.reminderId, appointmentId: m.appointmentId, to: maskMobile(m.to) });
    return { providerMessageId: `${LOG_ONLY_PREFIX}${m.reminderId}` };
  }
}

export function createReminderProvider(name: "log"): ReminderProvider {
  switch (name) {
    case "log": return new LogReminderProvider();
  }
}
