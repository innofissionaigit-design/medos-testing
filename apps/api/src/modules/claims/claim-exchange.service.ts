import { Inject, Injectable } from "@nestjs/common";
import { Decimal, DomainError } from "@medos/shared";
import { z } from "zod";
import { actorOf, AuditService } from "../../common/audit.service";
import { PrismaService } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";
import { fmt } from "../billing/billing.domain";
import { claimBundle, claimCsv, eligibilityBundle, type FhirClaimInput } from "./claim-fhir";
import { CLAIM_TRANSPORT, ClaimTransportError, hashPayload, type ClaimDelivery, type ClaimTransport } from "./claim-transport";

export const exportQuerySchema = z.object({ format: z.enum(["fhir", "csv"]).default("fhir"), stage: z.enum(["PREAUTH", "CLAIM"]).optional(), download: z.enum(["0", "1"]).default("0") }).strict();
export const transmitSchema = z.object({ kind: z.enum(["ELIGIBILITY", "CLAIM"]), stage: z.enum(["PREAUTH", "CLAIM"]).optional() }).strict();

const nameOf = (p: { firstName: string; lastName: string | null }) => [p.firstName, p.lastName].filter(Boolean).join(" ");

/**
 * Standard-format exchange with the insurer (docs/claims.md): builds a FHIR eligibility request, pre-authorisation or claim from a claim, lets staff download it (FHIR JSON or a
 * CSV for a portal upload), and sends it through the configured channel, recording every attempt. What the insurer answers is entered by hand: verification, decision and settlement.
 */
