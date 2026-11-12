/**
 * Standard-format messages for the insurer (docs/claims.md): an HL7 FHIR R4 eligibility request and claim, built from what MedOS already holds. Plain data in, plain JSON out, no
 * database access, so the same content can be downloaded, sent through the configured channel, or checked by the insurer's own tools. No clinical notes are included: only the
 * diagnosis text on the claim and what was billed.
 */
export interface FhirClaimInput {
  claimNumber: string; type: "CASHLESS" | "REIMBURSEMENT" | string; stage: "PREAUTH" | "CLAIM"; createdAt: Date; diagnosis: string | null;
  claimedAmount: string | null; preauthRequested: string | null;
  patient: { id: string; name: string; gender: string; birthDate: string | null; mrn: string | null };
  policy: { id: string; policyNumber: string; memberId: string | null; holderName: string | null; validFrom: string; validTo: string; sumInsured: string | null };
  insurer: { id: string; name: string };
  provider: { id: string; name: string };
  lines: { description: string; quantity: string; unitPrice: string; net: string; hsnSac: string | null }[];
}

type Json = Record<string, unknown>;
const CURRENCY = "INR";
const money = (v: string | null) => (v === null ? undefined : { value: Number(v), currency: CURRENCY });
const gender = (g: string) => ({ MALE: "male", FEMALE: "female", OTHER: "other" }[g] ?? "unknown");

function resources(i: FhirClaimInput): { patient: Json; insurer: Json; provider: Json; coverage: Json } {
  return {
    patient: {
      resourceType: "Patient", id: i.patient.id, identifier: i.patient.mrn ? [{ system: "urn:medos:mrn", value: i.patient.mrn }] : [], name: [{ text: i.patient.name }], gender: gender(i.patient.gender),
      ...(i.patient.birthDate ? { birthDate: i.patient.birthDate } : {}),
    },
    insurer: { resourceType: "Organization", id: i.insurer.id, name: i.insurer.name, type: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/organization-type", code: "ins" }] }] },
    provider: { resourceType: "Organization", id: i.provider.id, name: i.provider.name, type: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/organization-type", code: "prov" }] }] },
    coverage: {
      resourceType: "Coverage", id: i.policy.id, status: "active", subscriberId: i.policy.memberId ?? i.policy.policyNumber, beneficiary: { reference: `Patient/${i.patient.id}` },
      payor: [{ reference: `Organization/${i.insurer.id}` }], identifier: [{ system: "urn:medos:policy-number", value: i.policy.policyNumber }],
      period: { start: i.policy.validFrom, end: i.policy.validTo }, ...(i.policy.holderName ? { policyHolder: { display: i.policy.holderName } } : {}),
    },
  };
}

const entry = (r: Json) => ({ fullUrl: `urn:uuid:${String(r["id"])}`, resource: r });

/** Asks the insurer whether the policy is in force and what it covers (a CoverageEligibilityRequest, in a Bundle with the resources it points to). */
export function eligibilityBundle(i: FhirClaimInput): Json {
  const r = resources(i);
  const request: Json = {
    resourceType: "CoverageEligibilityRequest", id: `eligibility-${i.claimNumber}`, status: "active", purpose: ["validation", "benefits"], patient: { reference: `Patient/${i.patient.id}` },
    created: i.createdAt.toISOString(), insurer: { reference: `Organization/${i.insurer.id}` }, provider: { reference: `Organization/${i.provider.id}` },
    insurance: [{ focal: true, coverage: { reference: `Coverage/${i.policy.id}` } }],
  };
  return { resourceType: "Bundle", type: "collection", timestamp: i.createdAt.toISOString(), entry: [entry(request), entry(r.patient), entry(r.coverage), entry(r.insurer), entry(r.provider)] };
}

/** The pre-authorisation request or the claim itself (a Claim: use "preauthorization" or "claim"), with what was billed as its items. */
export function claimBundle(i: FhirClaimInput): Json {
  const r = resources(i);
  const total = i.stage === "PREAUTH" ? i.preauthRequested : i.claimedAmount;
  const claim: Json = {
    resourceType: "Claim", id: `claim-${i.claimNumber}`, identifier: [{ system: "urn:medos:claim-number", value: i.claimNumber }], status: "active",
    type: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/claim-type", code: "institutional" }] }, use: i.stage === "PREAUTH" ? "preauthorization" : "claim",
    patient: { reference: `Patient/${i.patient.id}` }, created: i.createdAt.toISOString(), insurer: { reference: `Organization/${i.insurer.id}` }, provider: { reference: `Organization/${i.provider.id}` },
    priority: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/processpriority", code: "normal" }] },
    insurance: [{ sequence: 1, focal: true, coverage: { reference: `Coverage/${i.policy.id}` } }],
    ...(i.diagnosis ? { diagnosis: [{ sequence: 1, diagnosisCodeableConcept: { text: i.diagnosis } }] } : {}),
    item: i.lines.map((l, n) => ({
      sequence: n + 1, productOrService: { text: l.description, ...(l.hsnSac ? { coding: [{ system: "urn:medos:hsn-sac", code: l.hsnSac }] } : {}) },
      quantity: { value: Number(l.quantity) }, unitPrice: { value: Number(l.unitPrice), currency: CURRENCY }, net: { value: Number(l.net), currency: CURRENCY },
    })),
    ...(total !== null ? { total: money(total) } : {}),
  };
  return { resourceType: "Bundle", type: "collection", timestamp: i.createdAt.toISOString(), entry: [entry(claim), entry(r.patient), entry(r.coverage), entry(r.insurer), entry(r.provider)] };
}

/** The same claim as a flat table for an insurer's portal upload: one row per billed line, with the claim's details repeated. */
export function claimCsv(i: FhirClaimInput): string {
  const q = (v: string | null | undefined) => `"${(v ?? "").replace(/"/g, '""')}"`;
  const head = ["claim_number", "stage", "insurer", "policy_number", "member_id", "patient_mrn", "patient_name", "diagnosis", "line", "description", "hsn_sac", "quantity", "unit_price", "net", "claim_total"];
  const total = i.stage === "PREAUTH" ? i.preauthRequested : i.claimedAmount;
  const rows = i.lines.map((l, n) => [q(i.claimNumber), q(i.stage), q(i.insurer.name), q(i.policy.policyNumber), q(i.policy.memberId), q(i.patient.mrn), q(i.patient.name), q(i.diagnosis), String(n + 1), q(l.description), q(l.hsnSac), l.quantity, l.unitPrice, l.net, total ?? ""]);
  return [head.join(","), ...rows.map((r) => r.join(","))].join("\r\n") + "\r\n";
}
