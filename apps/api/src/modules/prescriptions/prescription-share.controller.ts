import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { z } from "zod";
import { Ctx, id, parse, Public, RateLimit, RequirePermissions } from "../../common/http";
import type { RequestContext } from "../../common/request-context";
import { sendRendered } from "../print/print.controller";
import { createShareSchema, PrescriptionShareService } from "./prescription-share.service";

const openQuery = z.object({ format: z.enum(["html", "pdf"]).default("html"), download: z.enum(["0", "1"]).default("0") }).strict();

/** Staff side: create, list and revoke the links that give a patient their signed prescription (docs/prescriptions.md). */
@Controller()
export class PrescriptionShareController {
  constructor(private readonly shares: PrescriptionShareService) {}

  @RequirePermissions("PRESCRIPTION_SHARE")
  @RateLimit({ limit: 30, windowMs: 60_000, by: "session" })
  @Post("encounters/:id/prescription-shares")
  async create(@Ctx() ctx: RequestContext, @Param("id") encounterId: string, @Body() body: unknown) { return { data: await this.shares.create(ctx, id(encounterId), parse(createShareSchema, body)) }; }

  @RequirePermissions("PRESCRIPTION_SHARE")
  @Get("encounters/:id/prescription-shares")
  async list(@Ctx() ctx: RequestContext, @Param("id") encounterId: string) { return { data: await this.shares.list(ctx, id(encounterId)) }; }

  @RequirePermissions("PRESCRIPTION_SHARE")
  @Post("prescription-shares/:id/revoke")
  @HttpCode(200)
  async revoke(@Ctx() ctx: RequestContext, @Param("id") shareId: string) { return { data: await this.shares.revoke(ctx, id(shareId)) }; }
}

/** The patient's side: opens with the secret link alone, no sign-in. Rate limited by address; a wrong, expired or revoked link all look the same. */
@Controller("public/prescriptions")
export class PublicPrescriptionController {
  constructor(private readonly shares: PrescriptionShareService) {}

  @Public()
  @RateLimit({ limit: 30, windowMs: 60_000, by: "ip" })
  @Get(":token")
  async open(@Param("token") token: string, @Query() query: unknown, @Req() req: Request & { requestId?: string }, @Res() res: Response) {
    const q = parse(openQuery, query);
    sendRendered(res, await this.shares.open(token, q.format, req.requestId ?? "public"), q.download === "1");
  }
}
