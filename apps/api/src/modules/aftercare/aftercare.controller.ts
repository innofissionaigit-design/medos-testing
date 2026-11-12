import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query, Req } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import type { Request } from "express";
import { Ctx, id, parse, Public, RateLimit, RequireAnyPermission } from "../../common/http";
import type { RequestContext } from "../../common/request-context";
import { AftercareService, aftercareListSchema, bookReviewSchema, closeTaskSchema, contactSchema, summarySchema, updateTaskSchema } from "./aftercare.service";
import {
  assignComplaintSchema, closeComplaintSchema, escalateComplaintSchema, complaintListSchema, complaintNoteSchema, complaintSchema, feedbackListSchema, feedbackSchema, FeedbackService, reopenComplaintSchema, resolveComplaintSchema,
} from "./feedback.service";
import { AftercareScriptsService, SCRIPT_KINDS, scriptBodySchema, scriptQuerySchema, type ScriptKind } from "./aftercare-scripts.service";
import { FeedbackLinkService, feedbackLinkSchema, publicFeedbackSchema } from "./feedback-link.service";

const scriptKind = (k: string): ScriptKind => { if (!(SCRIPT_KINDS as readonly string[]).includes(k)) throw new DomainError("NOT_FOUND", "Resource not found", 404); return k as ScriptKind; };

/** The post-discharge journey: review calls and booking, feedback, and complaints (docs/aftercare.md). */
@Controller()
export class AftercareController {
  constructor(private readonly tasks: AftercareService, private readonly feedback: FeedbackService, private readonly links: FeedbackLinkService, private readonly scripts: AftercareScriptsService) {}

  // ───── review calls ─────

  @RequireAnyPermission("AFTERCARE_MANAGE")
  @Get("aftercare/tasks")
  async list(@Ctx() ctx: RequestContext, @Query() q: unknown) { return { data: await this.tasks.list(ctx, parse(aftercareListSchema, q)) }; }

  @RequireAnyPermission("AFTERCARE_MANAGE")
  @Get("aftercare/summary")
  async summary(@Ctx() ctx: RequestContext, @Query() q: unknown) { return { data: await this.tasks.summary(ctx, parse(summarySchema, q)) }; }

  @RequireAnyPermission("AFTERCARE_MANAGE")
  @Post("aftercare/queue/next")
  @HttpCode(200)
  async next(@Ctx() ctx: RequestContext) { return { data: await this.tasks.next(ctx) }; }

  @RequireAnyPermission("AFTERCARE_MANAGE")
  @Post("aftercare/tasks/:id/release")
  @HttpCode(200)
  async release(@Ctx() ctx: RequestContext, @Param("id") taskId: string) { return { data: await this.tasks.release(ctx, id(taskId)) }; }

  @RequireAnyPermission("AFTERCARE_MANAGE")
  @Get("aftercare/targets")
  async targets(@Ctx() ctx: RequestContext) { return { data: await this.scripts.targets(ctx) }; }

  @RequireAnyPermission("AFTERCARE_MANAGE", "AFTERCARE_CONFIGURE")
  @Get("aftercare/scripts")
  async scriptList(@Ctx() ctx: RequestContext) { return { data: await this.scripts.list(ctx) }; }

  @RequireAnyPermission("AFTERCARE_CONFIGURE")
  @Put("aftercare/scripts/:kind")
  async scriptSave(@Ctx() ctx: RequestContext, @Param("kind") kind: string, @Body() body: unknown) { return { data: await this.scripts.save(ctx, scriptKind(kind), parse(scriptBodySchema, body)) }; }

  @RequireAnyPermission("AFTERCARE_CONFIGURE")
  @Post("aftercare/scripts/:kind/reset")
  @HttpCode(200)
  async scriptReset(@Ctx() ctx: RequestContext, @Param("kind") kind: string) { return { data: await this.scripts.reset(ctx, scriptKind(kind)) }; }

  @RequireAnyPermission("AFTERCARE_MANAGE")
  @Get("aftercare/tasks/:id/script")
  async script(@Ctx() ctx: RequestContext, @Param("id") taskId: string, @Query() q: unknown) { return { data: await this.scripts.forTask(ctx, id(taskId), parse(scriptQuerySchema, q)) }; }

  @RequireAnyPermission("AFTERCARE_MANAGE")
  @Get("aftercare/tasks/:id")
  async one(@Ctx() ctx: RequestContext, @Param("id") taskId: string) { return { data: await this.tasks.get(ctx, id(taskId)) }; }

  @RequireAnyPermission("AFTERCARE_MANAGE")
  @Post("aftercare/tasks/:id/contacts")
  @HttpCode(200)
  async contact(@Ctx() ctx: RequestContext, @Param("id") taskId: string, @Body() body: unknown) { return { data: await this.tasks.logContact(ctx, id(taskId), parse(contactSchema, body)) }; }

  @RequireAnyPermission("AFTERCARE_MANAGE")
  @Post("aftercare/tasks/:id/book")
  @HttpCode(200)
  async book(@Ctx() ctx: RequestContext, @Param("id") taskId: string, @Body() body: unknown) { return { data: await this.tasks.book(ctx, id(taskId), parse(bookReviewSchema, body)) }; }

  @RequireAnyPermission("AFTERCARE_MANAGE")
  @Patch("aftercare/tasks/:id")
  async update(@Ctx() ctx: RequestContext, @Param("id") taskId: string, @Body() body: unknown) { return { data: await this.tasks.update(ctx, id(taskId), parse(updateTaskSchema, body)) }; }

