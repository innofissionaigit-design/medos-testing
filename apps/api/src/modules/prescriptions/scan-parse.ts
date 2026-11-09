/**
 * A best-effort reading of OCR text into medicine lines the doctor can add to the prescription with one click. These are suggestions only:
 * handwriting and OCR make mistakes, nothing here orders or dispenses anything, and the doctor reviews and approves every line (docs/prescriptions.md).
 */
export interface SuggestedLine {
  /** The line as it was read. */
  raw: string;
  name: string;
  strength?: string;
  form?: string;
  /** For example "1 tablet" or "5 ml". */
  dosage?: string;
  route?: "ORAL" | "IM" | "TOPICAL" | "OTHER";
  frequency?: "OD" | "BD" | "TDS" | "QID" | "HS" | "SOS" | "STAT";
  foodRelation?: "BEFORE_FOOD" | "AFTER_FOOD" | "WITH_FOOD" | "EMPTY_STOMACH";
  durationDays?: number;
  /** The total to dispense, when the handwriting gives one (for example "qty 10" or "#10"). */
  quantity?: number;
  /** What is left of the line after the parts above (for example "with warm water"). */
  instructions?: string;
}

const FORMS: Record<string, string> = { tab: "TABLET", tablet: "TABLET", t: "TABLET", cap: "CAPSULE", capsule: "CAPSULE", c: "CAPSULE", syp: "SYRUP", syrup: "SYRUP", inj: "INJECTION", injection: "INJECTION", oint: "OINTMENT", ointment: "OINTMENT", drops: "DROPS", drop: "DROPS", gel: "OINTMENT" };
const FORM_PREFIX = /^(tablet|tab|capsule|cap|syrup|syp|injection|inj|ointment|oint|drops?|gel|t|c)\.?\s+/i;
const STRENGTH = /(\d+(?:\.\d+)?\s?(?:mg|mcg|µg|g|ml|iu|%))/i;
const PATTERN = /(?<![\d.])([0-3])\s*[-–]\s*([0-3])\s*[-–]\s*([0-3])(?:\s*[-–]\s*([0-3]))?(?![\d.])/;
const WORDS: [RegExp, SuggestedLine["frequency"]][] = [
  [/\b(sos|prn|if needed|when required)\b/i, "SOS"], [/\bstat\b/i, "STAT"], [/\b(qid|four times|4 times)\b/i, "QID"], [/\b(tds|tid|thrice|three times|3 times)\b/i, "TDS"],
  [/\b(bd|bid|twice|two times|2 times)\b/i, "BD"], [/\b(hs|at bedtime|bedtime|at night)\b/i, "HS"], [/\b(od|once|daily|1 time)\b/i, "OD"],
];
const FOOD: [RegExp, NonNullable<SuggestedLine["foodRelation"]>][] = [
  [/\b(empty stomach)\b/i, "EMPTY_STOMACH"], [/\b(before|bef\.?|a\.?c\.?)\s*(food|meals?|breakfast|lunch|dinner)\b/i, "BEFORE_FOOD"],
  [/\b(after|aft\.?|p\.?c\.?)\s*(food|meals?|breakfast|lunch|dinner)\b/i, "AFTER_FOOD"], [/\b(with|along with)\s*(food|meals?)\b/i, "WITH_FOOD"],
];
const QTY = /(?:\b(?:qty|quantity|disp(?:ense)?)\b\.?\s*[:=]?\s*|\bno\.?\s*|#\s*)(\d{1,5})\b|\(\s*(\d{1,5})\s*(?:tabs?|tablets?|caps?|capsules?|strips?|bottles?|nos?)\s*\)|(?:^|\s)x\s*(\d{1,5})\s*(?:tabs?|tablets?|caps?|capsules?|strips?|bottles?|nos?)\b/i;
const DOSE: Record<string, [string, SuggestedLine["route"]]> = { TABLET: ["1 tablet", "ORAL"], CAPSULE: ["1 capsule", "ORAL"], SYRUP: ["5 ml", "ORAL"], INJECTION: ["1 ampoule", "IM"], OINTMENT: ["Apply thinly", "TOPICAL"], DROPS: ["2 drops", "OTHER"] };

export function parsePrescriptionLines(text: string): SuggestedLine[] {
  const out: SuggestedLine[] = [];
  for (const rawLine of text.split(/\n+/).slice(0, 80)) {
    const raw = rawLine.trim();
    if (raw.length < 3) continue;
    let rest = raw.replace(/^\s*\(?\d{1,2}[.)]\s*/, "").replace(/^[-•*]\s*/, "");
    const form = FORM_PREFIX.exec(rest);
    if (form) rest = rest.slice(form[0].length);
    const strength = STRENGTH.exec(rest)?.[1]?.replace(/\s+/g, "");
    let frequency: SuggestedLine["frequency"] | undefined;
    const pat = PATTERN.exec(rest);
    if (pat) {
      const doses = [pat[1], pat[2], pat[3], pat[4]].filter((x): x is string => x !== undefined);
      const given = doses.filter((d) => d !== "0").length;
      frequency = doses.length === 4 ? "QID" : given === 1 ? (doses[2] !== "0" && doses[0] === "0" && doses[1] === "0" ? "HS" : "OD") : given === 2 ? "BD" : given >= 3 ? "TDS" : undefined;
    } else {
      frequency = WORDS.find(([re]) => re.test(rest))?.[1];
    }
    const dur = /(?:x|for|×)\s*(\d{1,3})\s*(days?|d|weeks?|wks?|w)\b/i.exec(rest);
    const durationDays = dur ? Math.min(365, Number(dur[1]) * (/^w/i.test(dur[2] ?? "") ? 7 : 1)) : undefined;
    // Only lines that look like a medicine: a form prefix, or a strength together with a frequency.
    if (!form && !(strength && frequency)) continue;
    const qtyHit = QTY.exec(rest);
    const quantity = qtyHit ? Number(qtyHit[1] ?? qtyHit[2] ?? qtyHit[3]) : undefined;
    const foodHit = FOOD.map(([re, v]) => ({ m: re.exec(rest), v })).find((f) => f.m);
    const cut = [STRENGTH.exec(rest)?.index, pat?.index, dur?.index, foodHit?.m?.index, qtyHit?.index].filter((i): i is number => i !== undefined);
    const name = rest.slice(0, cut.length ? Math.min(...cut) : rest.length).replace(/[,;:.\s-]+$/, "").trim();
    if (name.length < 2) continue;
    const key = form?.[1]?.toLowerCase().replace(/\.$/, "") ?? "";
    const formName = FORMS[key];
    const explicitDose = /(\d+(?:\.\d+)?)\s*(tabs?|tablets?|caps?|capsules?|ml|drops?|puffs?)\b/i.exec(rest);
    const [defaultDose, route] = (formName && DOSE[formName]) || ["1", "ORAL" as const];
    const dosage = explicitDose ? `${explicitDose[1]} ${/^ml$/i.test(explicitDose[2] ?? "") ? "ml" : (explicitDose[2] ?? "").toLowerCase().replace(/s$/, "")}` : defaultDose;
    // What remains once the recognised parts are taken out is kept as the instructions, for the doctor to keep or clear.
    const leftover = rest
      .replace(name, "").replace(STRENGTH, "").replace(PATTERN, "").replace(dur?.[0] ?? "", "").replace(foodHit?.m?.[0] ?? "", "").replace(explicitDose?.[0] ?? "", "").replace(qtyHit?.[0] ?? "", "")
      .replace(/\b(sos|prn|stat|qid|tds|tid|bd|bid|od|hs|twice|thrice|daily|once|at night|at bedtime|bedtime)\b/gi, "")
      .replace(/[()]/g, " ").replace(/\s+/g, " ").replace(/^[\s,;:.\-–]+|[\s,;:.\-–]+$/g, "").trim();
    out.push({
      raw, name: name.slice(0, 120), ...(strength ? { strength } : {}), ...(formName ? { form: formName } : {}), dosage: dosage.slice(0, 60), route,
      ...(frequency ? { frequency } : {}), ...(foodHit ? { foodRelation: foodHit.v } : {}), ...(durationDays ? { durationDays } : {}), ...(quantity && quantity <= 100_000 ? { quantity } : {}), ...(leftover.length >= 3 ? { instructions: leftover.slice(0, 200) } : {}),
    });
  }
  return out.slice(0, 30);
}
