import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { loadConfig } from "./config";
import { RATE_LIMIT, type RateLimitOptions } from "./http";
import { RateLimitGuard } from "./rate-limit.guard";
import { DatabaseRateLimitStore } from "./rate-limit.store";
import type { PrismaService } from "./prisma.service";
import { startApp, type TestApp } from "../test/harness";

describe("shared rate limiter", () => {
  let t: TestApp;
  const key = () => `ip:test-${randomUUID()}|POST|/auth/login`;

  before(async () => { t = await startApp(); });
  after(async () => { await t.close(); });

  it("two API instances count against one allowance", async () => {
    const a = new DatabaseRateLimitStore(t.prisma);
    const b = new DatabaseRateLimitStore(t.prisma);
    const k = key();
    const counts = [await a.hit(k, 60_000), await b.hit(k, 60_000), await a.hit(k, 60_000), await b.hit(k, 60_000)];
    assert.deepEqual(counts, [1, 2, 3, 4], "each instance sees the other's requests");
    assert.equal(await a.hit(key(), 60_000), 1, "other keys have their own allowance");
  });

  it("simultaneous requests are counted exactly once each", async () => {
    const stores = [new DatabaseRateLimitStore(t.prisma), new DatabaseRateLimitStore(t.prisma), new DatabaseRateLimitStore(t.prisma)];
    const k = key();
    const counts = await Promise.all(Array.from({ length: 30 }, (_, i) => stores[i % 3]!.hit(k, 60_000)));
    assert.deepEqual([...counts].sort((x, y) => x - y), Array.from({ length: 30 }, (_, i) => i + 1), "no request is lost or counted twice");
  });

  it("the window resets after it expires and uses the database clock", async () => {
    const s = new DatabaseRateLimitStore(t.prisma);
    const k = key();
    assert.equal(await s.hit(k, 300), 1);
    assert.equal(await s.hit(k, 300), 2);
    await new Promise((r) => setTimeout(r, 450));
    assert.equal(await s.hit(k, 300), 1, "a new window starts at one");
    const row = await t.prisma.$queryRaw<{ ok: boolean }[]>`SELECT "resetAt" > now() AS ok FROM "RateLimitBucket" WHERE "key" = ${k}`;
    assert.equal(row[0]?.ok, true);
  });

  it("keeps throttling on this instance, and logs, when the database is unreachable", async () => {
    const broken = { $queryRaw: async () => { throw new Error("database down"); }, $executeRaw: async () => 0 } as unknown as PrismaService;
    const config = loadConfig({ ...process.env, RATE_LIMIT_ENABLED: "true", RATE_LIMIT_STORE: "database" });
    const guard = new RateLimitGuard(new Reflector(), config, broken);
    const handler = () => undefined;
    const opts: RateLimitOptions = { limit: 2, windowMs: 60_000 };
    Reflect.defineMetadata(RATE_LIMIT, opts, handler);
    const ctx = {
      getHandler: () => handler, getClass: () => class Unused {},
      switchToHttp: () => ({ getRequest: () => ({ method: "POST", route: { path: "/auth/login" }, ip: `10.0.0.${Math.floor(Math.random() * 250)}`, headers: {} }) }),
    } as unknown as ExecutionContext;
    // The same request object shape gives the same key each call: two allowed, the third refused.
    const req = (ctx.switchToHttp().getRequest() as { ip: string });
    const fixed = { ...ctx, switchToHttp: () => ({ getRequest: () => ({ method: "POST", route: { path: "/auth/login" }, ip: req.ip, headers: {} }) }) } as unknown as ExecutionContext;
    assert.equal(await guard.canActivate(fixed), true);
    assert.equal(await guard.canActivate(fixed), true);
    await assert.rejects(() => Promise.resolve(guard.canActivate(fixed)), (e: { code?: string }) => e.code === "RATE_LIMITED");
  });

  it("the memory store setting needs no database table", async () => {
    const config = loadConfig({ ...process.env, RATE_LIMIT_ENABLED: "true", RATE_LIMIT_STORE: "memory" });
    assert.equal(config.RATE_LIMIT_STORE, "memory");
    assert.throws(() => loadConfig({ ...process.env, RATE_LIMIT_STORE: "redis" }), /RATE_LIMIT_STORE/);
  });
});
