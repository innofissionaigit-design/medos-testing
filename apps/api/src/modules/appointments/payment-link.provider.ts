import { logJson } from "../../common/logger";
import { LOG_ONLY_PREFIX, maskMobile } from "../follow-ups/reminder.provider";

/** One outgoing payment-link message. `to` is the patient's normalised 10-digit Indian mobile; `text` is the complete message. */
export interface PaymentLinkMessage { linkId: string; appointmentId: string; to: string; text: string }
export interface PaymentLinkDelivery { providerMessageId: string }

/**
 * Delivery channel for booking payment links (docs/booking-payment-link.md explains how to add the real WhatsApp provider).
 * Implementations throw on failure so the worker can retry, finish well inside the transaction timeout, and never log message text or full phone numbers.
 */
export interface PaymentLinkProvider {
  readonly name: string;
  send(message: PaymentLinkMessage): Promise<PaymentLinkDelivery>;
}

export const PAYMENT_LINK_PROVIDER = Symbol("PAYMENT_LINK_PROVIDER");

/**
 * PLACEHOLDER. The default until a WhatsApp provider is connected: records the message and writes a log line; nothing leaves the server
 * and the link in the text does not lead anywhere. Message ids carry LOG_ONLY_PREFIX so the screens can say that nothing was sent.
 */
export class LogPaymentLinkProvider implements PaymentLinkProvider {
  readonly name = "log";

  async send(m: PaymentLinkMessage): Promise<PaymentLinkDelivery> {
    logJson("info", "payment_link_logged_not_sent", { linkId: m.linkId, appointmentId: m.appointmentId, to: maskMobile(m.to) });
    return { providerMessageId: `${LOG_ONLY_PREFIX}${m.linkId}` };
  }
}

export function createPaymentLinkProvider(name: "log"): PaymentLinkProvider {
  switch (name) {
    case "log": return new LogPaymentLinkProvider();
  }
}
