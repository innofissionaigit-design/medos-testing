import { Injectable } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import { Prisma } from "@medos/database";
import { createHash } from "node:crypto";
import { z } from "zod";
import { actorOf, AuditService } from "../../common/audit.service";
import { logJson } from "../../common/logger";
import { PrismaService } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { localDateStr } from "../../common/time";
import { CatalogService, createServiceSchema } from "../billing/catalog.service";
import { createPatientSchema, PatientsService } from "../patients/patients.service";
import { normalizeName } from "../patients/patient.domain";
import { InventoryService, openingBatchSchema } from "../pharmacy/inventory.service";
import { createMedicineSchema, FORMS, identityKey, MedicinesService } from "../pharmacy/medicines.service";
import { SettingsService } from "../settings/settings.service";
import { CsvError, MAX_IMPORT_BYTES, MAX_IMPORT_ROWS, readTable, type Column, type TableRow } from "./csv";

export const IMPORT_KINDS = ["patients", "medicines", "opening-stock", "services"] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];
export const importKindSchema = z.enum(IMPORT_KINDS);
/** Previewing is the default: nothing is written unless `dryRun=false` is asked for explicitly. */
export const importQuerySchema = z.object({
  dryRun: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  /** Patients only. "skip" (default): a possible duplicate is never created. "import": a patient whose ONLY match is a shared mobile number (a family) is created. */
  sharedMobile: z.enum(["skip", "import"]).default("skip"),
}).strict();

export type RowStatus = "CREATED" | "WOULD_CREATE" | "SKIPPED" | "ERROR";
export interface RowResult { row: number; status: RowStatus; message: string | null; ref: string | null }
export interface ImportReport {
  kind: ImportKind; dryRun: boolean; fileSha256: string; rows: number;
  created: number; wouldCreate: number; skipped: number; failed: number; results: RowResult[];
}

const col = (name: string, description: string, example: string, required = false): Column => ({ name, description, example, ...(required ? { required } : {}) });

const COLUMNS: Record<ImportKind, Column[]> = {
  patients: [
    col("firstName", "Given name", "Anita", true), col("lastName", "Family name", "Das"),
    col("gender", "MALE, FEMALE, OTHER or UNKNOWN (M and F also work)", "FEMALE", true),
    col("dateOfBirth", "YYYY-MM-DD or DD/MM/YYYY. Give this or estimatedAgeYears, not both", "1990-04-02"),
    col("estimatedAgeYears", "Whole number, when the date of birth is not known", "46"),
    col("mobile", "10-digit Indian mobile number (+91 or 0 in front is fine)", "9830012345"),
    col("addressLine", "Street address", "12 Park Street"), col("city", "City or town", "Kolkata"), col("district", "District", "Kolkata"),
    col("state", "State", "West Bengal"), col("postalCode", "6 digits", "700016"),
    col("bloodGroup", "A+, A-, B+, B-, AB+, AB-, O+ or O-", "O+"),
    col("guardianName", "Guardian, for a child", "Ramesh Das"), col("guardianRelation", "Relation to the patient", "Father"), col("guardianMobile", "Guardian's mobile", "9830054321"),
    col("emergencyContactName", "Emergency contact", "Sunita Das"), col("emergencyContactMobile", "Emergency contact's mobile", "9830098765"),
    col("legacyId", "The patient's number in your previous system. It is saved as a legacy ID, and a repeat of the same number is skipped", "OLD-10234"),
  ],
  medicines: [
    col("brandName", "Brand name", "Crocin", true), col("genericName", "Generic (salt) name", "Paracetamol", true),
    col("strength", "Strength, as written on the pack", "500 mg"), col("dosageForm", `One of: ${FORMS.join(", ")}`, "TABLET", true),
    col("manufacturer", "Manufacturer", "GSK"), col("hsnCode", "HSN code, 4-8 digits", "3004"),
    col("gstPercent", "GST percent, 0-100, at most 2 decimals", "12"), col("reorderLevel", "Whole number: warn when stock falls to this", "50"),
  ],
  "opening-stock": [
    col("brandName", "Brand name of a medicine already in the medicine list", "Crocin", true), col("strength", "Needed when the brand has more than one strength", "500 mg"),
    col("dosageForm", "Needed when strength alone does not identify the medicine", "TABLET"),
    col("batchNo", "Batch number from the pack: letters, digits, / . _ -", "B2406A", true),
    col("expiryDate", "YYYY-MM-DD or DD/MM/YYYY; must not be in the past", "2027-08-31", true),
    col("mrp", "Maximum retail price per unit, at most 2 decimals, no thousands separators", "30.00", true),
    col("purchasePrice", "What you paid per unit", "21.50", true), col("sellingPrice", "Selling price per unit; not above the MRP", "28.00", true),
    col("quantity", "Units in stock, a whole number of at least 1", "200", true),
  ],
  services: [
    col("code", "Short unique code, letters, digits, _ and -", "CONSULT-GEN", true), col("name", "Name shown on bills", "General consultation", true),
    col("category", "CONSULTATION, ROOM_BED, PROCEDURE, NURSING, INJECTION_DRESSING, INVESTIGATION or OTHER", "CONSULTATION", true),
    col("price", "Price, at most 2 decimals, no thousands separators", "300.00", true), col("taxPercent", "Tax percent, 0-100 (default 0)", "0"),
    col("sacCode", "SAC/HSN code, 4-8 digits", "999311"),
  ],
};

