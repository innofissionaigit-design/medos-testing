/**
 * A best-effort reading of OCR text into the parts of a prescription other than the medicine lines (those are read by scan-parse.ts): who it is for, the
 * diagnosis, the tests, the advice, the diet, a referral and a follow-up. Suggestions only: handwriting and OCR make mistakes, nothing here is saved or
 * ordered, and the doctor reviews every part before it goes onto the prescription (docs/prescriptions.md).
 */
export type TestKind = "LABORATORY" | "RADIOLOGY" | "CARDIOLOGY" | "PROCEDURE";

export interface DocumentParts {
  /** What the paper says about the patient, to be compared with the patient the visit belongs to. */
  patient: { name?: string; age?: number; gender?: "MALE" | "FEMALE" };
  diagnoses: string[];
  tests: { text: string; category: TestKind }[];
  advice: string[];
  diet: string[];
  referral?: string;
  followUpDays?: number;
}

type Section = "dx" | "inv" | "advice" | "diet" | "referral" | "followup" | "rx";
const SEP = String.raw`\b\.?\s*[:\-–=]?\s*(.*)$`;
const HEADERS: [Section, RegExp][] = [
  ["dx", new RegExp(String.raw`^\s*(?:provisional\s+|final\s+|clinical\s+)?(?:diagnosis|diag|dx|impression|d\/d)` + SEP, "i")],
  ["inv", new RegExp(String.raw`^\s*(?:investigations?(?:\s+advised)?|inv|ix|tests?(?:\s+advised)?|advised\s+tests?|lab(?:oratory)?(?:\s+tests?)?)` + SEP, "i")],
  ["diet", new RegExp(String.raw`^\s*(?:diet(?:ary)?(?:\s+advice)?)` + SEP, "i")],
  ["referral", new RegExp(String.raw`^\s*(?:referral|referred(?:\s+to)?|refer(?:\s+to)?|ref\.?\s+to)` + SEP, "i")],
  ["followup", new RegExp(String.raw`^\s*(?:follow\s*-?\s*up|f\/u|review|revisit|next\s+visit)` + SEP, "i")],
  ["advice", new RegExp(String.raw`^\s*(?:advice|adv|instructions?|counsel+ing|notes?)` + SEP, "i")],
  ["rx", new RegExp(String.raw`^\s*(?:rx|℞|medicines?|medications?)` + SEP, "i")],
];

const BULLET = /^\s*(?:[-•*]|\(?\d{1,2}[.)])\s*/;
const clean = (s: string): string => s.replace(BULLET, "").replace(/\s+/g, " ").replace(/^[\s,;:.\-–]+|[\s,;:.\-–]+$/g, "").trim();
const unique = (xs: string[], max: number): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) { const k = x.toLowerCase(); if (x.length >= 2 && x.length <= 120 && !seen.has(k)) { seen.add(k); out.push(x); } }
  return out.slice(0, max);
};
const list = (s: string): string[] => s.split(/[,;+&]|\band\b/i).map(clean).filter(Boolean);

/** Tests whose short names are recognised anywhere in the text (the short ones only in capitals, to avoid reading ordinary words as tests). */
const KNOWN: [RegExp, string, TestKind][] = [
  [/\bCBC\b/, "CBC", "LABORATORY"], [/\bESR\b/, "ESR", "LABORATORY"], [/\bLFT\b/, "LFT", "LABORATORY"], [/\b(?:KFT|RFT)\b/, "KFT", "LABORATORY"],
  [/\b(?:RBS|FBS|PPBS)\b/, "Blood sugar", "LABORATORY"], [/\bTSH\b/, "TSH", "LABORATORY"], [/\bCRP\b/, "CRP", "LABORATORY"],
  [/\bhb\s?a1c\b/i, "HbA1c", "LABORATORY"], [/\blipid\s+profile\b/i, "Lipid profile", "LABORATORY"], [/\burine\s+(?:r\s?\/\s?e|routine)\b/i, "Urine routine", "LABORATORY"],
  [/\bx[- ]?ray\b/i, "X-ray", "RADIOLOGY"], [/\bUSG\b/, "USG", "RADIOLOGY"], [/\bCT\b/, "CT scan", "RADIOLOGY"], [/\bMRI\b/, "MRI", "RADIOLOGY"],
  [/\bECG\b/, "ECG", "CARDIOLOGY"], [/\b(?:ECHO|2D\s?echo)\b/i, "Echo", "CARDIOLOGY"], [/\bTMT\b/, "TMT", "CARDIOLOGY"],
  [/\b(?:endoscopy|biopsy|spirometry|FNAC)\b/i, "", "PROCEDURE"],
];

