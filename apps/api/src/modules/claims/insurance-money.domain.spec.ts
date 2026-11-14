import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Decimal } from "@medos/shared";
import { addLedgers, ageBucket, estimate, ledgerOf, packageOpenness, packageScope, planPayment, splitBill, topupClaim, type PackageTerms } from "./insurance-money.domain";

const d = (v: string | number) => new Decimal(v);
const f = (v: Decimal | null) => v?.toFixed(2);
const pkg = (over: Partial<PackageTerms> = {}): PackageTerms => ({ includesImplants: true, includesConsumables: true, exclusions: [], inclusions: [], ...over });

describe("claim ledger", () => {
  const base = { status: "APPROVED", claimed: "100000.00", approved: "80000.00", cash: "50000.00", tds: "5000.00", explainedCuts: ["15000.00"], writtenOff: [] as string[] };
  it("claimed, approved, received, cut, written off and still owed", () => {
    const l = ledgerOf(base);
    assert.equal(f(l.claimed), "100000.00");
    assert.equal(f(l.approved), "80000.00");
    assert.equal(f(l.received), "55000.00");
    assert.equal(f(l.cut), "20000.00");
    assert.equal(f(l.cutExplained), "15000.00");
    assert.equal(f(l.cutUnexplained), "5000.00");
    assert.equal(f(l.owed), "25000.00");
  });
  it("a write-off reduces what is owed; it never goes below zero", () => {
    assert.equal(f(ledgerOf({ ...base, writtenOff: ["20000.00"] }).owed), "5000.00");
    assert.equal(f(ledgerOf({ ...base, writtenOff: ["25000.00"] }).owed), "0.00");
  });
  it("nothing is owed, and the claim is only awaited, before the insurer decides", () => {
    const l = ledgerOf({ ...base, status: "SUBMITTED", approved: null, cash: "0", tds: "0", explainedCuts: [] });
    assert.equal(f(l.owed), "0.00");
    assert.equal(f(l.awaitingDecision), "100000.00");
    assert.equal(f(l.cut), "0.00");
  });
  it("an overpayment's refund is due until it is refunded", () => {
    const l = ledgerOf({ ...base, overpaid: ["3000.00"], refunded: ["1000.00"] });
    assert.equal(f(l.refundDue), "2000.00");
  });
  it("adds up an insurer's claims", () => {
    const t = addLedgers([ledgerOf(base), ledgerOf({ ...base, claimed: "10000.00", approved: "10000.00", cash: "0", tds: "0", explainedCuts: [] })]);
    assert.equal(f(t.owed), "35000.00");
    assert.equal(f(t.claimed), "110000.00");
  });
});

describe("one insurer payment matched to claims", () => {
  const line = (claimId: string, amount: string, owed: string, approved: string, received: string, over: Partial<{ tds: string; final: boolean }> = {}) => ({ claimId, amount: d(amount), tds: d(over.tds ?? "0"), final: over.final ?? false, owed: d(owed), approved: d(approved), received: d(received) });
  it("matches each line to its claim", () => {
    const p = planPayment(d("1500"), [line("a", "1000", "1000", "1000", "0"), line("b", "500", "800", "800", "0")]);
    assert.equal(p.applied.length, 2);
    assert.equal(f(p.overpayment), "0.00");
    assert.equal(p.shortfalls.length, 0);
  });
  it("cash over a claim's balance and cash matched to no claim are an overpayment", () => {
    const p = planPayment(d("2000"), [line("a", "1000", "700", "1000", "300")]);
    assert.equal(f(p.applied[0]!.amount), "700.00");
    assert.equal(f(p.overpayment), "1300.00", "300 over the claim, 1000 not matched");
  });
  it("a final payment short of the approved amount raises a shortfall", () => {
    const p = planPayment(d("600"), [line("a", "600", "1000", "1000", "0", { final: true })]);
    assert.equal(f(p.shortfalls[0]!.amount), "400.00");
    assert.equal(planPayment(d("600"), [line("a", "600", "1000", "1000", "0")]).shortfalls.length, 0, "not final: the insurer may still pay the rest");
  });
  it("tax deducted at source counts towards the claim, cash first", () => {
    const p = planPayment(d("900"), [line("a", "900", "1000", "1000", "0", { tds: "100", final: true })]);
    assert.equal(f(p.applied[0]!.tds), "100.00");
    assert.equal(p.shortfalls.length, 0);
  });
});

describe("top-up and the three-way split", () => {
  const rule = { copayPercent: null, deductible: d(0), deductibleUsed: d(0), sumInsured: null, tier: "TOPUP" as const };
  it("the top-up covers what the main insurer leaves, within its own sum insured", () => {
    assert.equal(f(topupClaim(d("20000"), rule).claim), "20000.00");
    assert.equal(f(topupClaim(d("20000"), { ...rule, sumInsured: d("15000") }).claim), "15000.00");
    assert.equal(f(topupClaim(d("20000"), { ...rule, copayPercent: d("10") }).claim), "18000.00");
    assert.equal(f(topupClaim(d("-5"), rule).claim), "0.00");
  });
  it("the three shares always add up to the bill", () => {
    const s = splitBill(d("100000"), d("60000"), d("30000"));
    assert.equal(f(s.patient), "10000.00");
    assert.equal(f(s.primary.plus(s.topup).plus(s.patient)), "100000.00");
    const over = splitBill(d("1000"), d("800"), d("800"));
    assert.equal(f(over.topup), "200.00", "the top-up cannot pay more than is left");
    assert.equal(f(over.patient), "0.00");
  });
});