  @RequireAnyPermission("AFTERCARE_MANAGE")
  @Post("aftercare/tasks/:id/close")
  @HttpCode(200)
  async close(@Ctx() ctx: RequestContext, @Param("id") taskId: string, @Body() body: unknown) { return { data: await this.tasks.close(ctx, id(taskId), parse(closeTaskSchema, body)) }; }

  @RequireAnyPermission("AFTERCARE_MANAGE")
  @Post("aftercare/tasks/:id/feedback-link")
  async feedbackLink(@Ctx() ctx: RequestContext, @Param("id") taskId: string, @Body() body: unknown) { return { data: await this.links.issueForStaff(ctx, id(taskId), parse(feedbackLinkSchema, body ?? {})) }; }

  // ───── feedback ─────

  @RequireAnyPermission("FEEDBACK_RECORD", "AFTERCARE_MANAGE", "COMPLAINT_MANAGE")
  @Post("aftercare/feedback")
  async record(@Ctx() ctx: RequestContext, @Body() body: unknown) { return { data: await this.feedback.record(ctx, parse(feedbackSchema, body)) }; }

  @RequireAnyPermission("AFTERCARE_MANAGE", "COMPLAINT_READ")
  @Get("aftercare/feedback")
  async feedbackList(@Ctx() ctx: RequestContext, @Query() q: unknown) { return { data: await this.feedback.listFeedback(ctx, parse(feedbackListSchema, q)) }; }

  // ───── complaints ─────

  @RequireAnyPermission("FEEDBACK_RECORD", "COMPLAINT_MANAGE", "AFTERCARE_MANAGE")
  @Post("complaints")
  async raise(@Ctx() ctx: RequestContext, @Body() body: unknown) { return { data: await this.feedback.create(ctx, parse(complaintSchema, body)) }; }

  @RequireAnyPermission("COMPLAINT_READ", "COMPLAINT_MANAGE")
  @Get("complaints")
  async complaints(@Ctx() ctx: RequestContext, @Query() q: unknown) { return { data: await this.feedback.list(ctx, parse(complaintListSchema, q)) }; }

  @RequireAnyPermission("COMPLAINT_READ", "COMPLAINT_MANAGE")
  @Get("complaints/:id")
  async complaint(@Ctx() ctx: RequestContext, @Param("id") cid: string) { return { data: await this.feedback.get(ctx, id(cid)) }; }

  @RequireAnyPermission("COMPLAINT_MANAGE")
  @Post("complaints/:id/assign")
  @HttpCode(200)
  async assign(@Ctx() ctx: RequestContext, @Param("id") cid: string, @Body() body: unknown) { return { data: await this.feedback.assign(ctx, id(cid), parse(assignComplaintSchema, body)) }; }

  @RequireAnyPermission("COMPLAINT_MANAGE")
  @Post("complaints/:id/notes")
  @HttpCode(200)
  async note(@Ctx() ctx: RequestContext, @Param("id") cid: string, @Body() body: unknown) { return { data: await this.feedback.addNote(ctx, id(cid), parse(complaintNoteSchema, body)) }; }

  @RequireAnyPermission("COMPLAINT_MANAGE")
  @Post("complaints/:id/start")
  @HttpCode(200)
  async start(@Ctx() ctx: RequestContext, @Param("id") cid: string) { return { data: await this.feedback.start(ctx, id(cid)) }; }

  @RequireAnyPermission("COMPLAINT_MANAGE")
  @Post("complaints/:id/resolve")
  @HttpCode(200)
  async resolve(@Ctx() ctx: RequestContext, @Param("id") cid: string, @Body() body: unknown) { return { data: await this.feedback.resolve(ctx, id(cid), parse(resolveComplaintSchema, body)) }; }

  @RequireAnyPermission("COMPLAINT_MANAGE")
  @Post("complaints/:id/close")
  @HttpCode(200)
  async closeComplaint(@Ctx() ctx: RequestContext, @Param("id") cid: string, @Body() body: unknown) { return { data: await this.feedback.close(ctx, id(cid), parse(closeComplaintSchema, body ?? {})) }; }

  @RequireAnyPermission("COMPLAINT_MANAGE")
  @Post("complaints/:id/escalate")
  @HttpCode(200)
  async escalate(@Ctx() ctx: RequestContext, @Param("id") cid: string, @Body() body: unknown) { return { data: await this.feedback.escalate(ctx, id(cid), parse(escalateComplaintSchema, body)) }; }

  @RequireAnyPermission("COMPLAINT_MANAGE")
  @Post("complaints/:id/reopen")
  @HttpCode(200)
  async reopen(@Ctx() ctx: RequestContext, @Param("id") cid: string, @Body() body: unknown) { return { data: await this.feedback.reopen(ctx, id(cid), parse(reopenComplaintSchema, body)) }; }
}

/** The patient's side of the feedback form: opens with the secret link alone, no sign-in. Rate limited by address; a wrong, expired or used link all look the same. */
@Controller("public/feedback")
export class PublicFeedbackController {
  constructor(private readonly links: FeedbackLinkService) {}

  @Public()
  @RateLimit({ limit: 30, windowMs: 60_000, by: "ip" })
  @Get(":token")
  async info(@Param("token") token: string) { return { data: await this.links.info(token) }; }

  @Public()
  @RateLimit({ limit: 10, windowMs: 60_000, by: "ip" })
  @Post(":token")
  async submit(@Param("token") token: string, @Body() body: unknown, @Req() req: Request & { requestId?: string }) {
    return { data: await this.links.submit(token, parse(publicFeedbackSchema, body), req.requestId ?? "public") };
  }
}
