// Draws the patient app's icons (a white cross on teal) as PNG files, with no image libraries: node scripts/make-patient-icons.mjs
// Output: apps/web/public/patient/icon-192.png, icon-512.png, icon-maskable-512.png (extra margin so phones can crop it), apple-touch-icon.png.
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "apps", "web", "public", "patient");
mkdirSync(out, { recursive: true });

const TEAL = [15, 118, 110], WHITE = [255, 255, 255];
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, sum]);
};

/** A square icon: teal background, white plus sign whose arms span `span` of the width. Corners are rounded unless the icon is full-bleed. */
function icon(size, span, rounded) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const arm = Math.round(size * span * 0.22), half = size / 2, reach = size * span / 2, radius = rounded ? size * 0.2 : 0;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const dx = Math.abs(x + 0.5 - half), dy = Math.abs(y + 0.5 - half);
      const cross = (dx <= arm / 2 && dy <= reach) || (dy <= arm / 2 && dx <= reach);
      let alpha = 255;
      if (radius > 0) { const cx = Math.max(0, Math.abs(x + 0.5 - half) - (half - radius)), cy = Math.max(0, Math.abs(y + 0.5 - half) - (half - radius)); if (Math.hypot(cx, cy) > radius) alpha = 0; }
      const [r, g, b] = cross ? WHITE : TEAL;
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = alpha;
    }
  }
  const head = Buffer.alloc(13); head.writeUInt32BE(size, 0); head.writeUInt32BE(size, 4); head[8] = 8; head[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", head), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

for (const [name, size, span, rounded] of [["icon-192.png", 192, 0.6, true], ["icon-512.png", 512, 0.6, true], ["icon-maskable-512.png", 512, 0.4, false], ["apple-touch-icon.png", 180, 0.6, false]]) {
  writeFileSync(join(out, name), icon(size, span, rounded));
  console.log("wrote", name);
}