describe("package: inside or extra", () => {
  it("implants and consumables are inside by default", () => {
    assert.equal(packageScope({ kind: "IMPLANT", description: "Knee implant" }, pkg()).scope, "INSIDE_PACKAGE");
    assert.equal(packageScope({ kind: "CONSUMABLE", description: "Surgical kit" }, pkg()).scope, "INSIDE_PACKAGE");
  });
  it("a package that leaves them out makes them extra", () => {
    assert.equal(packageScope({ kind: "IMPLANT", description: "Knee implant" }, pkg({ includesImplants: false })).scope, "EXTRA");
    assert.equal(packageScope({ kind: "CONSUMABLE", description: "Kit" }, pkg({ includesConsumables: false })).scope, "EXTRA");
    assert.equal(packageScope({ kind: "PROCEDURE", description: "Knee replacement" }, pkg({ includesImplants: false })).scope, "INSIDE_PACKAGE");
  });
  it("a listed exclusion is extra", () => {
    assert.equal(packageScope({ kind: "SERVICE", description: "Private nursing for 2 days" }, pkg({ exclusions: ["private nursing"] })).scope, "EXTRA");
  });
  it("leaving implants or consumables out must be said openly", () => {
    assert.ok(packageOpenness({ includesImplants: false, includesConsumables: true }));
    assert.ok(packageOpenness({ includesImplants: false, includesConsumables: true, exclusionNote: "short" }));
    assert.equal(packageOpenness({ includesImplants: false, includesConsumables: true, exclusionNote: "Implant billed at actuals" }), null);
    assert.equal(packageOpenness({ includesImplants: true, includesConsumables: true }), null);
  });
});

describe("the family's estimate", () => {
  const primary = { tier: "PRIMARY" as const, copayPercent: d("10"), deductible: d(0), deductibleUsed: d(0), sumInsured: d("500000"), roomRentLimit: d("3000") };
  const topup = { tier: "TOPUP" as const, copayPercent: null, deductible: d(0), deductibleUsed: d(0), sumInsured: d("200000"), roomRentLimit: null };
  const lines = [{ description: "Surgery", kind: "PROCEDURE" as const, amount: d("100000") }, { description: "Medicines", kind: "MEDICINE" as const, amount: d("20000") }];

  it("shows what each insurer pays and what the family pays, adding up to the total", () => {
    const e = estimate({ lines, days: 3, roomRatePerDay: d("5000"), primary, topup, packagePrice: null, pkg: null });
    assert.equal(f(e.total), "135000.00");
    assert.equal(f(e.roomRentExcess), "6000.00", "(5000-3000) x 3 days is the patient's");
    assert.equal(f(e.split.primary.plus(e.split.topup).plus(e.split.patient)), "135000.00");
    assert.ok(e.split.topup.gt(0), "the top-up covers what the main insurer's co-pay leaves");
    assert.ok(e.split.patient.gte(e.roomRentExcess), "the family at least pays the room excess");
  });
  it("without cover the whole bill is the family's", () => {
    const e = estimate({ lines, days: 0, roomRatePerDay: d(0), primary: null, topup: null, packagePrice: null, pkg: null });
    assert.equal(f(e.split.patient), "120000.00");
  });
  it("items nobody covers stay with the family", () => {
    const e = estimate({ lines: [...lines, { description: "Deluxe suite upgrade", kind: "OTHER", amount: d("10000"), notCovered: true }], days: 0, roomRatePerDay: d(0), primary: { ...primary, copayPercent: null }, topup: null, packagePrice: null, pkg: null });
    assert.equal(f(e.notCovered), "10000.00");
    assert.equal(f(e.split.patient), "10000.00");
  });
  it("with a package, the insurer pays the package price and the extras are on top", () => {
    const withExtra = [{ description: "Knee implant", kind: "IMPLANT" as const, amount: d("40000") }, { description: "Knee replacement surgery", kind: "PROCEDURE" as const, amount: d("90000") }];
    const e = estimate({ lines: withExtra, days: 0, roomRatePerDay: d(0), primary: { ...primary, copayPercent: null }, topup: null, packagePrice: d("100000"), pkg: pkg({ includesImplants: false }) });
    assert.equal(f(e.packageExtras), "40000.00");
    assert.equal(f(e.total), "140000.00", "package price plus the implant");
    assert.equal(f(e.split.primary), "100000.00");
    assert.equal(f(e.split.patient), "40000.00");
    assert.equal(e.lines.find((l) => l.description === "Knee implant")?.scope, "EXTRA");
  });
});

describe("ageing", () => {
  it("buckets a claim by its age in days", () => {
    assert.deepEqual([0, 30, 31, 60, 61, 90, 91, 400].map(ageBucket), ["0-30", "0-30", "31-60", "31-60", "61-90", "61-90", "90+", "90+"]);
  });
});
