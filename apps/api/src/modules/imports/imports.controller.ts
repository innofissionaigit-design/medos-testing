import { Controller, Get, HttpCode, Param, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { Ctx, parse, RateLimit, RequirePermissions } from "../../common/http";
import type { RequestContext } from "../../common/request-context";
import { importKindSchema, importQuerySchema, ImportsService } from "./imports.service";

/** Bulk import from CSV. The file is the raw request body (text/csv); a call previews unless `dryRun=false` is given. */
@Controller()
export class ImportsController {
  constructor(private readonly imports: ImportsService) {}

  @RequirePermissions("DATA_IMPORT")
  @Get("imports/:kind")
  describe(@Param("kind") kind: string) {
    return { data: this.imports.describe(parse(importKindSchema, kind)) };
  }

  @RequirePermissions("DATA_IMPORT")
  @RateLimit({ limit: 20, windowMs: 60_000, by: "session" })
  @Post("imports/:kind")
  @HttpCode(200)
  async run(@Ctx() ctx: RequestContext, @Param("kind") kind: string, @Query() query: unknown, @Req() req: Request) {
    const q = parse(importQuerySchema, query);
    return { data: await this.imports.run(ctx, parse(importKindSchema, kind), req.body, q) };
  }
}
