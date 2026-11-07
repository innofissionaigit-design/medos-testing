import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { afterCommit } from "./after-commit";

describe("afterCommit", () => {
  it("fires hooks only after the transaction has finished, in order", async () => {
    const log: string[] = [];
    const out = await afterCommit.around(async () => {
      afterCommit.run(() => log.push("hook 1"));
      await Promise.resolve();
      afterCommit.run(() => log.push("hook 2"));
      log.push("work done");
      return 42;
    });
    assert.equal(out, 42);
    assert.deepEqual(log, ["work done", "hook 1", "hook 2"]);
  });

  it("drops the hooks when the transaction fails", async () => {
    const log: string[] = [];
    await assert.rejects(afterCommit.around(async () => {
      afterCommit.run(() => log.push("must not fire"));
      throw new Error("rolled back");
    }), /rolled back/);
    assert.deepEqual(log, []);
  });

  it("runs at once when there is no transaction", () => {
    const log: string[] = [];
    afterCommit.run(() => log.push("now"));
    assert.deepEqual(log, ["now"]);
  });

  it("keeps two overlapping transactions apart, and a failing hook does not fail the commit", async () => {
    const log: string[] = [];
    const slow = afterCommit.around(async () => { afterCommit.run(() => log.push("slow")); await new Promise((r) => setTimeout(r, 30)); return "slow"; });
    const failing = afterCommit.around(async () => { afterCommit.run(() => { throw new Error("hook bug"); }); afterCommit.run(() => log.push("after the failing hook")); return "fast"; });
    assert.equal(await failing, "fast");
    assert.deepEqual(log, ["after the failing hook"], "the other transaction's hook has not fired yet");
    assert.equal(await slow, "slow");
    assert.deepEqual(log, ["after the failing hook", "slow"]);
  });
});
