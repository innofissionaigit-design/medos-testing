import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from "@nestjs/common";
import { Ctx, id, parse, RequirePermissions } from "../../common/http";
import type { RequestContext } from "../../common/request-context";
import { callNextSchema, cancelQueueSchema, doctorViewSchema, priorityQueueSchema, queueListSchema, QueueService, type QueueAction } from "./queue.service";

@Controller("queue")
export class QueueController {
  constructor(private readonly queue: QueueService) {}

  @RequirePermissions("QUEUE_READ")
  @Get()
  async list(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return { data: await this.queue.list(ctx, parse(queueListSchema, query)) };
  }

  @RequirePermissions("QUEUE_READ")
  @Get("doctor")
  async doctor(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    return { data: await this.queue.doctorView(ctx, parse(doctorViewSchema, query).practitionerId) };
  }

  @RequirePermissions("QUEUE_READ")
  @Post("call-next")
  @HttpCode(200)
  async callNext(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return { data: await this.queue.callNext(ctx, parse(callNextSchema, body ?? {}).practitionerId) };
  }

  @RequirePermissions("QUEUE_READ")
  @Post(":id/call")
  @HttpCode(200)
  async call(@Ctx() ctx: RequestContext, @Param("id") entryId: string) {
    return { data: await this.queue.act(ctx, id(entryId), "call" satisfies QueueAction) };
  }

  @RequirePermissions("QUEUE_READ")
  @Post(":id/recall")
  @HttpCode(200)
  async recall(@Ctx() ctx: RequestContext, @Param("id") entryId: string) {
    return { data: await this.queue.act(ctx, id(entryId), "recall") };
  }

  @RequirePermissions("QUEUE_READ")
  @Post(":id/start")
  @HttpCode(200)
  async start(@Ctx() ctx: RequestContext, @Param("id") entryId: string) {
    return { data: await this.queue.act(ctx, id(entryId), "start") };
  }

  @RequirePermissions("QUEUE_READ")
  @Post(":id/complete")
  @HttpCode(200)
  async complete(@Ctx() ctx: RequestContext, @Param("id") entryId: string) {
    return { data: await this.queue.act(ctx, id(entryId), "complete") };
  }

  @RequirePermissions("QUEUE_MANAGE")
  @Post(":id/skip")
  @HttpCode(200)
  async skip(@Ctx() ctx: RequestContext, @Param("id") entryId: string) {
    return { data: await this.queue.act(ctx, id(entryId), "skip") };
  }

  @RequirePermissions("QUEUE_MANAGE")
  @Post(":id/requeue")
  @HttpCode(200)
  async requeue(@Ctx() ctx: RequestContext, @Param("id") entryId: string) {
    return { data: await this.queue.act(ctx, id(entryId), "requeue") };
  }

  @RequirePermissions("QUEUE_MANAGE")
  @Post(":id/cancel")
  @HttpCode(200)
  async cancel(@Ctx() ctx: RequestContext, @Param("id") entryId: string, @Body() body: unknown) {
    return { data: await this.queue.act(ctx, id(entryId), "cancel", parse(cancelQueueSchema, body).reason) };
  }

  /** Reception changes any queue; a doctor only their own (checked in the service). */
  @RequirePermissions("QUEUE_PRIORITY")
  @Patch(":id/priority")
  async priority(@Ctx() ctx: RequestContext, @Param("id") entryId: string, @Body() body: unknown) {
    return { data: await this.queue.setPriority(ctx, id(entryId), parse(priorityQueueSchema, body).priority) };
  }
}
