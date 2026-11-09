import { Injectable } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import type { Db } from "../../common/prisma.service";
import type { RequestContext } from "../../common/request-context";

export interface Clinician { id: string; displayName: string }

/**
 * Clinical documentation (consultations, diagnoses, prescriptions) may only be authored by a registered,
 * active practitioner at the current facility. Holding a permission alone is not enough.
 */
@Injectable()
export class ClinicianService {
  async requireActive(db: Db, ctx: RequestContext): Promise<Clinician> {
    const p = await db.practitioner.findFirst({
      where: { tenantId: ctx.tenantId, facilityId: ctx.facilityId, userId: ctx.userId, status: "ACTIVE" },
      select: { id: true, displayName: true },
    });
    if (!p) throw new DomainError("FORBIDDEN", "Only a registered practitioner at this facility can record clinical documentation", 403);
    return p;
  }
}
