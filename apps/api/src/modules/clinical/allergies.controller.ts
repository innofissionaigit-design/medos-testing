import { Body, Controller, Get, HttpCode, Param, Post, Query } from "@nestjs/common";
import { Ctx, id, parse, RequirePermissions } from "../../common/http";
import type { RequestContext } from "../../common/request-context";
import { AllergiesService, allergyStatusSchema, createAllergySchema, listAllergiesSchema } from "./allergies.service";

@Controller()
export class AllergiesController {
  constructor(private readonly allergies: AllergiesService) {}

  /** Visible to every role that can see the patient: allergies must be prominent across the care team. */
  @RequirePermissions("PATIENT_READ")
  @Get("patients/:id/allergies")
  async list(@Ctx() ctx: RequestContext, @Param("id") patientId: string, @Query() query: unknown) {
    return { data: await this.allergies.list(ctx, id(patientId), parse(listAllergiesSchema, query).all) };
  }

  @RequirePermissions("ALLERGY_WRITE")
  @Post("patients/:id/allergies")
  async create(@Ctx() ctx: RequestContext, @Param("id") patientId: string, @Body() body: unknown) {
    return { data: await this.allergies.create(ctx, id(patientId), parse(createAllergySchema, body)) };
  }

  @RequirePermissions("ALLERGY_WRITE")
  @Post("allergies/:id/status")
  @HttpCode(200)
  async status(@Ctx() ctx: RequestContext, @Param("id") allergyId: string, @Body() body: unknown) {
    return { data: await this.allergies.changeStatus(ctx, id(allergyId), parse(allergyStatusSchema, body)) };
  }
}
