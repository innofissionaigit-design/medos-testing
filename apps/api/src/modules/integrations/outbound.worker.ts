import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { CONFIG, type AppConfig } from "../../common/config";
import { logJson } from "../../common/logger";
import { PrescriptionDeliveryService } from "../prescriptions/prescription-delivery.service";
import { WebhooksService } from "./webhooks.service";

/**
 * Sends what is waiting to go out: webhook deliveries to integrations and prescription messages to patients, every REMINDER_POLL_SECONDS (the same settings as the
 * reminder worker). Off in tests (they call runDue directly) and when REMINDER_WORKER_ENABLED=false. Safe on several servers: rows are claimed with SKIP LOCKED.
 */
@Injectable()
export class OutboundWorker implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;
  private busy = false;

  constructor(private readonly webhooks: WebhooksService, private readonly deliveries: PrescriptionDeliveryService, @Inject(CONFIG) private readonly config: AppConfig) {}

  onModuleInit(): void {
    if (this.config.NODE_ENV === "test" || !this.config.REMINDER_WORKER_ENABLED) return;
    this.timer = setInterval(() => void this.tick(), this.config.REMINDER_POLL_SECONDS * 1000);
    this.timer.unref(); // never keeps a CLI process (seed, provision) alive
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const w = await this.webhooks.runDue();
      const m = await this.deliveries.runDue();
      if (w.delivered + w.retried + w.failed + m.sent + m.retried + m.failed > 0) logJson("info", "outbound_processed", { webhooks: w, messages: m });
    } catch (e) {
      logJson("error", "outbound_worker_failed", { errorName: e instanceof Error ? e.name : typeof e, errorMessage: e instanceof Error ? e.message.slice(0, 300) : undefined });
    } finally {
      this.busy = false;
    }
  }
}
