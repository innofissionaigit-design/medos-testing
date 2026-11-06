import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { CONFIG, type AppConfig } from "../../common/config";
import { logJson } from "../../common/logger";
import { EmailService } from "./email.service";

/**
 * Sends queued emails every EMAIL_POLL_SECONDS. Off in tests (they call EmailService.runDue directly) and when EMAIL_WORKER_ENABLED=false.
 * Safe on several instances: delivery claims rows with SKIP LOCKED.
 */
@Injectable()
export class EmailWorker implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;
  private busy = false;

  constructor(private readonly email: EmailService, @Inject(CONFIG) private readonly config: AppConfig) {}

  onModuleInit(): void {
    if (this.config.NODE_ENV === "test" || !this.config.EMAIL_WORKER_ENABLED) return;
    this.timer = setInterval(() => void this.tick(), this.config.EMAIL_POLL_SECONDS * 1000);
    this.timer.unref(); // never keeps a CLI process (seed, provision) alive
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const c = await this.email.runDue();
      if (c.sent + c.skipped + c.retried + c.failed > 0) logJson("info", "emails_processed", c);
    } catch (e) {
      logJson("error", "email_worker_failed", { errorName: e instanceof Error ? e.name : typeof e, errorMessage: e instanceof Error ? e.message.slice(0, 300) : undefined });
    } finally {
      this.busy = false;
    }
  }
}
