import { AsyncLocalStorage } from "node:async_hooks";
import { logJson } from "./logger";

type Hook = () => void;

const store = new AsyncLocalStorage<Hook[]>();

function runHook(hook: Hook): void {
  try {
    hook();
  } catch (e) {
    // A failing hook must never turn a committed transaction into a failed request; it is logged, not hidden.
    logJson("error", "after_commit_hook_failed", { message: e instanceof Error ? e.message : "unknown" });
  }
}

/**
 * Work that must happen only once the database transaction around it has really committed, for example telling an open browser
 * that something new exists (docs/notifications.md). If the transaction rolls back, the work is dropped.
 */
export const afterCommit = {
  /** Runs `fn` after the surrounding transaction commits. Outside a transaction there is nothing to wait for, so it runs at once. */
  run(fn: Hook): void {
    const hooks = store.getStore();
    if (hooks) hooks.push(fn); else runHook(fn);
  },

  /** Wraps one transaction: collects the hooks registered while it runs and fires them only after it resolves. */
  async around<T>(transaction: () => Promise<T>): Promise<T> {
    const hooks: Hook[] = [];
    const result = await store.run(hooks, transaction);
    for (const hook of hooks) runHook(hook);
    return result;
  },
};
