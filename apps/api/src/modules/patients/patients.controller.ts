import { Body, Controller, Get, Headers, HttpCode, Param, Patch, Post, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { Ctx, id, paginate, parse, RequirePermissions } from "../../common/http";
import { parseIdempotencyKey } from "../../common/idempotency.service";
import type { RequestContext } from "../../common/request-context";
import { MergeService, mergePatientSchema } from "./merge.service";
import { RegistrationFeeService, registrationSettlementSchema } from "./registration-fee.service";
import { createPatientSchema, duplicateProbeSchema, PatientsService, searchPatientsSchema, updatePatientSchema } from "./patients.service";

@Controller("patients")
export class PatientsController {
  constructor(private readonly patients: PatientsService, private readonly merge_: MergeService, private readonly registrationFee: RegistrationFeeService) {}

  @RequirePermissions("PATIENT_READ")
  @Get()
  async search(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    const q = parse(searchPatientsSchema, query);
    const { items, total } = await this.patients.search(ctx, q);
    return paginate(items, total, q.page, q.pageSize);
  }

  @RequirePermissions("PATIENT_CREATE")
  @Post("duplicate-check")
  @HttpCode(200)
  async duplicateCheck(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return { data: await this.patients.duplicateCheck(ctx, parse(duplicateProbeSchema, body)) };
  }

  @RequirePermissions("PATIENT_CREATE")
  @Post()
  async create(
    @Ctx() ctx: RequestContext, @Body() body: unknown,
    @Headers("idempotency-key") key: string | undefined, @Res({ passthrough: true }) res: Response,
  ) {
    const { patient, replayed } = await this.patients.create(ctx, parse(createPatientSchema, body), parseIdempotencyKey(key));
    res.status(replayed ? 200 : 201);
    if (replayed) res.setHeader("Idempotent-Replayed", "true");
    return { data: patient };
  }

  /** The registration fee in force and what the signed-in user may do about it, for the registration screen. */
  @RequirePermissions("PATIENT_CREATE")
  @Get("registration-fee/config")
  async registrationFeeConfig(@Ctx() ctx: RequestContext) { return { data: await this.registrationFee.config(ctx) }; }

  @RequirePermissions("PATIENT_READ")
  @Get(":id/registration-fee")
  async registrationFeeOf(@Ctx() ctx: RequestContext, @Param("id") patientId: string) { return { data: await this.registrationFee.view(ctx, id(patientId)) }; }

  /** Collects (or exempts) a registration fee that was left pending, for example for a patient registered by a booking bot. */
  @RequirePermissions("PATIENT_CREATE")
  @Post(":id/registration-fee")
  async settleRegistrationFee(@Ctx() ctx: RequestContext, @Param("id") patientId: string, @Body() body: unknown, @Headers("idempotency-key") key: string | undefined, @Res({ passthrough: true }) res: Response) {
    const { registration, replayed } = await this.registrationFee.settlePending(ctx, id(patientId), parse(registrationSettlementSchema, body), parseIdempotencyKey(key));
    res.status(replayed ? 200 : 201);
    if (replayed) res.setHeader("Idempotent-Replayed", "true");
    return { data: registration };
  }

  @RequirePermissions("PATIENT_READ")
  @Get(":id")
  async get(@Ctx() ctx: RequestContext, @Param("id") patientId: string) {
    return { data: await this.patients.get(ctx, id(patientId)) };
  }

  /** Links a duplicate (this id) to the real patient. Nothing moves and there is no undo (docs/patient-merge.md). */
  @RequirePermissions("PATIENT_MERGE")
  @Post(":id/merge")
  @HttpCode(200)
  async merge(@Ctx() ctx: RequestContext, @Param("id") duplicateId: string, @Body() body: unknown) {
    return { data: await this.merge_.merge(ctx, id(duplicateId), parse(mergePatientSchema, body)) };
  }

  @RequirePermissions("PATIENT_UPDATE")
  @Patch(":id")
  async update(@Ctx() ctx: RequestContext, @Param("id") patientId: string, @Body() body: unknown) {
    return { data: await this.patients.update(ctx, id(patientId), parse(updatePatientSchema, body)) };
  }
}
