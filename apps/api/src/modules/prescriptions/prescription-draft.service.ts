import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { parsePrescriptionDocument, type TestKind } from "./scan-document";
import { parsePrescriptionLines, type SuggestedLine } from "./scan-parse";
import { ScansService } from "./scans.service";

/** Standard advice a doctor can add with one click and then edit. General guidance only, never specific to a hospital or a patient. */
export const ADVICE_PHRASES: readonly string[] = [
  "Take rest and drink plenty of fluids",
  "Take the medicines exactly as prescribed and complete the course",
  "Avoid oily, spicy and outside food",
  "Take the medicines after food",
  "Do not skip meals",
  "Avoid self-medication and do not stop medicines without asking the doctor",
  "Return or call the hospital if the fever lasts more than 3 days or the symptoms get worse",
  "Go to the emergency department at once if there is chest pain, breathlessness, severe bleeding or fainting",
  "Keep the wound or dressing clean and dry",
  "Come back with the test reports",
];

export interface MatchedMedicine { id: string; brandName: string; genericName: string; strength: string | null; dosageForm: string }
export interface MatchedTest { id: string; name: string; code: string }
type Check = "MATCH" | "PARTIAL" | "DIFFERENT" | "NOT_ON_PAPER";

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const tokens = (s: string): string[] => norm(s).split(" ").filter((t) => t.length >= 2);
/** A strength with its spaces removed, so "500mg" on the paper and "500 mg" in the medicine list are the same strength. */
const strengthKey = (s: string): string => norm(s).replace(/ /g, "");

/**
 * The prescription as it can be built from a handwritten picture (docs/prescriptions.md): what OCR read, matched to the hospital's own medicine list and
 * lab-test list, with the patient on the paper checked against the patient of the visit. A suggestion only: it saves and orders nothing. The doctor reviews
 * it, fixes it with the dropdowns, applies it to the digital prescription and signs there, which is the doctor's approval.
 */
@Injectable()
export class PrescriptionDraftService {
  constructor(private readonly prisma: PrismaService, private readonly scans: ScansService) {}

