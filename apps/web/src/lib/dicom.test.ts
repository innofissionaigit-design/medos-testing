import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defaultWindow, parseDicom, toRgba } from "./dicom";

const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const even = (b: Buffer) => (b.length % 2 === 0 ? b : Buffer.concat([b, Buffer.from([0])]));
const tag = (g: number, e: number) => Buffer.concat([u16(g), u16(e)]);

/** One data element: explicit VR writes the type, implicit does not. */
function el(explicit: boolean, g: number, e: number, vr: string, value: Buffer): Buffer {
  const v = even(value);
  if (!explicit) return Buffer.concat([tag(g, e), u32(v.length), v]);
  if (["OB", "OW", "SQ", "UN", "UT"].includes(vr)) return Buffer.concat([tag(g, e), Buffer.from(vr), u16(0), u32(v.length), v]);
  return Buffer.concat([tag(g, e), Buffer.from(vr), u16(v.length), v]);
}
const us = (explicit: boolean, g: number, e: number, n: number) => el(explicit, g, e, "US", u16(n));
const str = (explicit: boolean, g: number, e: number, vr: string, s: string) => el(explicit, g, e, vr, Buffer.from(s, "latin1"));

interface Opts { syntax?: string; rows?: number; cols?: number; bits?: 8 | 16; signed?: boolean; photometric?: string; slope?: string; intercept?: string; wc?: string; ww?: string; samples?: number; pixels?: Buffer; extra?: Buffer; truncate?: boolean }

function dicom(o: Opts = {}): ArrayBuffer {
  const syntax = o.syntax ?? "1.2.840.10008.1.2.1";
  const explicit = syntax !== "1.2.840.10008.1.2";
  const rows = o.rows ?? 2, cols = o.cols ?? 4, bits = o.bits ?? 16;
  const meta = el(true, 0x0002, 0x0010, "UI", Buffer.from(syntax, "latin1"));
  const px = o.pixels ?? Buffer.alloc(rows * cols * (bits / 8));
  const body = Buffer.concat([
    us(explicit, 0x0028, 0x0002, o.samples ?? 1), str(explicit, 0x0028, 0x0004, "CS", o.photometric ?? "MONOCHROME2"),
    us(explicit, 0x0028, 0x0010, rows), us(explicit, 0x0028, 0x0011, cols), us(explicit, 0x0028, 0x0100, bits), us(explicit, 0x0028, 0x0103, o.signed ? 1 : 0),
    ...(o.wc ? [str(explicit, 0x0028, 0x1050, "DS", o.wc)] : []), ...(o.ww ? [str(explicit, 0x0028, 0x1051, "DS", o.ww)] : []),
    ...(o.intercept ? [str(explicit, 0x0028, 0x1052, "DS", o.intercept)] : []), ...(o.slope ? [str(explicit, 0x0028, 0x1053, "DS", o.slope)] : []),
    ...(o.extra ? [o.extra] : []),
    el(explicit, 0x7fe0, 0x0010, "OW", o.truncate ? px.subarray(0, px.length - 4) : px),
  ]);
  const all = Buffer.concat([Buffer.alloc(128), Buffer.from("DICM"), meta, body]);
  return all.buffer.slice(all.byteOffset, all.byteOffset + all.length);
}
const words = (...n: number[]) => Buffer.concat(n.map((x) => u16(x & 0xffff)));

