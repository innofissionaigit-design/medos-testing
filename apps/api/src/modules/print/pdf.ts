import PDFDocument from "pdfkit";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { logJson } from "../../common/logger";
import type { Doc } from "./doc";

/**
 * PDF renderer (pdfkit, MIT) with embedded Noto Sans fonts (SIL Open Font License; apps/api/assets/fonts) so English, Bengali and
 * Hindi all print. No single font covers all three, so every string is cut into runs by script and each run is drawn in its own font.
 * If the font files cannot be read, printing falls back to the built-in Helvetica (Latin only, other characters become "?") and logs
 * a warning, rather than failing to print.
 */
export type Script = "latin" | "bengali" | "devanagari";
type Weight = "regular" | "bold";
const SCRIPTS: Script[] = ["latin", "bengali", "devanagari"];
const WEIGHTS: Weight[] = ["regular", "bold"];

export const FONT_DIR = join(__dirname, "..", "..", "..", "assets", "fonts");
const FONT_FILES: Record<Script, Record<Weight, string>> = {
  latin: { regular: "NotoSans-Regular.ttf", bold: "NotoSans-Bold.ttf" },
  bengali: { regular: "NotoSansBengali-Regular.ttf", bold: "NotoSansBengali-Bold.ttf" },
  devanagari: { regular: "NotoSansDevanagari-Regular.ttf", bold: "NotoSansDevanagari-Bold.ttf" },
};

interface FontSet { embedded: boolean; buffers: Record<string, Buffer> }
const fontCache = new Map<string, FontSet>();

function loadFonts(dir: string): FontSet {
  const hit = fontCache.get(dir);
  if (hit) return hit;
  let set: FontSet;
  try {
    const buffers: Record<string, Buffer> = {};
    for (const s of SCRIPTS) for (const w of WEIGHTS) buffers[`${s}-${w}`] = readFileSync(join(dir, FONT_FILES[s][w]));
    set = { embedded: true, buffers };
  } catch (e) {
    logJson("warn", "pdf_fonts_unavailable", { errorName: e instanceof Error ? e.name : typeof e });
    set = { embedded: false, buffers: {} };
  }
  fontCache.set(dir, set);
  return set;
}

// ───────────────────────── text ─────────────────────────

const isBengali = (cp: number) => cp >= 0x0980 && cp <= 0x09ff;
const isDevanagari = (cp: number) => cp >= 0x0900 && cp <= 0x097f;
const isJoiner = (cp: number) => cp === 0x200c || cp === 0x200d; // zero-width (non-)joiner: part of the letters around it
const isDanda = (cp: number) => cp === 0x0964 || cp === 0x0965; // the Hindi/Bengali full stop; both Indic fonts have it

export interface Run { script: Script; text: string }

/** Cuts text into runs, each drawn in one font. Bengali and Devanagari letters pick their font; everything else (Latin, digits,
 *  punctuation, ₹) uses Noto Sans, because the Indic fonts lack those. Spaces, joiners and dandas stay with the text around them. */
export function scriptRuns(text: string): Run[] {
  const runs: Run[] = [];
  let cur: Run | null = null;
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    let script: Script;
    if (isBengali(cp) && !isDanda(cp)) script = "bengali";
    else if (isDanda(cp)) script = cur && cur.script !== "latin" ? cur.script : "devanagari";
    else if (isDevanagari(cp)) script = "devanagari";
    else if ((cp === 0x20 || isJoiner(cp)) && cur) script = cur.script;
    else script = "latin";
    if (cur && cur.script === script) cur.text += ch;
    else { cur = { script, text: ch }; runs.push(cur); }
  }
  return runs;
}

const LEGACY_REPLACEMENTS: Record<string, string> = { "₹": "Rs.", "–": "-", "—": "-", "‘": "'", "’": "'", "“": '"', "”": '"', "•": "-", "…": "...", "·": "-", " ": " " };

