/**
 * What the AI assistant is told and what it is given (docs/ai-assistant.md). The assistant only drafts for a doctor to check. It is told, in every request, not to
 * diagnose, not to prescribe and not to add anything that is not in the material. The material is built here from the visit's own data and scrubbed of names,
 * numbers and other identifiers before it leaves the server.
 */
export const MAX_INPUT_CHARS = 6000;
export const MAX_OUTPUT_CHARS = 4000;
export const MAX_TOKENS = 700;

const RULES = [
  "You help a doctor in an Indian hospital by drafting text from the material they give you. A doctor will read and edit everything you write before it is used.",
  "Use only what is in the material. Do not diagnose. Do not suggest, add, stop or change any medicine, dose or test. Do not predict the outcome of an illness.",
  "If something the doctor would need is missing from the material, say it is missing instead of guessing.",
  "The material has had names and identifiers removed. Do not try to work out who the patient is.",
  "Write in plain, short sentences. No headings with markdown symbols; simple lines or short bullet points with a leading dash are fine.",
];

export const SYSTEM_HISTORY = [...RULES, "Task: summarise the patient's earlier visits for the doctor who is about to see them. List, in order of date: the problem, the diagnosis, the medicines given and anything the doctor asked the patient to do. Start with any allergies. Keep it under 200 words."].join(" ");
export const SYSTEM_ADVICE = [...RULES, "Task: draft advice for the patient in simple language, covering only the diagnoses and medicines in the material: what the medicines are for in general terms, how to take them as written, and when to come back or seek help only if the doctor's own advice says so. Write it as the doctor speaking to the patient. Keep it under 200 words."].join(" ");

/** Removes what could identify a person from free text: their own name (and relatives' names given), phone numbers, e-mail addresses, record numbers, long digit strings. Best effort, not a promise. */
export function scrub(text: string, names: string[]): string {
  let t = text;
  for (const n of names) {
    for (const part of n.split(/\s+/).filter((p) => p.length >= 3)) t = t.replace(new RegExp(`\\b${part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), "[name]");
  }
  return t
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[email]")
    .replace(/(\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}\b/g, "[phone]")
    .replace(/\b[A-Z]{2,}-[A-Z0-9-]*\d{3,}\b/g, "[number]")
    .replace(/\b\d{6,}\b/g, "[number]")
    .replace(/\s+/g, " ")
    .trim();
}

export interface PatientFacts { ageYears: number | null; sex: string; allergies: { allergen: string; severity: string; reaction: string | null }[]; names: string[] }
export interface MedicineFacts { name: string; dose: string; frequency: string; days: number | null; food: string | null; note: string | null }
export interface VisitFacts { when: string; complaint: string | null; advice: string | null; diagnoses: string[]; medicines: MedicineFacts[] }

const line = (s: string | null | undefined, names: string[]) => (s ? scrub(s, names) : "");

function visitText(v: VisitFacts, names: string[]): string {
  const meds = v.medicines.map((m) => `${scrub(m.name, names)} ${scrub(m.dose, names)} ${m.frequency}${m.days ? ` for ${m.days} days` : ""}${m.food ? `, ${m.food.toLowerCase().replace(/_/g, " ")}` : ""}${m.note ? `, ${scrub(m.note, names)}` : ""}`);
  return [`Visit on ${v.when}`, v.complaint ? `Complaint: ${line(v.complaint, names)}` : "", v.diagnoses.length ? `Diagnosis: ${v.diagnoses.map((d) => scrub(d, names)).join("; ")}` : "", meds.length ? `Medicines: ${meds.join("; ")}` : "", v.advice ? `Doctor's advice: ${line(v.advice, names)}` : ""].filter(Boolean).join("\n");
}

const header = (p: PatientFacts) => `Patient: ${p.ageYears !== null ? `${p.ageYears} years` : "age not recorded"}, ${p.sex.toLowerCase()}.${p.allergies.length ? ` Known allergies: ${p.allergies.map((a) => `${scrub(a.allergen, p.names)} (${a.severity.toLowerCase().replace(/_/g, " ")}${a.reaction ? `, ${scrub(a.reaction, p.names)}` : ""})`).join("; ")}.` : " No allergies recorded."}`;

/** Earlier visits, newest first, as plain text, cut to the size limit by dropping the oldest. */
export function historyMaterial(p: PatientFacts, visits: VisitFacts[]): string {
  let out = header(p);
  for (const v of visits) {
    const next = `${out}\n\n${visitText(v, p.names)}`;
    if (next.length > MAX_INPUT_CHARS) break;
    out = next;
  }
  return out;
}

export function adviceMaterial(p: PatientFacts, v: VisitFacts): string {
  return `${header(p)}\n\n${visitText(v, p.names)}`.slice(0, MAX_INPUT_CHARS);
}

/** True when a visit has something to draft advice from. */
export const hasAdviceMaterial = (v: VisitFacts): boolean => v.diagnoses.length > 0 || v.medicines.length > 0;

export const DRAFT_NOTICE = "AI draft for the doctor to check. It is not medical advice and is not part of the record until the doctor uses it.";

/** Keeps the reply to a sensible size and strips characters that do not belong in a note. */
export function tidyReply(text: string): string {
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim().slice(0, MAX_OUTPUT_CHARS);
}