const LABELS: Record<ImportKind, string> = { patients: "Patients", medicines: "Medicine list", "opening-stock": "Opening stock", services: "Service price list" };
const NOTES: Record<ImportKind, string[]> = {
  patients: [
    "Every row goes through the same checks as registering a patient by hand, including the duplicate check. A row that looks like someone already registered, or like another row in the file, is skipped and reported: nothing is merged.",
    "Shared mobile numbers (families) are skipped by default; choose \"Import patients who only share a mobile number\" to create them anyway.",
    "Each patient gets a new MRN. Put the old number in legacyId to keep it.",
  ],
  medicines: ["A medicine already in the list (same brand, generic name, strength and form) is skipped."],
  "opening-stock": [
    "Import the medicine list first: each row names a medicine that must already exist.",
    "A batch that is already recorded for that medicine is skipped, never added twice, so a file can be re-uploaded safely.",
  ],
  services: ["A code that is already in the price list is skipped; existing prices are never changed by an import."],
};
const PHARMACY_KINDS: ImportKind[] = ["medicines", "opening-stock"];

const GENDER: Record<string, string> = { m: "MALE", male: "MALE", f: "FEMALE", female: "FEMALE", o: "OTHER", other: "OTHER", u: "UNKNOWN", unknown: "UNKNOWN" };
const BLOOD: Record<string, string> = { "a+": "A_POS", "a-": "A_NEG", "b+": "B_POS", "b-": "B_NEG", "ab+": "AB_POS", "ab-": "AB_NEG", "o+": "O_POS", "o-": "O_NEG" };
const PATIENT_TEXT = ["firstName", "lastName", "mobile", "addressLine", "city", "district", "state", "postalCode", "guardianName", "guardianRelation", "guardianMobile", "emergencyContactName", "emergencyContactMobile"] as const;
const LEGACY_ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,39}$/;

/** DD/MM/YYYY (the usual way to write a date in India) becomes YYYY-MM-DD; anything else is passed through for the normal check to judge. */
const isoDay = (v: string): string => { const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v); return m ? `${m[3]}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}` : v; };
const snake = (v: string) => v.trim().toUpperCase().replace(/[\s-]+/g, "_");
const issues = (e: z.ZodError): string => [...new Set(e.issues.map((i) => `${i.path.length ? `${i.path.join(".")}: ` : ""}${i.message}`))].slice(0, 4).join("; ");