@Injectable()
export class ClaimExchangeService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, @Inject(CLAIM_TRANSPORT) private readonly transport: ClaimTransport) {}

  private async build(ctx: RequestContext, claimId: string, stageOverride?: "PREAUTH" | "CLAIM"): Promise<FhirClaimInput> {
    const c = await this.prisma.claim.findFirst({
      where: { id: claimId, tenantId: ctx.tenantId, facilityId: ctx.facilityId },
      include: {
        patient: { select: { id: true, firstName: true, lastName: true, gender: true, dateOfBirth: true, identifiers: { where: { type: "MRN" }, select: { value: true }, take: 1 } } },
        policy: { include: { insurer: { select: { id: true, name: true } } } },
        invoice: { select: { lines: { orderBy: { lineNo: "asc" }, select: { description: true, quantity: true, unitPrice: true, lineTotal: true, discountAmount: true, hsnSac: true } } } },
        extraInvoices: { select: { invoice: { select: { lines: { orderBy: { lineNo: "asc" }, select: { description: true, quantity: true, unitPrice: true, lineTotal: true, discountAmount: true, hsnSac: true } } } } } },
      },
    });
    if (!c) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const facility = await this.prisma.facility.findFirstOrThrow({ where: { id: ctx.facilityId, tenantId: ctx.tenantId }, select: { id: true, name: true } });
    const lines = [...(c.invoice?.lines ?? []), ...c.extraInvoices.flatMap((x) => x.invoice.lines)].map((l) => ({
      description: l.description, quantity: l.quantity.toString(), unitPrice: l.unitPrice.toString(), net: l.lineTotal.toString(), hsnSac: l.hsnSac,
    }));
    const stage = stageOverride ?? (c.invoiceId ? "CLAIM" : "PREAUTH");
    return {
      claimNumber: c.claimNumber, type: c.type, stage, createdAt: new Date(), diagnosis: c.diagnosis,
      claimedAmount: c.claimedAmount ? new Decimal(c.claimedAmount.toString()).toFixed(2) : null, preauthRequested: c.preauthRequested ? new Decimal(c.preauthRequested.toString()).toFixed(2) : null,
      patient: { id: c.patient.id, name: nameOf(c.patient), gender: c.patient.gender, birthDate: c.patient.dateOfBirth ? c.patient.dateOfBirth.toISOString().slice(0, 10) : null, mrn: c.patient.identifiers[0]?.value ?? null },
      policy: {
        id: c.policy.id, policyNumber: c.policy.policyNumber, memberId: c.policy.memberId, holderName: c.policy.holderName, validFrom: c.policy.validFrom.toISOString().slice(0, 10),
        validTo: c.policy.validTo.toISOString().slice(0, 10), sumInsured: c.policy.sumInsured?.toString() ?? null,
      },
      insurer: { id: c.policy.insurer.id, name: c.policy.insurer.name }, provider: { id: facility.id, name: facility.name }, lines,
    };
  }

  async eligibilityRequest(ctx: RequestContext, claimId: string) {
    const input = await this.build(ctx, claimId);
    await this.audit.record(this.prisma, actorOf(ctx), { action: "CLAIM_EXPORTED", entityType: "Claim", entityId: claimId, metadata: { kind: "ELIGIBILITY", format: "fhir" } });
    return eligibilityBundle(input);
  }

  async export(ctx: RequestContext, claimId: string, q: z.infer<typeof exportQuerySchema>) {
    const input = await this.build(ctx, claimId, q.stage);
    await this.audit.record(this.prisma, actorOf(ctx), { action: "CLAIM_EXPORTED", entityType: "Claim", entityId: claimId, metadata: { kind: input.stage, format: q.format } });
    const base = `claim-${input.claimNumber.replace(/[^A-Za-z0-9_-]/g, "-")}`;
    return q.format === "csv"
      ? { contentType: "text/csv; charset=utf-8", filename: `${base}.csv`, body: claimCsv(input) }
      : { contentType: "application/fhir+json; charset=utf-8", filename: `${base}.json`, body: JSON.stringify(claimBundle(input), null, 2) };
  }

  /** Sends the message through the configured channel (or only records it when none is set up). A failure is recorded, never lost, and never changes the claim. */
  async transmit(ctx: RequestContext, claimId: string, input: z.infer<typeof transmitSchema>) {
    const claim = await this.prisma.claim.findFirst({ where: { id: claimId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { id: true, claimNumber: true, status: true } });
    if (!claim) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    if (claim.status === "CLOSED" || claim.status === "SETTLED") throw new DomainError("INVALID_STATE", `This claim is already ${claim.status.toLowerCase()}`, 409);
    const data = await this.build(ctx, claimId, input.stage);
    const payload = input.kind === "ELIGIBILITY" ? eligibilityBundle(data) : claimBundle(data);
    const reference = `${claim.claimNumber}:${input.kind}:${Date.now().toString(36)}`;
    let delivery: ClaimDelivery;
    try {
      delivery = await this.transport.send({ kind: input.kind, reference, payload });
    } catch (e) {
      delivery = { channel: "http", sent: false, httpStatus: null, externalRef: null, detail: e instanceof ClaimTransportError ? e.message : "The message could not be sent" };
      if (!(e instanceof ClaimTransportError)) throw e;
    }
    const status = delivery.sent ? "SENT" : delivery.channel === "log" ? "NOT_SENT" : "FAILED";
    const row = await this.prisma.$transaction(async (tx) => {
      const t = await tx.claimTransmission.create({
        data: { tenantId: ctx.tenantId, claimId, kind: input.kind, status, channel: delivery.channel, payloadHash: hashPayload(payload), httpStatus: delivery.httpStatus, externalRef: delivery.externalRef, detail: delivery.detail?.slice(0, 500) ?? null, sentById: ctx.userId },
      });
      await this.audit.record(tx, actorOf(ctx), { action: "CLAIM_TRANSMITTED", entityType: "Claim", entityId: claimId, metadata: { kind: input.kind, status, channel: delivery.channel, ...(delivery.httpStatus ? { httpStatus: delivery.httpStatus } : {}) } });
      return t;
    });
    return { id: row.id, kind: row.kind, status: row.status, channel: row.channel, httpStatus: row.httpStatus, externalRef: row.externalRef, detail: row.detail, at: row.at, totalLines: data.lines.length, claimTotal: data.claimedAmount ? fmt(data.claimedAmount) : null };
  }

  async transmissions(ctx: RequestContext, claimId: string) {
    const claim = await this.prisma.claim.findFirst({ where: { id: claimId, tenantId: ctx.tenantId, facilityId: ctx.facilityId }, select: { id: true } });
    if (!claim) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    const rows = await this.prisma.claimTransmission.findMany({ where: { tenantId: ctx.tenantId, claimId }, orderBy: [{ at: "desc" }, { id: "desc" }], take: 100 });
    const users = new Map((await this.prisma.user.findMany({ where: { tenantId: ctx.tenantId, id: { in: [...new Set(rows.map((r) => r.sentById))] } }, select: { id: true, fullName: true } })).map((u) => [u.id, u.fullName]));
    return rows.map((r) => ({ id: r.id, kind: r.kind, status: r.status, channel: r.channel, httpStatus: r.httpStatus, externalRef: r.externalRef, detail: r.detail, at: r.at, by: users.get(r.sentById) ?? null }));
  }
}
