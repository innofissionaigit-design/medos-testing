import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import type { Doc } from "./doc";
import { makeSafe, scriptRuns, toPdf } from "./pdf";

/** Every compressed stream in a PDF, decompressed (pdfkit writes content and character maps as Flate). */
const inflated = (pdf: Buffer): string[] => {
  const out: string[] = [];
  for (const m of pdf.toString("latin1").matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    try { out.push(inflateSync(Buffer.from(m[1] as string, "latin1")).toString("latin1")); } catch { /* not a Flate stream */ }
  }
  return out;
};
/** The characters the PDF can show, read from its ToUnicode maps: the destination side of every `<glyph> <unicode>` pair. */
const shownCodes = (pdf: Buffer): Set<string> => {
  const codes = new Set<string>();
  for (const s of inflated(pdf).filter((x) => x.includes("begincmap"))) {
    const list = /beginbfrange\s*<[0-9a-fA-F]{4}>\s*<[0-9a-fA-F]{4}>\s*\[([^\]]*)\]/.exec(s);
    for (const m of (list?.[1] ?? "").matchAll(/<([0-9a-fA-F]{4})>/g)) codes.add(m[1]!.toLowerCase());
  }
  return codes;
};
const text = (pdf: Buffer) => pdf.toString("latin1");
const pages = (pdf: Buffer) => (text(pdf).match(/\/Type\s*\/Page\b(?!s)/g) ?? []).length;

const header = { hospitalName: "Sunrise Care Hospital", tagline: "Care, always", address: "12 Park Street, Kolkata", phone: "033-5550100" };
const doc = (over: Partial<Doc> = {}): Doc => ({
  title: "Invoice", fileBase: "invoice", header, printedBy: "Receptionist One", printedAt: "29 Oct 2026, 10:30",
  blocks: [{ t: "title", text: "Invoice INV-001" }, { t: "kv", rows: [["Patient", "Anita Das"], ["Total", "₹1,250.00"]] }], ...over,
});
const indic = (): Doc => doc({
  header: { ...header, hospitalName: "সূর্যোদয় Hospital", tagline: "भारत में सेवा — Care" },
  blocks: [
    { t: "title", text: "বিল INV-001" },
    { t: "kv", rows: [["রোগী", "অনিতা দাস"], ["Total", "₹1,250.00"], ["डॉक्टर", "Dr. राजेश कुमार"], ["Phone", "98300 12345"]] },
    { t: "table", head: [{ label: "Item" }, { label: "মূল্য", numeric: true }], rows: [["রক্ত পরীক্ষা (Blood test)", "৫০০"], ["परामर्श शुल्क", "₹300.00"]] },
    { t: "para", text: "ক্ষমা করবেন। यह एक परीक्षण है। Mixed English, বাংলা and हिन्दी in one sentence." },
  ],
  banner: "DUPLICATE COPY · নকল কপি",
});

describe("PDF text runs and safe text", () => {
  it("cuts text into runs by script, keeping digits, punctuation and ₹ in the Latin font", () => {
    assert.deepEqual(scriptRuns("Hello"), [{ script: "latin", text: "Hello" }]);
    assert.deepEqual(scriptRuns("Dr. দাস 5"), [{ script: "latin", text: "Dr. " }, { script: "bengali", text: "দাস " }, { script: "latin", text: "5" }], "digits and the dot are Latin; a space joins the run before it");
    assert.deepEqual(scriptRuns("नमस्ते World").map((r) => r.script), ["devanagari", "latin"]);
    assert.deepEqual(scriptRuns("৫০০ টাকা").map((r) => r.script), ["bengali"], "Bengali digits are Bengali; the space stays inside the run");
    assert.deepEqual(scriptRuns("₹1,250.00").map((r) => r.script), ["latin"]);
    assert.deepEqual(scriptRuns(""), []);
  });

  it("keeps joiners with the letters around them and dandas with the surrounding Indic text", () => {
    assert.deepEqual(scriptRuns("ক‍ষ"), [{ script: "bengali", text: "ক‍ষ" }], "a zero-width joiner never splits a conjunct");
    assert.deepEqual(scriptRuns("কাজ। শেষ").map((r) => r.script), ["bengali"], "the danda stays Bengali inside Bengali text");
    assert.deepEqual(scriptRuns("काम। खत्म").map((r) => r.script), ["devanagari"]);
    assert.deepEqual(scriptRuns("।").map((r) => r.script), ["devanagari"], "alone it falls back to the Devanagari font");
  });

  it("replaces only what no font can draw, and says so with a question mark", () => {
    const safe = makeSafe(true);
    assert.equal(safe("₹ café — “quoted” • …"), "₹ café — “quoted” • …");
    assert.equal(safe("সূর্যোদয় भारत"), "সূর্যোদয় भारत");
    assert.equal(safe("ok 😀 日本"), "ok ? ??");
    assert.equal(safe("a\u0007b"), "a?b", "control characters never reach the PDF");
    assert.equal(safe(null), "");
    assert.equal(safe(42), "42");
    assert.equal(safe("keep\ttab\nline"), "keep\ttab\nline");
  });

  it("without the fonts it falls back to the old Latin-only rules", () => {
    const legacy = makeSafe(false);
    assert.equal(legacy("₹ café — x"), "Rs. café - x");
    assert.equal(legacy("সূর্যোদয়"), "?????????");
  });
});