interface State { seen: Map<string, number>; todayLocal: string }
interface Opts { dryRun: boolean; sharedMobile: "skip" | "import"; fileKey: string; requestId: string | undefined }

const ok = (row: number, status: RowStatus, message: string | null = null, ref: string | null = null): RowResult => ({ row, status, message, ref });

/** Bulk import from CSV (docs/import.md). Every row is validated and saved by the same service the screens use, so an import can never create data the app would refuse. */
@Injectable()
export class ImportsService {
  /** One import of a kind at a time per hospital on this instance: two at once would race on the duplicate checks. */
  private readonly running = new Set<string>();

  constructor(
    private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly settings: SettingsService,
    private readonly patients: PatientsService, private readonly medicines: MedicinesService, private readonly catalog: CatalogService, private readonly inventory: InventoryService,
  ) {}

  describe(kind: ImportKind) {
    return { kind, label: LABELS[kind], maxRows: MAX_IMPORT_ROWS, maxMegabytes: MAX_IMPORT_BYTES / 1024 / 1024, columns: COLUMNS[kind], notes: NOTES[kind] };
  }

  async run(ctx: RequestContext, kind: ImportKind, body: unknown, o: { dryRun: boolean; sharedMobile: "skip" | "import" }): Promise<ImportReport> {
    if (!Buffer.isBuffer(body) || body.length === 0) throw new DomainError("VALIDATION_FAILED", "Send the CSV file as the request body with content type text/csv", 415);
    if (body.length > MAX_IMPORT_BYTES) throw new DomainError("PAYLOAD_TOO_LARGE", `A file can be at most ${MAX_IMPORT_BYTES / 1024 / 1024} MB`, 413);
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(body); } catch { throw new DomainError("VALIDATION_FAILED", "The file is not valid UTF-8 text. In Excel choose Save As: CSV UTF-8 (comma delimited).", 400); }
    if (PHARMACY_KINDS.includes(kind) && !(await this.settings.isEnabled(ctx.tenantId, ctx.facilityId, "PHARMACY_ENABLED"))) throw new DomainError("FEATURE_DISABLED", "This module is not enabled for your facility", 403);
    let table: TableRow[];
    try { table = readTable(text, COLUMNS[kind]); } catch (e) { if (e instanceof CsvError) throw new DomainError("VALIDATION_FAILED", e.message, 400); throw e; }

