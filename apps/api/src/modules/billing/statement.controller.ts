import { Controller, Get, Param } from "@nestjs/common";
import { Ctx, id, RequirePermissions } from "../../common/http";
import type { RequestContext } from "../../common/request-context";
import { StatementService } from "./statement.service";

/** A patient's account statement: debits, credits and a running balance (docs/patient-ledger.md). */
@Controller()
export class StatementController {
  constructor(private readonly statements: StatementService) {}

  @RequirePermissions("INVOICE_READ")
  @Get("patients/:id/ledger")
  async ledger(@Ctx() ctx: RequestContext, @Param("id") patientId: string) {
    return { data: await this.statements.forPatient(ctx, id(patientId)) };
  }
}