  /** The three dropdowns (Drug, Medicine, Lab test) and the standard advice, from the hospital's own lists. */
  async options(ctx: RequestContext) {
    const [medicines, labTests] = await Promise.all([
      this.prisma.medicine.findMany({ where: { tenantId: ctx.tenantId, status: "ACTIVE" }, orderBy: [{ brandName: "asc" }, { strength: "asc" }], take: 1000, select: { id: true, brandName: true, genericName: true, strength: true, dosageForm: true } }),
      this.prisma.service.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "ACTIVE", category: "INVESTIGATION" }, orderBy: { name: "asc" }, take: 500, select: { id: true, code: true, name: true } }),
    ]);
    const drugs = [...new Set(medicines.map((m) => m.genericName.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    return { drugs, medicines, labTests, advice: ADVICE_PHRASES, limits: { medicines: 1000, labTests: 500 }, truncated: { medicines: medicines.length === 1000, labTests: labTests.length === 500 } };
  }

  async fromScan(ctx: RequestContext, scanId: string) {
    const scan = await this.scans.textOf(ctx, scanId);
    const text = scan.text?.trim() ?? "";
    const patient = await this.prisma.patient.findFirstOrThrow({ where: { id: scan.patientId, tenantId: ctx.tenantId }, select: { firstName: true, lastName: true, gender: true, dateOfBirth: true } });
    const parts = text ? parsePrescriptionDocument(text) : parsePrescriptionDocument("");
    const lines: SuggestedLine[] = text ? parsePrescriptionLines(text) : [];

    // Medicines: matched to the hospital's medicine list by brand or generic name (and strength when it was read).
    const names = [...new Set(lines.map((l) => l.name.trim()).filter((n) => n.length >= 2))].slice(0, 30);
    const candidates = names.length
      ? await this.prisma.medicine.findMany({ where: { tenantId: ctx.tenantId, status: "ACTIVE", OR: names.flatMap((n) => [{ brandName: { contains: n, mode: "insensitive" as const } }, { genericName: { contains: n, mode: "insensitive" as const } }]) }, take: 300, select: { id: true, brandName: true, genericName: true, strength: true, dosageForm: true } })
      : [];
    const matchMedicine = (l: SuggestedLine): MatchedMedicine | null => {
      const n = norm(l.name);
      const strength = l.strength ? strengthKey(l.strength) : "";
      const scored = candidates.map((m) => {
        const brand = norm(m.brandName), generic = norm(m.genericName);
        const nameScore = brand === n ? 4 : generic === n ? 3 : brand.startsWith(n) || n.startsWith(brand) ? 2 : generic.startsWith(n) || n.startsWith(generic) ? 2 : brand.includes(n) || generic.includes(n) ? 1 : 0;
        return { m, score: nameScore === 0 ? 0 : nameScore * 10 + (strength && m.strength && strengthKey(m.strength) === strength ? 5 : 0) };
      }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score || a.m.brandName.length - b.m.brandName.length || a.m.id.localeCompare(b.m.id));
      return scored[0]?.m ?? null;
    };

    // Tests: matched to the hospital's lab-test list.
    const services = parts.tests.length
      ? await this.prisma.service.findMany({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, status: "ACTIVE", category: "INVESTIGATION" }, take: 500, select: { id: true, code: true, name: true } })
      : [];
    const matchTest = (t: string): MatchedTest | null => {
      const n = norm(t);
      if (n.length < 2) return null;
      const exact = services.find((s) => norm(s.name) === n || norm(s.code) === n);
      if (exact) return exact;
      const contained = services.filter((s) => n.length >= 3 && (norm(s.name).includes(n) || (norm(s.name).length >= 3 && n.includes(norm(s.name))))).sort((a, b) => a.name.length - b.name.length)[0];
      if (contained) return contained;
      // All the words of the list entry are among the words written (or the other way round): "X-ray chest PA" is the "Chest X-ray" test.
      const words = n.split(" ").filter(Boolean);
      const sameWords = (s: { name: string }): boolean => { const w = norm(s.name).split(" ").filter(Boolean); return w.length >= 2 && words.length >= 2 && (w.every((x) => words.includes(x)) || words.every((x) => w.includes(x))); };
      return services.filter(sameWords).sort((a, b) => a.name.length - b.name.length)[0] ?? null;
    };

    // The patient on the paper against the patient of the visit.
    const warnings: string[] = [];
    const fullName = [patient.firstName, patient.lastName].filter(Boolean).join(" ");
    let nameCheck: Check = "NOT_ON_PAPER";
    if (parts.patient.name) {
      const a = tokens(parts.patient.name), b = tokens(fullName);
      const common = a.filter((t) => b.some((u) => u === t || (t.length >= 3 && u.startsWith(t)) || (u.length >= 3 && t.startsWith(u)))).length;
      nameCheck = common === 0 ? "DIFFERENT" : common < Math.min(a.length, b.length) ? "PARTIAL" : "MATCH";
      if (nameCheck === "DIFFERENT") warnings.push(`The name on the paper ("${parts.patient.name}") does not match this patient. Check that the right picture was uploaded for the right patient.`);
      else if (nameCheck === "PARTIAL") warnings.push(`The name on the paper ("${parts.patient.name}") only partly matches this patient. Please check it.`);
    }
    let ageCheck: Check = "NOT_ON_PAPER";
    if (parts.patient.age !== undefined && patient.dateOfBirth) {
      const years = Math.floor((Date.now() - patient.dateOfBirth.getTime()) / (365.25 * 86_400_000));
      ageCheck = Math.abs(years - parts.patient.age) <= 2 ? "MATCH" : "DIFFERENT";
      if (ageCheck === "DIFFERENT") warnings.push(`The age on the paper (${parts.patient.age}) is not the age of this patient (${years}). Check the patient.`);
    }
    let genderCheck: Check = "NOT_ON_PAPER";
    if (parts.patient.gender && (patient.gender === "MALE" || patient.gender === "FEMALE")) {
      genderCheck = patient.gender === parts.patient.gender ? "MATCH" : "DIFFERENT";
      if (genderCheck === "DIFFERENT") warnings.push("The sex on the paper is different from this patient's. Check the patient.");
    }
    if (!text) warnings.push(scan.ocrError ? `Nothing could be read from the picture: ${scan.ocrError}. Fill in the prescription by hand with the lists below.` : "Nothing has been read from the picture yet. Press Read, or fill in the prescription by hand with the lists below.");
    else if (lines.length === 0 && parts.diagnoses.length === 0 && parts.tests.length === 0) warnings.push("The text was read but no medicines, diagnosis or tests could be picked out of it. Fill in the prescription by hand with the lists below.");

    return {
      scanId, encounterId: scan.encounterId, hasText: text.length > 0, ocrError: scan.ocrError,
      patientCheck: { nameOnPaper: parts.patient.name ?? null, name: nameCheck, ageOnPaper: parts.patient.age ?? null, age: ageCheck, genderOnPaper: parts.patient.gender ?? null, gender: genderCheck },
      warnings,
      diagnoses: parts.diagnoses,
      medicines: lines.map((l) => ({ ...l, matched: matchMedicine(l) })),
      tests: parts.tests.map((t: { text: string; category: TestKind }) => ({ text: t.text, category: t.category, matched: matchTest(t.text) })),
      advice: parts.advice, diet: parts.diet, referral: parts.referral ?? null, followUpDays: parts.followUpDays ?? null,
    };
  }
}
