import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

type Handler = (event: Record<string, unknown>) => void;

/** Runs the real service worker file against small stand-ins for the browser's cache and network, so what it does can be checked without a browser. */
function load(online: boolean) {
  const handlers = new Map<string, Handler>();
  const stored = new Map<string, Response>();
  const networkCalls: string[] = [];
  const caches = {
    open: async () => ({ addAll: async (urls: string[]) => { for (const u of urls) stored.set(u, new Response(`cached ${u}`, { status: 200 })); } }),
    match: async (url: string) => stored.get(url),
    keys: async () => ["medos-patient-offline-v0", "something-else"],
    delete: async (name: string) => { deleted.push(name); return true; },
  };
  const deleted: string[] = [];
  const self = { addEventListener: (name: string, fn: Handler) => handlers.set(name, fn), skipWaiting: async () => undefined, clients: { claim: async () => undefined } };
  const fetchStub = async (req: { url: string }) => { networkCalls.push(req.url); if (!online) throw new Error("offline"); return new Response("from network"); };
  const code = readFileSync(join(process.cwd(), "public", "patient", "sw.js"), "utf8");
  vm.runInNewContext(code, { self, caches, fetch: fetchStub, Response });
  return { handlers, stored, networkCalls, deleted };
}
const waitable = () => { const w: { p: Promise<unknown> | null } = { p: null }; return { w, event: (extra: Record<string, unknown> = {}) => ({ waitUntil: (p: Promise<unknown>) => { w.p = p; }, respondWith: (p: Promise<unknown>) => { w.p = p; }, ...extra }) }; };

describe("the patient app's service worker", () => {
  it("on install it keeps only the offline page and the icon", async () => {
    const sw = load(true);
    const { w, event } = waitable();
    sw.handlers.get("install")!(event());
    await w.p;
    assert.deepEqual([...sw.stored.keys()].sort(), ["/patient/icon-192.png", "/patient/offline.html"]);
  });

  it("on activation it removes its own old caches and nothing else", async () => {
    const sw = load(true);
    const { w, event } = waitable();
    sw.handlers.get("activate")!(event());
    await w.p;
    assert.deepEqual(sw.deleted, ["medos-patient-offline-v0"]);
  });

  it("offline, opening the app shows the offline page", async () => {
    const sw = load(false);
    await (async () => { const { w, event } = waitable(); sw.handlers.get("install")!(event()); await w.p; })();
    const { w, event } = waitable();
    sw.handlers.get("fetch")!(event({ request: { mode: "navigate", method: "GET", url: "https://h.example/patient" } }));
    const res = (await w.p) as Response;
    assert.equal(await res.text(), "cached /patient/offline.html");
  });

  it("online, a page is simply fetched and nothing is stored", async () => {
    const sw = load(true);
    const { w, event } = waitable();
    sw.handlers.get("fetch")!(event({ request: { mode: "navigate", method: "GET", url: "https://h.example/patient" } }));
    assert.equal(await ((await w.p) as Response).text(), "from network");
    assert.equal(sw.stored.size, 0, "no copy of the page is kept");
  });

  it("it never touches anything but a page being opened: API calls, data and other methods go straight to the network", () => {
    const sw = load(true);
    for (const request of [
      { mode: "cors", method: "GET", url: "https://h.example/api/patient/data/visits?patientId=1" },
      { mode: "same-origin", method: "GET", url: "https://h.example/api/patient/data/bills" },
      { mode: "navigate", method: "POST", url: "https://h.example/patient" },
      { mode: "no-cors", method: "GET", url: "https://h.example/patient/icon-192.png" },
    ]) {
      let responded = false;
      sw.handlers.get("fetch")!({ request, respondWith: () => { responded = true; } });
      assert.equal(responded, false, `${request.method} ${request.url}`);
    }
    assert.equal(sw.networkCalls.length, 0);
  });
});
