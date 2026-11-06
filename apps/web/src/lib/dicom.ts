/**
 * A small DICOM reader for the radiology viewer (docs/radiology.md). It shows a single grayscale slice stored uncompressed (the common case for X-ray, CT and MRI
 * exports): "Implicit VR Little Endian" or "Explicit VR Little Endian", 8 or 16 bits, with the rescale and the window the file carries. Anything else (compressed
 * pixel data, colour, big-endian) is reported as not viewable here, and the file can still be downloaded and opened in a full DICOM viewer. This is a viewer, not a
 * diagnostic workstation: it does no measurements, reformatting or comparison.
 */

export interface DicomImage {
  rows: number; cols: number; bitsAllocated: 8 | 16; signed: boolean; photometric: "MONOCHROME1" | "MONOCHROME2";
  /** value = stored * slope + intercept */
  slope: number; intercept: number;
  /** The window written in the file, if any. */
  windowCenter: number | null; windowWidth: number | null;
  /** Range of the real values after rescale, for default windowing and the sliders. */
  min: number; max: number;
  frames: number;
  /** Stored values of the first frame. */
  pixels: Uint8Array | Int16Array | Uint16Array;
}
export type DicomResult = { ok: true; image: DicomImage } | { ok: false; reason: string };

const EXPLICIT_LE = "1.2.840.10008.1.2.1";
const IMPLICIT_LE = "1.2.840.10008.1.2";
const LONG_VR = new Set(["OB", "OW", "OF", "OD", "OL", "OV", "SQ", "UC", "UR", "UT", "UN"]);
const UNDEFINED = 0xffffffff;
const MAX_SIDE = 8192;

const text = (v: DataView, at: number, len: number): string => {
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(v.getUint8(at + i));
  return s.replace(/[\0 ]+$/g, "").replace(/^ +/, "");
};
const num = (s: string): number | null => { const first = s.split("\\")[0]!.trim(); if (first === "") return null; const n = Number(first); return Number.isFinite(n) ? n : null; };

/** Reads a DICOM file. Never throws on bad input: it says why it cannot show it. */
export function parseDicom(buffer: ArrayBuffer): DicomResult {
  try {
    return read(buffer);
  } catch {
    return { ok: false, reason: "This DICOM file could not be read." };
  }
}