/** Code points the embedded fonts can draw: Latin, Greek, Cyrillic, general punctuation, currency (₹ …), Devanagari, Bengali. */
const supported = (cp: number): boolean =>
  cp === 0x09 || cp === 0x0a || (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0x052f) || (cp >= 0x0900 && cp <= 0x09ff)
  || isJoiner(cp) || (cp >= 0x2010 && cp <= 0x205e) || (cp >= 0x20a0 && cp <= 0x20bf);

/** Makes text safe to draw: control characters go, and characters no font has become "?" (never silently dropped). */
export const makeSafe = (embedded: boolean) => (s: unknown): string => {
  const text = String(s ?? "");
  if (!embedded) return text.replace(/[^\x09\x0a\x20-\x7e\xa0-\xff]/g, (c) => LEGACY_REPLACEMENTS[c] ?? "?").replace(/[ ·]/g, (c) => LEGACY_REPLACEMENTS[c] ?? c);
  return Array.from(text.normalize("NFC"), (ch) => (supported(ch.codePointAt(0) as number) ? ch : "?")).join("");
};

interface Seg { text: string; bold?: boolean }
interface Piece extends Run { bold: boolean }

const M = 40;
const W = 595.28 - 2 * M;
const BOTTOM = 841.89 - M - 24;
const GRAY = "#555555";

function logoBuffer(dataUrl: string | undefined): Buffer | null {
  const m = /^data:image\/(?:png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl ?? "");
  return m ? Buffer.from(m[1]!, "base64") : null;
}

