import { Body, Controller, Get, HttpCode, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { Feature } from "../../common/feature.guard";
import { Ctx, id, parse, RequirePermissions } from "../../common/http";
import type { RequestContext } from "../../common/request-context";
import { administerSchema, dueQuerySchema, generateSchema, MarService, marListSchema, unscheduledSchema } from "./mar.service";
import { errorReasonSchema, ioSchema, ioTotalsSchema, noteSchema, NursingService, taskCancelSchema, taskCloseSchema, taskSchema, worklistSchema } from "./nursing.service";

const notesQuery = z.object({ includeErrors: z.enum(["true", "false"]).default("false").transform((v) => v === "true") }).strict();

@Feature("NURSING_ENABLED")
@Controller()
export class NursingController {
  constructor(private readonly nursing: NursingService, private readonly mar: MarService) {}

  @RequirePermissions("NURSING_READ")
  @Get("nursing/worklist")
  async worklist(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return { data: await this.nursing.worklist(ctx, parse(worklistSchema, query).wardId) };
  }

  // ───── notes ─────

  @RequirePermissions("NURSING_READ")
  @Get("admissions/:id/notes")
  async notes(@Ctx() ctx: RequestContext, @Param("id") admissionId: string, @Query() query: unknown) {
    return { data: await this.nursing.listNotes(ctx, id(admissionId), parse(notesQuery, query).includeErrors) };
  }

  @RequirePermissions("NURSING_DOCUMENT")
  @Post("admissions/:id/notes")
  async addNote(@Ctx() ctx: RequestContext, @Param("id") admissionId: string, @Body() body: unknown) {
    return { data: await this.nursing.addNote(ctx, id(admissionId), parse(noteSchema, body)) };
  }

  @RequirePermissions("NURSING_DOCUMENT")
  @Post("nursing-notes/:id/addendum")
  async addendum(@Ctx() ctx: RequestContext, @Param("id") noteId: string, @Body() body: unknown) {
    return { data: await this.nursing.addAddendum(ctx, id(noteId), parse(noteSchema, body)) };
  }

  @RequirePermissions("NURSING_DOCUMENT")
  @Post("nursing-notes/:id/enter-in-error")
  @HttpCode(200)
  async noteError(@Ctx() ctx: RequestContext, @Param("id") noteId: string, @Body() body: unknown) {
    return { data: await this.nursing.noteInError(ctx, id(noteId), parse(errorReasonSchema, body).reason) };
  }

  // ───── tasks ─────

  @RequirePermissions("NURSING_READ")
  @Get("admissions/:id/tasks")
  async tasks(@Ctx() ctx: RequestContext, @Param("id") admissionId: string) {
    return { data: await this.nursing.listTasks(ctx, id(admissionId)) };
  }

  @RequirePermissions("NURSING_DOCUMENT")
  @Post("admissions/:id/tasks")
  async createTask(@Ctx() ctx: RequestContext, @Param("id") admissionId: string, @Body() body: unknown) {
    return { data: await this.nursing.createTask(ctx, id(admissionId), parse(taskSchema, body)) };
  }

  @RequirePermissions("NURSING_DOCUMENT")
  @Post("tasks/:id/complete")
  @HttpCode(200)
  async completeTask(@Ctx() ctx: RequestContext, @Param("id") taskId: string, @Body() body: unknown) {
    return { data: await this.nursing.closeTask(ctx, id(taskId), "DONE", parse(taskCloseSchema, body ?? {}).note) };
  }

  @RequirePermissions("NURSING_DOCUMENT")
  @Post("tasks/:id/cancel")
  @HttpCode(200)
  async cancelTask(@Ctx() ctx: RequestContext, @Param("id") taskId: string, @Body() body: unknown) {
    return { data: await this.nursing.closeTask(ctx, id(taskId), "CANCELLED", parse(taskCancelSchema, body).reason) };
  }

  // ───── medication administration record ─────

  @RequirePermissions("NURSING_READ")
  @Get("admissions/:id/mar")
  async marList(@Ctx() ctx: RequestContext, @Param("id") admissionId: string, @Query() query: unknown) {
    return { data: await this.mar.list(ctx, id(admissionId), parse(marListSchema, query)) };
  }

  @RequirePermissions("NURSING_READ")
  @Get("mar/due")
  async marDue(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return { data: await this.mar.due(ctx, parse(dueQuerySchema, query)) };
  }

  @RequirePermissions("NURSING_DOCUMENT")
  @Post("admissions/:id/mar/generate")
  @HttpCode(200)
  async marGenerate(@Ctx() ctx: RequestContext, @Param("id") admissionId: string, @Body() body: unknown) {
    return { data: await this.mar.generate(ctx, id(admissionId), parse(generateSchema, body ?? {})) };
  }

  @RequirePermissions("NURSING_MEDICATION_ADMINISTER")
  @Post("mar/:id/administer")
  @HttpCode(200)
  async administer(@Ctx() ctx: RequestContext, @Param("id") marId: string, @Body() body: unknown) {
    return { data: await this.mar.administer(ctx, id(marId), parse(administerSchema, body)) };
  }

  @RequirePermissions("NURSING_MEDICATION_ADMINISTER")
  @Post("admissions/:id/mar/unscheduled")
  async unscheduled(@Ctx() ctx: RequestContext, @Param("id") admissionId: string, @Body() body: unknown) {
    return { data: await this.mar.giveUnscheduled(ctx, id(admissionId), parse(unscheduledSchema, body)) };
  }

  // ───── intake / output ─────

  @RequirePermissions("NURSING_READ")
  @Get("admissions/:id/intake-output")
  async io(@Ctx() ctx: RequestContext, @Param("id") admissionId: string) {
    return { data: await this.nursing.listIo(ctx, id(admissionId)) };
  }

  @RequirePermissions("NURSING_READ")
  @Get("admissions/:id/intake-output/totals")
  async ioTotals(@Ctx() ctx: RequestContext, @Param("id") admissionId: string, @Query() query: unknown) {
    return { data: await this.nursing.ioTotals(ctx, id(admissionId), parse(ioTotalsSchema, query).date) };
  }

  @RequirePermissions("NURSING_DOCUMENT")
  @Post("admissions/:id/intake-output")
  async recordIo(@Ctx() ctx: RequestContext, @Param("id") admissionId: string, @Body() body: unknown) {
    return { data: await this.nursing.recordIo(ctx, id(admissionId), parse(ioSchema, body)) };
  }

  @RequirePermissions("NURSING_DOCUMENT")
  @Post("intake-output/:id/enter-in-error")
  @HttpCode(200)
  async ioError(@Ctx() ctx: RequestContext, @Param("id") ioId: string, @Body() body: unknown) {
    return { data: await this.nursing.ioInError(ctx, id(ioId), parse(errorReasonSchema, body).reason) };
  }
}