function read(buffer: ArrayBuffer): DicomResult {
  const v = new DataView(buffer);
  if (buffer.byteLength < 140 || text(v, 128, 4) !== "DICM") return { ok: false, reason: "This is not a DICOM file." };

  // File meta group (0002) is always explicit little endian; it names the transfer syntax of the rest.
  let at = 132;
  let syntax = IMPLICIT_LE;
  while (at + 8 <= buffer.byteLength && v.getUint16(at, true) === 0x0002) {
    const elem = v.getUint16(at + 2, true);
    const vr = text(v, at + 4, 2);
    let len: number, head: number;
    if (LONG_VR.has(vr)) { len = v.getUint32(at + 8, true); head = 12; } else { len = v.getUint16(at + 6, true); head = 8; }
    if (elem === 0x0010) syntax = text(v, at + head, len);
    at += head + len;
  }
  if (syntax !== EXPLICIT_LE && syntax !== IMPLICIT_LE) {
    return { ok: false, reason: "This image is compressed or stored in a format the built-in viewer cannot show. Download it and open it in a DICOM viewer." };
  }
  const explicit = syntax === EXPLICIT_LE;

  const tags: Record<string, string | number> = {};
  let pixelAt = -1, pixelLen = 0;
  const wanted = new Set(["0028,0002", "0028,0004", "0028,0008", "0028,0010", "0028,0011", "0028,0100", "0028,0103", "0028,1050", "0028,1051", "0028,1052", "0028,1053"]);

  // Walks elements; returns the offset after an element of undefined length (a sequence), skipping what is inside.
  const skipUndefined = (from: number): number => {
    let p = from;
    while (p + 8 <= buffer.byteLength) {
      const g = v.getUint16(p, true), e = v.getUint16(p + 2, true);
      const len = v.getUint32(p + 4, true);
      if (g === 0xfffe && e === 0xe0dd) return p + 8; // sequence delimiter
      if (g === 0xfffe && e === 0xe000) { // an item
        if (len === UNDEFINED) p = skipItem(p + 8); else p += 8 + len;
        continue;
      }
      throw new Error("bad sequence");
    }
    throw new Error("truncated");
  };
  const skipItem = (from: number): number => {
    let p = from;
    while (p + 8 <= buffer.byteLength) {
      const g = v.getUint16(p, true), e = v.getUint16(p + 2, true);
      if (g === 0xfffe && e === 0xe00d) return p + 8; // item delimiter
      p = element(p, false).next;
    }
    throw new Error("truncated");
  };
  const element = (p: number, collect: boolean): { next: number } => {
    const g = v.getUint16(p, true), e = v.getUint16(p + 2, true);
    let vr = "", len: number, head: number;
    if (explicit) {
      vr = text(v, p + 4, 2);
      if (LONG_VR.has(vr)) { len = v.getUint32(p + 8, true); head = 12; } else { len = v.getUint16(p + 6, true); head = 8; }
    } else { len = v.getUint32(p + 4, true); head = 8; }
    const key = `${g.toString(16).padStart(4, "0")},${e.toString(16).padStart(4, "0")}`;
    if (len === UNDEFINED) {
      if (g === 0x7fe0 && e === 0x0010) throw new Error("encapsulated");
      return { next: skipUndefined(p + head) };
    }
    if (collect && wanted.has(key)) {
      if (key === "0028,0002" || key === "0028,0010" || key === "0028,0011" || key === "0028,0100" || key === "0028,0103") tags[key] = v.getUint16(p + head, true);
      else tags[key] = text(v, p + head, len);
    }
    if (collect && g === 0x7fe0 && e === 0x0010) { pixelAt = p + head; pixelLen = len; }
    return { next: p + head + len };
  };

  while (at + 8 <= buffer.byteLength && pixelAt < 0) at = element(at, true).next;
  if (pixelAt < 0) return { ok: false, reason: "This DICOM file has no image in it." };

  const samples = (tags["0028,0002"] as number | undefined) ?? 1;
  const photometric = String(tags["0028,0004"] ?? "MONOCHROME2");
  if (samples !== 1 || (photometric !== "MONOCHROME1" && photometric !== "MONOCHROME2")) return { ok: false, reason: "Colour images cannot be shown in the built-in viewer. Download it and open it in a DICOM viewer." };
  const bits = tags["0028,0100"] as number | undefined;
  if (bits !== 8 && bits !== 16) return { ok: false, reason: "This image uses a bit depth the built-in viewer cannot show." };
  const rows = tags["0028,0010"] as number | undefined, cols = tags["0028,0011"] as number | undefined;
  if (!rows || !cols || rows > MAX_SIDE || cols > MAX_SIDE) return { ok: false, reason: "This image is empty or too large for the built-in viewer." };
  const bytes = bits / 8, frameBytes = rows * cols * bytes;
  if (pixelLen < frameBytes || pixelAt + frameBytes > buffer.byteLength) return { ok: false, reason: "This DICOM file is cut short." };
  const signed = (tags["0028,0103"] as number | undefined) === 1;
  const copy = buffer.slice(pixelAt, pixelAt + frameBytes);
  const pixels = bits === 8 ? new Uint8Array(copy) : signed ? new Int16Array(copy) : new Uint16Array(copy);
  const slope = num(String(tags["0028,1053"] ?? "")) ?? 1;
  const intercept = num(String(tags["0028,1052"] ?? "")) ?? 0;
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < pixels.length; i++) { const x = pixels[i]! * slope + intercept; if (x < min) min = x; if (x > max) max = x; }
  return {
    ok: true,
    image: {
      rows, cols, bitsAllocated: bits, signed, photometric, slope, intercept, windowCenter: num(String(tags["0028,1050"] ?? "")), windowWidth: num(String(tags["0028,1051"] ?? "")),
      min, max, frames: Math.max(1, num(String(tags["0028,0008"] ?? "1")) ?? 1), pixels,
    },
  };
}

/** The window to start with: the one in the file if it has one, otherwise the whole range of the picture. */
export function defaultWindow(img: DicomImage): { center: number; width: number } {
  if (img.windowCenter !== null && img.windowWidth !== null && img.windowWidth > 0) return { center: img.windowCenter, width: img.windowWidth };
  return { center: (img.min + img.max) / 2, width: Math.max(1, img.max - img.min) };
}

/** Grayscale RGBA for the canvas: values inside the window spread over black to white; MONOCHROME1 (and the invert switch) flips it. */
export function toRgba(img: DicomImage, center: number, width: number, invert: boolean): Uint8ClampedArray {
  const out = new Uint8ClampedArray(img.rows * img.cols * 4);
  const low = center - width / 2, w = Math.max(1, width);
  const flip = (img.photometric === "MONOCHROME1") !== invert;
  for (let i = 0; i < img.pixels.length; i++) {
    const value = img.pixels[i]! * img.slope + img.intercept;
    let g = Math.round(((value - low) / w) * 255);
    g = g < 0 ? 0 : g > 255 ? 255 : g;
    if (flip) g = 255 - g;
    const o = i * 4;
    out[o] = g; out[o + 1] = g; out[o + 2] = g; out[o + 3] = 255;
  }
  return out;
}
