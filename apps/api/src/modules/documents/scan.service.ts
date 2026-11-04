import { Inject, Injectable } from "@nestjs/common";
import { createConnection } from "node:net";
import { CONFIG, type AppConfig } from "../../common/config";

export type ScanResult = { status: "SKIPPED" } | { status: "CLEAN" } | { status: "INFECTED"; signature: string } | { status: "UNAVAILABLE" };

const CHUNK = 64 * 1024;

/**
 * Virus scan of uploads through a ClamAV daemon (clamd), using its INSTREAM command over TCP (no client library needed).
 * With CLAMAV_HOST unset nothing is scanned (local development). With it set, scanning is mandatory: if the daemon cannot be
 * reached the upload is refused rather than stored unchecked.
 */
@Injectable()
export class ScanService {
  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  get enabled(): boolean {
    return !!this.config.CLAMAV_HOST;
  }

  scan(data: Buffer): Promise<ScanResult> {
    const host = this.config.CLAMAV_HOST;
    if (!host) return Promise.resolve({ status: "SKIPPED" });
    return new Promise<ScanResult>((resolve) => {
      let reply = "";
      let settled = false;
      const done = (r: ScanResult): void => { if (!settled) { settled = true; socket.destroy(); resolve(r); } };
      const socket = createConnection({ host, port: this.config.CLAMAV_PORT });
      socket.setTimeout(this.config.CLAMAV_TIMEOUT_MS, () => done({ status: "UNAVAILABLE" }));
      socket.on("error", () => done({ status: "UNAVAILABLE" }));
      socket.on("close", () => done(parseReply(reply)));
      socket.on("data", (d) => { reply += d.toString("utf8"); if (reply.includes("\0")) done(parseReply(reply)); });
      socket.on("connect", () => {
        socket.write("zINSTREAM\0");
        for (let i = 0; i < data.length; i += CHUNK) {
          const part = data.subarray(i, i + CHUNK);
          const len = Buffer.alloc(4);
          len.writeUInt32BE(part.length);
          socket.write(len);
          socket.write(part);
        }
        socket.write(Buffer.alloc(4)); // zero-length chunk ends the stream
      });
    });
  }
}

/** "stream: OK", "stream: <signature> FOUND" or "... ERROR"; anything else (including no reply) counts as unavailable. */
export function parseReply(raw: string): ScanResult {
  const line = raw.replace(/\0/g, "").trim();
  if (/^stream:\s*OK$/i.test(line)) return { status: "CLEAN" };
  const found = /^stream:\s*(.+)\s+FOUND$/i.exec(line);
  if (found) return { status: "INFECTED", signature: found[1]!.trim() };
  return { status: "UNAVAILABLE" };
}