describe("DICOM reader for the radiology viewer", () => {
  it("reads an uncompressed 16-bit slice (explicit and implicit VR): size, rescale, window and the range of real values", () => {
    for (const syntax of ["1.2.840.10008.1.2.1", "1.2.840.10008.1.2"]) {
      const r = parseDicom(dicom({ syntax, intercept: "-1024", slope: "1", wc: "40", ww: "400", pixels: words(0, 1024, 1064, 1224, 1500, 2000, 3000, 3071) }));
      assert.ok(r.ok, JSON.stringify(r));
      const i = r.image;
      assert.deepEqual([i.rows, i.cols, i.bitsAllocated, i.signed, i.photometric, i.frames], [2, 4, 16, false, "MONOCHROME2", 1], syntax);
      assert.deepEqual([i.slope, i.intercept, i.windowCenter, i.windowWidth, i.min, i.max], [1, -1024, 40, 400, -1024, 2047]);
      assert.deepEqual(defaultWindow(i), { center: 40, width: 400 });
      const rgba = toRgba(i, 40, 400, false);
      // real values -1024, 0, 40, 200; the window 40 +/- 200 spans -160..240: black, a little over a third, mid grey, nearly white
      assert.deepEqual([rgba[0], rgba[4], rgba[8], rgba[12]], [0, 102, 128, 230]);
      assert.equal(rgba[3], 255);
    }
  });

  it("without a window in the file it uses the whole range; the invert switch and MONOCHROME1 flip black and white", () => {
    const base = dicom({ pixels: words(0, 100, 200, 300, 400, 500, 600, 1000) });
    const r = parseDicom(base);
    assert.ok(r.ok);
    assert.deepEqual(defaultWindow(r.image), { center: 500, width: 1000 });
    const a = toRgba(r.image, 500, 1000, false), b = toRgba(r.image, 500, 1000, true);
    assert.deepEqual([a[0], a[28], b[0], b[28]], [0, 255, 255, 0]);
    const m1 = parseDicom(dicom({ photometric: "MONOCHROME1", pixels: words(0, 100, 200, 300, 400, 500, 600, 1000) }));
    assert.ok(m1.ok);
    assert.deepEqual([toRgba(m1.image, 500, 1000, false)[0], toRgba(m1.image, 500, 1000, true)[0]], [255, 0]);
  });

  it("reads 8-bit and signed 16-bit slices", () => {
    const eight = parseDicom(dicom({ bits: 8, pixels: Buffer.from([0, 64, 128, 255, 10, 20, 30, 40]), ww: "255", wc: "128" }));
    assert.ok(eight.ok);
    assert.deepEqual([eight.image.bitsAllocated, eight.image.min, eight.image.max], [8, 0, 255]);
    const signed = parseDicom(dicom({ signed: true, pixels: words(-1000, -500, 0, 500, 1000, 1500, 2000, 2500) }));
    assert.ok(signed.ok);
    assert.deepEqual([signed.image.signed, signed.image.min, signed.image.max], [true, -1000, 2500]);
  });

  it("skips sequences before the pixels, whether their length is given or open-ended", () => {
    const item = (len: number | null, inner: Buffer) => len === null
      ? Buffer.concat([tag(0xfffe, 0xe000), u32(0xffffffff), inner, tag(0xfffe, 0xe00d), u32(0)])
      : Buffer.concat([tag(0xfffe, 0xe000), u32(inner.length), inner]);
    const inner = str(true, 0x0008, 0x0100, "SH", "CODE");
    const defined = Buffer.concat([tag(0x0008, 0x1140), Buffer.from("SQ"), u16(0), u32(8 + inner.length), item(inner.length, inner)]);
    const open = Buffer.concat([tag(0x0008, 0x1111), Buffer.from("SQ"), u16(0), u32(0xffffffff), item(null, inner), tag(0xfffe, 0xe0dd), u32(0)]);
    for (const extra of [defined, open, Buffer.concat([open, defined])]) {
      const r = parseDicom(dicom({ extra, pixels: words(1, 2, 3, 4, 5, 6, 7, 8) }));
      assert.ok(r.ok, JSON.stringify(r));
      assert.deepEqual([...r.image.pixels], [1, 2, 3, 4, 5, 6, 7, 8]);
    }
  });

  it("says plainly why it cannot show a file, and never throws", () => {
    const reason = (r: ReturnType<typeof parseDicom>) => (r.ok ? "" : r.reason);
    assert.match(reason(parseDicom(dicom({ syntax: "1.2.840.10008.1.2.4.50" }))), /compressed/i);
    assert.match(reason(parseDicom(dicom({ syntax: "1.2.840.10008.1.2.2" }))), /compressed|format/i);
    assert.match(reason(parseDicom(dicom({ samples: 3, photometric: "RGB" }))), /colour/i);
    assert.match(reason(parseDicom(dicom({ truncate: true, pixels: words(1, 2, 3, 4, 5, 6, 7, 8) }))), /cut short/i);
    assert.match(reason(parseDicom(new ArrayBuffer(10))), /not a DICOM/i);
    assert.match(reason(parseDicom(Buffer.from("PNG not dicom".repeat(30)).buffer.slice(0))), /not a DICOM/i);
    const garbage = Buffer.concat([Buffer.alloc(128), Buffer.from("DICM"), Buffer.alloc(40, 0xff)]);
    assert.equal(parseDicom(garbage.buffer.slice(garbage.byteOffset, garbage.byteOffset + garbage.length)).ok, false);
    assert.match(reason(parseDicom(dicom({ rows: 9000, cols: 2 }))), /too large|empty/i);
  });
});