/** What kind of test a name is: imaging, a heart test, a procedure, or (the usual case) a laboratory test. */
export function testKind(name: string): TestKind {
  if (/\b(x[- ]?ray|usg|ultrasound|sonograph|ct\b|mri|mammogra|dexa|doppler)/i.test(name)) return "RADIOLOGY";
  if (/\b(ecg|ekg|echo|tmt|holter|stress test|angiogra)/i.test(name)) return "CARDIOLOGY";
  if (/\b(endoscop|colonoscop|biopsy|spirometr|fnac|pft|eeg|emg|nerve conduction)/i.test(name)) return "PROCEDURE";
  return "LABORATORY";
}

export function parsePrescriptionDocument(text: string): DocumentParts {
  const out: DocumentParts = { patient: {}, diagnoses: [], tests: [], advice: [], diet: [] };
  const dx: string[] = [], inv: string[] = [], advice: string[] = [], diet: string[] = [];
  const bare: string[] = []; // lines that belong to no section, searched for well-known tests
  let section: Section | null = null;

  for (const rawLine of text.split(/\n/).slice(0, 200)) {
    const line = rawLine.trim();
    if (!line) { section = null; continue; }
    const hit = HEADERS.map(([key, re]) => ({ key, m: re.exec(line) })).find((h) => h.m);
    const content = hit ? (hit.m?.[1] ?? "") : line;
    if (hit) section = hit.key;
    switch (section) {
      case "dx": dx.push(...list(content)); break;
      case "inv": inv.push(...list(content)); break;
      case "advice": { const c = clean(content); if (c) advice.push(...c.split(/;|\.\s+/).map(clean).filter(Boolean)); break; }
      case "diet": { const c = clean(content); if (c) diet.push(...c.split(/;|\.\s+/).map(clean).filter(Boolean)); break; }
      case "referral": { const c = clean(content); if (c && !out.referral) out.referral = c.slice(0, 500); break; }
      case "followup": { const d = followUpDays(line); if (d && !out.followUpDays) out.followUpDays = d; break; }
      case "rx": break;
      default: bare.push(line);
    }
  }
  if (!out.followUpDays) out.followUpDays = followUpDays(text);

  // The patient, as written on the paper.
  const name = /\b(?:patient(?:'s)?\s*name|pt\.?\s*name|name|patient)\s*[:\-–]\s*([A-Za-z][A-Za-z.' ]{1,58}?)(?=\s{2,}|\s+(?:age|sex|gender|date|dob|mrn|uhid|id)\b|[,;\n]|$)/i.exec(text)?.[1];
  if (name) out.patient.name = clean(name);
  const age = /\bage\s*[:\-–/]?\s*(\d{1,3})\b/i.exec(text)?.[1] ?? /\b(\d{1,3})\s*(?:y|yrs?|years?)\b/i.exec(text)?.[1] ?? /\b(\d{1,3})\s*[\/,]\s*[mf]\b/i.exec(text)?.[1];
  if (age && Number(age) <= 120) out.patient.age = Number(age);
  const sex = /\b(?:sex|gender)\s*[:\-–/]?\s*(male|female|m|f)\b/i.exec(text)?.[1] ?? /\b\d{1,3}\s*(?:y|yrs?|years?)?\s*[\/,]\s*(m|f)\b/i.exec(text)?.[1];
  if (sex) out.patient.gender = /^f/i.test(sex) ? "FEMALE" : "MALE";

  out.diagnoses = unique(dx, 10);
  out.advice = unique(advice, 15);
  out.diet = unique(diet, 10);

  // Tests: the ones written under a "tests" heading, then any well-known test named elsewhere on the page.
  const named = inv.map((t) => ({ text: t, category: testKind(t) }));
  for (const line of bare) {
    for (const [re, label, category] of KNOWN) {
      const m = re.exec(line);
      if (m) named.push({ text: label || clean(m[0]).replace(/^./, (c) => c.toUpperCase()), category });
    }
  }
  const seen = new Set<string>();
  out.tests = named.filter((t) => { const k = t.text.toLowerCase(); if (t.text.length < 2 || t.text.length > 120 || seen.has(k)) return false; seen.add(k); return true; }).slice(0, 20);
  return out;
}

function followUpDays(s: string): number | undefined {
  const m = /\b(?:follow\s*-?\s*up|f\/u|review|revisit|next\s+visit|after)\b[^0-9\n]{0,20}(\d{1,3})\s*(days?|d|weeks?|wks?|w|months?)\b/i.exec(s);
  if (!m) return undefined;
  const unit = (m[2] ?? "").toLowerCase();
  const n = Number(m[1]) * (unit.startsWith("w") ? 7 : unit.startsWith("m") ? 30 : 1);
  return n >= 1 && n <= 365 ? n : undefined;
}
