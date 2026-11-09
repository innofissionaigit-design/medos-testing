import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { CONFIG, type AppConfig } from "../../common/config";
import { logJson } from "../../common/logger";
import { PaymentLinksService } from "./payment-links.service";

/**
 * Sends due payment links and cancels unpaid bookings every REMINDER_POLL_SECONDS (it shares the reminder worker's switch and interval).
 * Off in tests (they call PaymentLinksService.runDue directly) and when REMINDER_WORKER_ENABLED=false. Safe on several instances: rows are claimed with SKIP LOCKED.
 */
@Injectable()
export class PaymentLinkWorker implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;
  private busy = false;

  constructor(private readonly links: PaymentLinksService, @Inject(CONFIG) private readonly config: AppConfig) {}

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
      const c = await this.links.runDue();
      if (Object.values(c).some((n) => n > 0)) logJson("info", "payment_links_processed", c);
    } catch (e) {
      logJson("error", "payment_link_worker_failed", { errorName: e instanceof Error ? e.name : typeof e, errorMessage: e instanceof Error ? e.message.slice(0, 300) : undefined });
    } finally {
      this.busy = false;
    }
  }
}
