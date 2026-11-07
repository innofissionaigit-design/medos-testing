import { Body, Controller, Get, HttpCode, Param, Post, Put } from "@nestjs/common";
import { Ctx, id, parse, RequirePermissions } from "../../common/http";
import type { RequestContext } from "../../common/request-context";
import { amendItemSchema, PrescriptionsService, saveDraftSchema, signPrescriptionSchema, stopItemSchema } from "./prescriptions.service";

@Controller()
export class PrescriptionsController {
  constructor(private readonly prescriptions: PrescriptionsService) {}

  @RequirePermissions("PRESCRIPTION_CREATE")
  @Put("encounters/:id/prescription")
  async saveDraft(@Ctx() ctx: RequestContext, @Param("id") encounterId: string, @Body() body: unknown) {
    return { data: await this.prescriptions.saveDraft(ctx, id(encounterId), parse(saveDraftSchema, body)) };
  }

  @RequirePermissions("PRESCRIPTION_READ")
  @Get("encounters/:id/prescription")
  async list(@Ctx() ctx: RequestContext, @Param("id") encounterId: string) {
    return { data: await this.prescriptions.listForEncounter(ctx, id(encounterId)) };
  }

  @RequirePermissions("PRESCRIPTION_SIGN")
  @Post("encounters/:id/prescription/sign")
  @HttpCode(200)
  async sign(@Ctx() ctx: RequestContext, @Param("id") encounterId: string, @Body() body: unknown) {
    return { data: await this.prescriptions.signStandalone(ctx, id(encounterId), parse(signPrescriptionSchema, body ?? {}).acknowledgeAllergyWarnings === true) };
  }

  @RequirePermissions("PRESCRIPTION_SIGN")
  @Post("medication-order-items/:id/amend")
  @HttpCode(200)
  async amend(@Ctx() ctx: RequestContext, @Param("id") itemId: string, @Body() body: unknown) {
    return { data: await this.prescriptions.amendItem(ctx, id(itemId), parse(amendItemSchema, body)) };
  }

  @RequirePermissions("PRESCRIPTION_CREATE")
  @Post("medication-order-items/:id/stop")
  @HttpCode(200)
  async stop(@Ctx() ctx: RequestContext, @Param("id") itemId: string, @Body() body: unknown) {
    return { data: await this.prescriptions.stopItem(ctx, id(itemId), parse(stopItemSchema, body).reason) };
  }
}
