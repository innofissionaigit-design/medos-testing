import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import type { AddressInfo } from "node:net";
import { registerPatient, startApp, type TestApp, type TestTenant } from "../../test/harness";
import { parseReply } from "./scan.service";

const PDF_HEAD = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n");
const EICAR = Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*");
const pdf = (extra: Buffer = Buffer.alloc(0)) => Buffer.concat([PDF_HEAD, extra, Buffer.from("\n%%EOF\n")]);

/** A stand-in for clamd that speaks the INSTREAM protocol and records what it was sent. */
function fakeClamd(): Promise<{ server: Server; port: number; seen: { command: string; bytes: number; chunks: number }[] }> {
  const seen: { command: string; bytes: number; chunks: number }[] = [];
  const server = createServer((sock) => {
    let buf = Buffer.alloc(0);
    let started = false;
    let bytes = 0;
    let chunks = 0;
    let content = Buffer.alloc(0);
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (!started) {
        const nul = buf.indexOf(0);
        if (nul < 0) return;
        const command = buf.subarray(0, nul).toString();
        seen.push({ command, bytes: 0, chunks: 0 });
        buf = buf.subarray(nul + 1);
        started = true;
      }
      for (;;) {
        if (buf.length < 4) return;
        const len = buf.readUInt32BE(0);
        if (len === 0) {
          const last = seen[seen.length - 1]!;
          last.bytes = bytes; last.chunks = chunks;
          sock.end(content.includes(EICAR) ? "stream: Eicar-Test-Signature FOUND\0" : "stream: OK\0");
          return;
        }
        if (buf.length < 4 + len) return;
        content = Buffer.concat([content, buf.subarray(4, 4 + len)]);
        bytes += len; chunks += 1;
        buf = buf.subarray(4 + len);
      }
    });
    sock.on("error", () => undefined);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as AddressInfo).port, seen })));
}

describe("virus scan of uploaded files (ClamAV)", () => {
  let t: TestApp;
  let a: TestTenant;
  let rec: { id: string; token: string };
  let clamd: Awaited<ReturnType<typeof fakeClamd>>;

  const upload = (patientId: string, body: Buffer) =>
    t.api("post", `/patients/${patientId}/files`, rec.token).query({ kind: "DOCUMENT", filename: "scan.pdf", title: "Scanned report" }).set("Content-Type", "application/pdf").send(body);

  before(async () => {
    clamd = await fakeClamd();
    process.env["CLAMAV_HOST"] = "127.0.0.1";
    process.env["CLAMAV_PORT"] = String(clamd.port);
    process.env["CLAMAV_TIMEOUT_MS"] = "3000";
    t = await startApp();
    a = await t.makeTenant("scan-a");
    rec = await t.makeUser(a, ["RECEPTIONIST"]);
  });
  after(async () => { await t.close(); clamd.server.close(); });

  it("stores a clean file after sending it to the scanner in ClamAV's streaming format", async () => {
    const p = await registerPatient(t, rec.token);
    const body = pdf(Buffer.alloc(150 * 1024, 7)); // larger than one 64 KB chunk
    const r = await upload(p.id, body);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const call = clamd.seen[clamd.seen.length - 1]!;
    assert.equal(call.command, "zINSTREAM");
    assert.equal(call.bytes, body.length, "the scanner received exactly the bytes that are stored");
    assert.ok(call.chunks >= 3, "sent in several chunks");
  });

  it("rejects an infected file with nothing stored, and audits it without the file's name or content", async () => {
    const p = await registerPatient(t, rec.token);
    const r = await upload(p.id, pdf(EICAR));
    assert.equal(r.status, 422);
    assert.equal(r.body.error.code, "FILE_INFECTED");
    assert.equal(await t.prisma.patientFile.count({ where: { patientId: p.id } }), 0, "no record");
    const evt = await t.prisma.auditEvent.findFirstOrThrow({ where: { tenantId: a.tenantId, action: "PATIENT_FILE_REJECTED", entityId: p.id } });
    assert.equal(evt.actorUserId, rec.id);
    assert.deepEqual(evt.metadata, { reason: "VIRUS_FOUND", signature: "Eicar-Test-Signature", sizeBytes: pdf(EICAR).length });
    assert.equal(JSON.stringify(evt.metadata).includes("scan.pdf"), false);
  });

  it("refuses uploads while the scanner is unreachable instead of storing unchecked files", async () => {
    const p = await registerPatient(t, rec.token);
    await new Promise<void>((r) => clamd.server.close(() => r()));
    const r = await upload(p.id, pdf());
    assert.equal(r.status, 503);
    assert.equal(r.body.error.code, "SCAN_UNAVAILABLE");
    assert.equal(await t.prisma.patientFile.count({ where: { patientId: p.id } }), 0);
  });

  it("understands clamd's replies; anything unexpected counts as unavailable", () => {
    assert.deepEqual(parseReply("stream: OK\0"), { status: "CLEAN" });
    assert.deepEqual(parseReply("stream: Win.Test.EICAR_HDB-1 FOUND\0"), { status: "INFECTED", signature: "Win.Test.EICAR_HDB-1" });
    assert.deepEqual(parseReply("INSTREAM size limit exceeded. ERROR\0"), { status: "UNAVAILABLE" });
    assert.deepEqual(parseReply(""), { status: "UNAVAILABLE" });
  });
});