    const lock = `${ctx.tenantId}:${kind}`;
    if (this.running.has(lock)) throw new DomainError("IMPORT_IN_PROGRESS", "An import of this kind is already running. Wait for it to finish.", 409);
    this.running.add(lock);
    try {
      const sha = createHash("sha256").update(body).digest("hex");
      const facility = await this.prisma.facility.findFirstOrThrow({ where: { id: ctx.facilityId, tenantId: ctx.tenantId }, select: { timezone: true } });
      const state: State = { seen: new Map(), todayLocal: localDateStr(new Date(), facility.timezone) };
      const opts: Opts = { ...o, fileKey: `import-${sha.slice(0, 16)}`, requestId: ctx.requestId };
      const results: RowResult[] = [];
      for (const r of table) results.push(await this.row(ctx, kind, r, opts, state));
      const count = (s: RowStatus) => results.filter((x) => x.status === s).length;
      const report: ImportReport = { kind, dryRun: o.dryRun, fileSha256: sha, rows: results.length, created: count("CREATED"), wouldCreate: count("WOULD_CREATE"), skipped: count("SKIPPED"), failed: count("ERROR"), results };
      if (!o.dryRun) {
        await this.audit.recordStandalone(actorOf(ctx), {
          action: "DATA_IMPORT_COMPLETED", entityType: "DataImport",
          metadata: { kind, fileSha256: sha, rows: report.rows, created: report.created, skipped: report.skipped, failed: report.failed, ...(kind === "patients" ? { sharedMobile: o.sharedMobile } : {}) },
        });
      }
      return report;
    } finally {
      this.running.delete(lock);
    }
  }

  private async row(ctx: RequestContext, kind: ImportKind, t: TableRow, o: Opts, s: State): Promise<RowResult> {
    if (t.tooManyCells) return ok(t.row, "ERROR", "This row has more values than the header has columns. Check for an unquoted comma.");
    try {
      switch (kind) {
        case "patients": return await this.patientRow(ctx, t, o, s);
        case "medicines": return await this.medicineRow(ctx, t, o, s);
        case "opening-stock": return await this.stockRow(ctx, t, o, s);
        case "services": return await this.serviceRow(ctx, t, o, s);
      }
    } catch (e) {
      if (e instanceof DomainError) return ok(t.row, "ERROR", e.message);
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return ok(t.row, "SKIPPED", "Already exists.");
      logJson("error", "import_row_failed", { requestId: o.requestId, kind, row: t.row, errorName: e instanceof Error ? e.name : typeof e });
      return ok(t.row, "ERROR", "This row could not be saved because of an unexpected error. It was not imported.");
    }
  }

  /** Marks a row as "same as an earlier row" or remembers it. */
  private repeat(s: State, key: string, row: number): number | undefined {
    const prior = s.seen.get(key);
    if (prior === undefined) s.seen.set(key, row);
    return prior;
  }

  // ───── patients ─────

  private async patientRow(ctx: RequestContext, t: TableRow, o: Opts, s: State): Promise<RowResult> {
    const c = t.cells;
    const body: Record<string, unknown> = {};
    for (const k of PATIENT_TEXT) if (c[k] !== undefined) body[k] = c[k];
    if (c["gender"]) body["gender"] = GENDER[c["gender"].toLowerCase()] ?? c["gender"].toUpperCase();
    if (c["dateOfBirth"]) body["dateOfBirth"] = isoDay(c["dateOfBirth"]);
    if (c["estimatedAgeYears"] !== undefined) { if (!/^\d{1,3}$/.test(c["estimatedAgeYears"])) return ok(t.row, "ERROR", "estimatedAgeYears: Enter a whole number"); body["estimatedAgeYears"] = Number(c["estimatedAgeYears"]); }
    if (c["bloodGroup"]) body["bloodGroup"] = BLOOD[c["bloodGroup"].toLowerCase().replace(/\s+/g, "")] ?? c["bloodGroup"].toUpperCase();
    const legacyId = c["legacyId"];
    if (legacyId !== undefined && !LEGACY_ID.test(legacyId)) return ok(t.row, "ERROR", "legacyId: Use up to 40 letters, digits and . _ / -");
    const parsed = createPatientSchema.safeParse(body);
    if (!parsed.success) return ok(t.row, "ERROR", issues(parsed.error));
    const p = parsed.data;

    // the same person twice in one file, or the same legacy number
    const person = `p:${normalizeName(p.firstName, p.lastName)}|${p.mobile ?? ""}|${p.dateOfBirth ? p.dateOfBirth.toISOString().slice(0, 10) : `age${p.estimatedAgeYears ?? ""}`}`;
    const again = this.repeat(s, person, t.row) ?? (legacyId ? this.repeat(s, `l:${legacyId}`, t.row) : undefined);
    if (again !== undefined) return ok(t.row, "SKIPPED", `Same person as row ${again} in this file.`);
    if (legacyId) {
      const existing = await this.prisma.patientIdentifier.findFirst({ where: { tenantId: ctx.tenantId, type: "LEGACY", value: legacyId }, select: { id: true } });
      if (existing) return ok(t.row, "SKIPPED", "This legacy ID is already imported.");
    }

    const candidates = await this.patients.findDuplicates(this.prisma, ctx, { firstName: p.firstName, ...(p.lastName ? { lastName: p.lastName } : {}), gender: p.gender, ...(p.dateOfBirth ? { dateOfBirth: p.dateOfBirth } : {}), ...(p.estimatedAgeYears !== undefined ? { estimatedAgeYears: p.estimatedAgeYears } : {}), ...(p.mobile ? { mobile: p.mobile } : {}) });
    const mrns = (cs: typeof candidates) => cs.map((x) => x.patient.mrn ?? "?").join(", ");
    const sharedOnly = candidates.length > 0 && candidates.every((x) => x.severity === "LOW");
    if (candidates.length > 0 && !(sharedOnly && o.sharedMobile === "import")) {
      return ok(t.row, "SKIPPED", `Possible duplicate of MRN ${mrns(candidates)} (${candidates[0]!.severity.toLowerCase()} match). Not imported, not merged: check it by hand.`);
    }
    const note = sharedOnly ? `Shares a mobile number with MRN ${mrns(candidates)}; imported as a different person.` : null;
    if (o.dryRun) return ok(t.row, "WOULD_CREATE", note);

    const withOverride = sharedOnly;
    const useCtx: RequestContext = withOverride ? { ...ctx, permissions: new Set([...ctx.permissions, "DUPLICATE_OVERRIDE" as const]) } : ctx;
    const input = withOverride ? { ...p, duplicateOverride: { confirmedDistinct: true as const, reason: "Bulk import: shares a mobile number only" } } : p;
    try {
      const { patient, replayed } = await this.patients.create(useCtx, input, `${o.fileKey}-${t.row}`, { registration: "NONE", ...(legacyId ? { legacyId } : {}) });
      if (replayed) return ok(t.row, "SKIPPED", "Already imported by an earlier run of this file.", patient.mrn);
      return ok(t.row, "CREATED", note, patient.mrn);
    } catch (e) {
      if (e instanceof DomainError && e.code === "DUPLICATE_PATIENT_SUSPECTED") return ok(t.row, "SKIPPED", "Possible duplicate found while saving. Not imported, not merged: check it by hand.");
      throw e;
    }
  }

  // ───── medicines ─────

  private async medicineRow(ctx: RequestContext, t: TableRow, o: Opts, s: State): Promise<RowResult> {
    const c = t.cells;
    const body: Record<string, unknown> = {};
    for (const k of ["brandName", "genericName", "strength", "manufacturer", "hsnCode", "gstPercent"] as const) if (c[k] !== undefined) body[k] = c[k];
    if (c["dosageForm"]) body["dosageForm"] = snake(c["dosageForm"]);
    if (c["reorderLevel"] !== undefined) { if (!/^\d{1,7}$/.test(c["reorderLevel"])) return ok(t.row, "ERROR", "reorderLevel: Enter a whole number"); body["reorderLevel"] = Number(c["reorderLevel"]); }
    const parsed = createMedicineSchema.safeParse(body);
    if (!parsed.success) return ok(t.row, "ERROR", issues(parsed.error));
    const m = parsed.data;
    const key = identityKey(m.brandName, m.genericName, m.strength, m.dosageForm);
    const again = this.repeat(s, `m:${key}`, t.row);
    if (again !== undefined) return ok(t.row, "SKIPPED", `Same medicine as row ${again} in this file.`);
    if (await this.prisma.medicine.findFirst({ where: { tenantId: ctx.tenantId, identityKey: key }, select: { id: true } })) return ok(t.row, "SKIPPED", "Already in the medicine list.");
    if (o.dryRun) return ok(t.row, "WOULD_CREATE");
    await this.medicines.create(ctx, m);
    return ok(t.row, "CREATED");
  }

  // ───── services ─────

  private async serviceRow(ctx: RequestContext, t: TableRow, o: Opts, s: State): Promise<RowResult> {
    const c = t.cells;
    const body: Record<string, unknown> = {};
    for (const k of ["code", "name", "price", "taxPercent", "sacCode"] as const) if (c[k] !== undefined) body[k] = c[k];
    if (c["category"]) body["category"] = snake(c["category"]);
    const parsed = createServiceSchema.safeParse(body);
    if (!parsed.success) return ok(t.row, "ERROR", issues(parsed.error));
    const sv = parsed.data;
    const again = this.repeat(s, `s:${sv.code}`, t.row);
    if (again !== undefined) return ok(t.row, "SKIPPED", `Same code as row ${again} in this file.`);
    if (await this.prisma.service.findFirst({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, code: sv.code }, select: { id: true } })) return ok(t.row, "SKIPPED", "This code is already in the price list; its price was not changed.");
    if (o.dryRun) return ok(t.row, "WOULD_CREATE");
    await this.catalog.create(ctx, sv);
    return ok(t.row, "CREATED");
  }

  // ───── opening stock ─────

  private async stockRow(ctx: RequestContext, t: TableRow, o: Opts, s: State): Promise<RowResult> {
    const c = t.cells;
    const brand = c["brandName"] as string;
    const form = c["dosageForm"] ? snake(c["dosageForm"]) : undefined;
    if (form && !(FORMS as readonly string[]).includes(form)) return ok(t.row, "ERROR", `dosageForm: Use one of ${FORMS.join(", ")}`);
    if (c["quantity"] !== undefined && !/^\d{1,7}$/.test(c["quantity"])) return ok(t.row, "ERROR", "quantity: Enter a whole number");
    const found = await this.prisma.medicine.findMany({
      where: {
        tenantId: ctx.tenantId, status: "ACTIVE", brandName: { equals: brand, mode: "insensitive" },
        ...(c["strength"] ? { strength: { equals: c["strength"], mode: "insensitive" as const } } : {}),
        ...(form ? { dosageForm: form as (typeof FORMS)[number] } : {}),
      },
      select: { id: true }, take: 2,
    });
    if (found.length === 0) return ok(t.row, "ERROR", `No active medicine "${brand}"${c["strength"] ? ` ${c["strength"]}` : ""} in the medicine list. Import the medicine list first.`);
    if (found.length > 1) return ok(t.row, "ERROR", `More than one medicine matches "${brand}". Add the strength or the dosage form.`);
    const medicineId = (found[0] as { id: string }).id;
    const parsed = openingBatchSchema.safeParse({
      medicineId, batchNo: c["batchNo"], expiryDate: c["expiryDate"] ? isoDay(c["expiryDate"]) : undefined,
      mrp: c["mrp"], purchasePrice: c["purchasePrice"], sellingPrice: c["sellingPrice"], quantity: c["quantity"] === undefined ? undefined : Number(c["quantity"]),
    });
    if (!parsed.success) return ok(t.row, "ERROR", issues(parsed.error));
    const b = parsed.data;
    if (b.expiryDate.toISOString().slice(0, 10) < s.todayLocal) return ok(t.row, "ERROR", "expiryDate: This batch has already expired");
    const again = this.repeat(s, `b:${medicineId}|${b.batchNo}`, t.row);
    if (again !== undefined) return ok(t.row, "SKIPPED", `Same batch as row ${again} in this file.`);
    // The stock code ADDS to a batch that exists; skipping here is what makes re-uploading a file safe.
    if (await this.prisma.medicineBatch.findFirst({ where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, medicineId, batchNo: b.batchNo }, select: { id: true } })) return ok(t.row, "SKIPPED", "This batch is already recorded; the quantity was not added again.");
    if (o.dryRun) return ok(t.row, "WOULD_CREATE", `${b.quantity} units`);
    const { replayed } = await this.inventory.createOpeningBatch(ctx, b, `${o.fileKey}-${t.row}`);
    return replayed ? ok(t.row, "SKIPPED", "Already imported by an earlier run of this file.") : ok(t.row, "CREATED", `${b.quantity} units`);
  }
}