export function toPdf(d: Doc, fontDir: string = FONT_DIR): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const fonts = loadFonts(fontDir);
    const safe = makeSafe(fonts.embedded);
    const pdf = new PDFDocument({ size: "A4", margin: M, bufferPages: true, info: { Title: safe(d.title), Producer: "MedOS", Creator: "MedOS" } });
    const chunks: Buffer[] = [];
    pdf.on("data", (c: Buffer) => chunks.push(c));
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);

    if (fonts.embedded) for (const s of SCRIPTS) for (const w of WEIGHTS) pdf.registerFont(`${s}-${w}`, fonts.buffers[`${s}-${w}`] as Buffer);
    const face = (script: Script, bold: boolean): string => (fonts.embedded ? `${script}-${bold ? "bold" : "regular"}` : bold ? "Helvetica-Bold" : "Helvetica");
    const pieces = (segs: Seg[]): Piece[] => segs.flatMap((s) => scriptRuns(safe(s.text)).map((r) => ({ ...r, bold: !!s.bold })));

    /** Draws text flowing across fonts; wraps inside `width`. Aligned multi-font text is placed by hand (pdfkit aligns each
     *  continued fragment on its own). */
    const put = (segs: Seg[] | string, x: number, y: number, o: { width: number; align?: "left" | "right" | "center"; bold?: boolean }): void => {
      const parts = pieces(typeof segs === "string" ? [{ text: segs, bold: o.bold }] : segs);
      const align = o.align ?? "left";
      if (parts.length <= 1) {
        const p = parts[0];
        pdf.font(face(p?.script ?? "latin", p?.bold ?? !!o.bold)).text(p?.text ?? "", x, y, { width: o.width, align });
        return;
      }
      let offset = 0;
      if (align !== "left") {
        const total = parts.reduce((sum, p) => sum + pdf.font(face(p.script, p.bold)).widthOfString(p.text), 0);
        if (total <= o.width) offset = align === "right" ? o.width - total : (o.width - total) / 2;
      }
      parts.forEach((p, i) => {
        const f = pdf.font(face(p.script, p.bold));
        if (i === 0) f.text(p.text, x + offset, y, { width: o.width - offset, continued: true });
        else f.text(p.text, { width: o.width - offset, continued: i < parts.length - 1 });
      });
    };

    /** Height `put` will occupy. One font: pdfkit's own measure. Several: the wrapping is simulated word by word. */
    const heightOf = (segs: Seg[] | string, width: number, bold = false): number => {
      const parts = pieces(typeof segs === "string" ? [{ text: segs, bold }] : segs);
      if (parts.length <= 1) return pdf.font(face(parts[0]?.script ?? "latin", parts[0]?.bold ?? bold)).heightOfString(parts[0]?.text ?? "", { width });
      const lineH = pdf.font(face("latin", false)).currentLineHeight(true);
      const spaceW = pdf.font(face("latin", false)).widthOfString(" ");
      const wordWidth = (word: Piece[]) => word.reduce((sum, p) => sum + pdf.font(face(p.script, p.bold)).widthOfString(p.text), 0);
      // words = pieces split at spaces, keeping each piece's font
      const lines: Piece[][][] = [[[]]];
      for (const p of parts) {
        p.text.split(/(\n| )/).forEach((tok) => {
          if (tok === "\n") lines.push([[]]);
          else if (tok === " ") lines[lines.length - 1]!.push([]);
          else if (tok !== "") lines[lines.length - 1]![lines[lines.length - 1]!.length - 1]!.push({ ...p, text: tok });
        });
      }
      let total = 0;
      for (const words of lines) {
        let line = 0;
        let count = 1;
        for (const w of words) {
          const ww = wordWidth(w);
          if (ww === 0) { line += spaceW; continue; }
          if (line > 0 && line + ww > width) { count++; line = 0; }
          if (ww > width) { count += Math.floor(ww / width); line = ww % width; } else line += ww + spaceW;
        }
        total += count;
      }
      return total * lineH;
    };

    const ensure = (h: number) => { if (pdf.y + h > BOTTOM) pdf.addPage(); };

    // header
    const top = pdf.y;
    let textX = M;
    const logo = logoBuffer(d.header.logoDataUrl);
    if (logo) { try { pdf.image(logo, M, top, { fit: [90, 48] }); textX = M + 100; } catch { /* unreadable logo: print without it */ } }
    pdf.fontSize(16).fillColor("#000");
    put(d.header.hospitalName, textX, top, { width: W - (textX - M), bold: true });
    pdf.fontSize(9).fillColor(GRAY);
    if (d.header.tagline) put(d.header.tagline, textX, pdf.y, { width: W - (textX - M) });
    const contact = [d.header.address, d.header.phone && `Ph: ${d.header.phone}`, d.header.email, d.header.gstin && `GSTIN: ${d.header.gstin}`].filter(Boolean).join("  |  ");
    if (contact) put(contact, textX, pdf.y, { width: W - (textX - M) });
    pdf.y = Math.max(pdf.y, top + (logo ? 52 : 0)) + 6;
    pdf.moveTo(M, pdf.y).lineTo(M + W, pdf.y).lineWidth(1.5).strokeColor("#000").stroke();
    pdf.y += 10;

    if (d.banner) {
      ensure(30);
      pdf.fontSize(11).fillColor("#b00000");
      const bh = heightOf(d.banner, W - 12, true) + 8;
      pdf.rect(M, pdf.y, W, bh).lineWidth(1.2).strokeColor("#b00000").stroke();
      put(d.banner, M + 6, pdf.y + 4, { width: W - 12, align: "center", bold: true });
      pdf.y += bh + 8;
    }

    for (const b of d.blocks) {
      pdf.x = M;
      switch (b.t) {
        case "title":
          ensure(28); pdf.fontSize(14).fillColor("#000"); put(b.text, M, pdf.y, { width: W, bold: true }); pdf.y += 6; break;
        case "heading":
          ensure(26); pdf.y += 6; pdf.fontSize(9.5).fillColor("#000"); put(b.text.toUpperCase(), M, pdf.y, { width: W, bold: true }); pdf.y += 3; break;
        case "para": {
          pdf.fontSize(10).fillColor("#000");
          const h = heightOf(b.text, W);
          ensure(h > BOTTOM - pdf.y ? 40 : h);
          put(b.text, M, pdf.y, { width: W }); pdf.y += 4; break;
        }
        case "note":
          ensure(20); pdf.fontSize(10).fillColor("#000"); put(b.text, M, pdf.y, { width: W, bold: true }); pdf.y += 4; break;
        case "signature":
          ensure(24 + b.lines.length * 12); pdf.y += 20; pdf.fontSize(10).fillColor("#000");
          for (const l of b.lines) put(l, M, pdf.y, { width: W, align: "right" });
          break;
        case "kv": {
          const rows = b.rows.filter(([, v]) => v !== null && v !== undefined && v !== "");
          const colW = W / 2 - 6;
          for (let i = 0; i < rows.length; i += 2) {
            const pair = rows.slice(i, i + 2);
            pdf.fontSize(9.5);
            const cell = ([k, v]: (typeof pair)[number]): Seg[] => [{ text: `${k}: `, bold: true }, { text: String(v) }];
            const h = Math.max(...pair.map((p) => heightOf(cell(p), colW))) + 3;
            ensure(h);
            const y = pdf.y;
            pair.forEach((p, j) => {
              pdf.fillColor("#000");
              put(cell(p), M + j * (colW + 12), y, { width: colW });
            });
            pdf.y = y + h;
          }
          pdf.y += 3; break;
        }
        case "table": {
          const n = b.head.length;
          const weights = b.head.map((h, c) => {
            const longest = Math.max(h.label.length, ...b.rows.map((r) => Math.min(40, safe(r[c]).length)));
            return h.numeric ? Math.max(6, Math.min(longest, 12)) : Math.max(8, longest);
          });
          const total = weights.reduce((a, x) => a + x, 0);
          const widths = weights.map((x) => (x / total) * W);
          const pad = 3;
          const drawHead = () => {
            pdf.fontSize(8.5).fillColor("#000");
            const h = Math.max(...b.head.map((c, i) => heightOf(c.label, widths[i]! - 2 * pad, true))) + 2 * pad;
            ensure(h + 14);
            const y = pdf.y;
            let x = M;
            b.head.forEach((c, i) => { put(c.label, x + pad, y + pad, { width: widths[i]! - 2 * pad, align: c.numeric ? "right" : "left", bold: true }); x += widths[i]!; });
            pdf.moveTo(M, y + h).lineTo(M + W, y + h).lineWidth(0.8).strokeColor("#000").stroke();
            pdf.y = y + h;
          };
          drawHead();
          for (const r of b.rows) {
            pdf.fontSize(9);
            const h = Math.max(...r.map((c, i) => heightOf(String(c ?? ""), widths[i]! - 2 * pad))) + 2 * pad;
            if (pdf.y + h > BOTTOM) { pdf.addPage(); drawHead(); pdf.fontSize(9); }
            const y = pdf.y;
            let x = M;
            for (let i = 0; i < n; i++) { pdf.fillColor("#000"); put(String(r[i] ?? ""), x + pad, y + pad, { width: widths[i]! - 2 * pad, align: b.head[i]?.numeric ? "right" : "left" }); x += widths[i]!; }
            pdf.moveTo(M, y + h).lineTo(M + W, y + h).lineWidth(0.3).strokeColor("#bbbbbb").stroke();
            pdf.y = y + h;
          }
          pdf.y += 6; break;
        }
      }
    }

    // footer text after the content
    ensure(40);
    pdf.y += 10;
    pdf.moveTo(M, pdf.y).lineTo(M + W, pdf.y).lineWidth(0.5).strokeColor("#999999").stroke();
    pdf.y += 5;
    pdf.fontSize(8.5).fillColor(GRAY);
    if (d.footer) put(d.footer, M, pdf.y, { width: W });
    put(`Printed by ${d.printedBy} on ${d.printedAt}`, M, pdf.y, { width: W });

    // page numbers
    const range = pdf.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      pdf.switchToPage(i);
      pdf.font(face("latin", false)).fontSize(8).fillColor(GRAY).text(`Page ${i - range.start + 1} of ${range.count}`, M, 841.89 - M + 6, { width: W, align: "right", lineBreak: false });
    }
    pdf.end();
  });
}
