import { Body, Controller, Get, HttpCode, Param, Post, Put, Query } from "@nestjs/common";
import { z } from "zod";
import { Ctx, id, parse, RequirePermissions } from "../../common/http";
import type { RequestContext } from "../../common/request-context";
import { DomainError } from "@medos/shared";
import {
  addDiagnosisSchema, amendConsultationSchema, ConsultationsService, removeDiagnosisSchema, saveConsultationSchema, signConsultationSchema,
} from "./consultations.service";

const includeRemoved = z.object({ includeRemoved: z.enum(["true", "false"]).default("false").transform((v) => v === "true") }).strict();

@Controller()
export class ConsultationsController {
  constructor(private readonly consultations: ConsultationsService) {}

  @RequirePermissions("CONSULTATION_READ")
  @Get("encounters/:id/workspace")
  async workspace(@Ctx() ctx: RequestContext, @Param("id") encounterId: string) {
    return { data: await this.consultations.workspace(ctx, id(encounterId)) };
  }

  @RequirePermissions("CONSULTATION_READ")
  @Get("encounters/:id/consultation")
  async get(@Ctx() ctx: RequestContext, @Param("id") encounterId: string) {
    return { data: await this.consultations.get(ctx, id(encounterId)) };
  }

  @RequirePermissions("CONSULTATION_CREATE")
  @Put("encounters/:id/consultation")
  async save(@Ctx() ctx: RequestContext, @Param("id") encounterId: string, @Body() body: unknown) {
    return { data: await this.consultations.saveDraft(ctx, id(encounterId), parse(saveConsultationSchema, body)) };
  }

  @RequirePermissions("CONSULTATION_SIGN")
  @Post("encounters/:id/consultation/sign")
  @HttpCode(200)
  async sign(@Ctx() ctx: RequestContext, @Param("id") encounterId: string, @Body() body: unknown) {
    return { data: await this.consultations.sign(ctx, id(encounterId), parse(signConsultationSchema, body)) };
  }

  @RequirePermissions("CONSULTATION_AMEND")
  @Post("encounters/:id/consultation/amend")
  @HttpCode(200)
  async amend(@Ctx() ctx: RequestContext, @Param("id") encounterId: string, @Body() body: unknown) {
    return { data: await this.consultations.amend(ctx, id(encounterId), parse(amendConsultationSchema, body)) };
  }

  @RequirePermissions("CONSULTATION_READ")
  @Get("encounters/:id/consultation/versions/:version")
  async version(@Ctx() ctx: RequestContext, @Param("id") encounterId: string, @Param("version") version: string) {
    const n = Number(version);
    if (!Number.isInteger(n) || n < 1) throw new DomainError("NOT_FOUND", "Resource not found", 404);
    return { data: await this.consultations.getVersion(ctx, id(encounterId), n) };
  }

  @RequirePermissions("CONSULTATION_READ")
  @Get("encounters/:id/diagnoses")
  async diagnoses(@Ctx() ctx: RequestContext, @Param("id") encounterId: string, @Query() query: unknown) {
    return { data: await this.consultations.diagnosesForEncounter(ctx, id(encounterId), parse(includeRemoved, query).includeRemoved) };
  }

  @RequirePermissions("CONSULTATION_CREATE")
  @Post("encounters/:id/diagnoses")
  async addDiagnosis(@Ctx() ctx: RequestContext, @Param("id") encounterId: string, @Body() body: unknown) {
    return { data: await this.consultations.addDiagnosis(ctx, id(encounterId), parse(addDiagnosisSchema, body)) };
  }

  @RequirePermissions("CONSULTATION_CREATE")
  @Post("diagnoses/:id/remove")
  @HttpCode(200)
  async removeDiagnosis(@Ctx() ctx: RequestContext, @Param("id") diagnosisId: string, @Body() body: unknown) {
    return { data: await this.consultations.removeDiagnosis(ctx, id(diagnosisId), parse(removeDiagnosisSchema, body).reason) };
  }

  @RequirePermissions("CONSULTATION_READ")
  @Get("patients/:id/diagnoses")
  async patientDiagnoses(@Ctx() ctx: RequestContext, @Param("id") patientId: string) {
    return { data: await this.consultations.diagnosesForPatient(ctx, id(patientId)) };
  }
}