describe("PDF rendering with embedded fonts", () => {
  it("draws Bengali, Hindi, the rupee sign and Latin as real glyphs, in their own fonts", async () => {
    const pdf = await toPdf(indic());
    assert.equal(text(pdf).slice(0, 5), "%PDF-");
    assert.match(text(pdf).slice(-12), /%%EOF/);
    const shown = shownCodes(pdf);
    for (const [what, cp] of [["Bengali স", "09b8"], ["Bengali ক", "0995"], ["Bengali digit ৫", "09eb"], ["Devanagari भ", "092d"], ["Devanagari ड", "0921"], ["rupee ₹", "20b9"], ["Latin H", "0048"], ["danda ।", "0964"], ["em dash —", "2014"]] as const) {
      assert.ok(shown.has(cp), `${what} (U+${cp.toUpperCase()}) is drawn`);
    }
    assert.ok(!shown.has("003f"), "nothing was replaced by a question mark");
    for (const family of ["NotoSansBengali-Regular", "NotoSansBengali-Bold", "NotoSansDevanagari-Regular", "NotoSans-Regular", "NotoSans-Bold"]) assert.match(text(pdf), new RegExp(`\\+${family}`), `${family} is embedded`);
    assert.doesNotMatch(text(pdf), /Helvetica/, "no fallback font was needed");
  });

  it("an English-only document embeds only the Latin font", async () => {
    const pdf = await toPdf(doc());
    const t = text(pdf);
    assert.match(t, /\+NotoSans-Regular/);
    assert.doesNotMatch(t, /NotoSansBengali|NotoSansDevanagari|Helvetica/);
    const shown = shownCodes(pdf);
    assert.ok(shown.has("20b9"), "₹ is printed as ₹ now, not as 'Rs.'");
    assert.ok(!shown.has("003f"));
    assert.ok(pdf.length < 120_000, `subsetting keeps it small (${pdf.length} bytes)`);
  });

  it("shows '?' for characters no embedded font has, instead of dropping them", async () => {
    const pdf = await toPdf(doc({ blocks: [{ t: "para", text: "Emoji 😀 and kanji 日本 are not in the fonts" }] }));
    assert.ok(shownCodes(pdf).has("003f"));
  });

  it("falls back to Helvetica and still prints when the font files are missing", async () => {
    const pdf = await toPdf(indic(), "/this/folder/does/not/exist");
    assert.equal(text(pdf).slice(0, 5), "%PDF-");
    assert.match(text(pdf), /Helvetica/);
    assert.doesNotMatch(text(pdf), /NotoSans/);
  });

  it("lays out long mixed-script paragraphs and tables over several pages without error", async () => {
    const sentence = "রোগীর রক্তচাপ নিয়ন্ত্রণে আছে। मरीज़ की हालत स्थिर है। Patient is stable, review in two weeks. ";
    const rows = Array.from({ length: 140 }, (_, i) => [`${i + 1}`, `পরীক্ষা ${i + 1} · जाँच (Test ${i + 1})`, `₹${(i + 1) * 10}.00`]);
    const started = Date.now();
    const pdf = await toPdf(doc({
      blocks: [
        { t: "title", text: "দীর্ঘ প্রতিবেদন / लंबी रिपोर्ट" },
        { t: "para", text: sentence.repeat(40) },
        { t: "table", head: [{ label: "#", numeric: true }, { label: "বিবরণ / विवरण" }, { label: "Amount", numeric: true }], rows },
        { t: "para", text: sentence.repeat(10) },
        { t: "signature", lines: ["ডা. রাজেশ কুমার", "Dr. Rajesh Kumar"] },
      ],
    }));
    assert.ok(pages(pdf) >= 4, `several pages (${pages(pdf)})`);
    assert.ok(Date.now() - started < 8000, `renders in reasonable time (${Date.now() - started} ms)`);
    assert.ok(!shownCodes(pdf).has("003f"), "no character lost along the way");
  });
});
