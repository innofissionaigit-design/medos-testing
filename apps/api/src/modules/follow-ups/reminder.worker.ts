import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { CONFIG, type AppConfig } from "../../common/config";
import { logJson } from "../../common/logger";
import { RemindersService } from "./reminders.service";

/**
 * Polls for due follow-up reminders every REMINDER_POLL_SECONDS. Off in tests (they call RemindersService.runDue
 * directly) and when REMINDER_WORKER_ENABLED=false. Safe on several instances: delivery claims rows with SKIP LOCKED.
 */
@Injectable()
export class ReminderWorker implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;
  private busy = false;

  constructor(private readonly reminders: RemindersService, @Inject(CONFIG) private readonly config: AppConfig) {}

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
      const c = await this.reminders.runDue();
      if (c.sent + c.skipped + c.retried + c.failed > 0) logJson("info", "reminders_processed", c);
    } catch (e) {
      logJson("error", "reminder_worker_failed", { errorName: e instanceof Error ? e.name : typeof e, errorMessage: e instanceof Error ? e.message.slice(0, 300) : undefined });
    } finally {
      this.busy = false;
    }
  }
}
