import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { Ctx, id, parse, RequirePermissions } from "../../common/http";
import type { RequestContext } from "../../common/request-context";
import { FilesService, removeFileSchema, uploadQuerySchema } from "./files.service";

/** Patient photos and scanned documents. Bytes are sent as the raw request body (PNG, JPEG or PDF), metadata in the query string. */
@Controller()
export class FilesController {
  constructor(private readonly files: FilesService) {}

  @RequirePermissions("PATIENT_UPDATE")
  @Post("patients/:id/files")
  @HttpCode(201)
  async upload(@Ctx() ctx: RequestContext, @Param("id") patientId: string, @Query() query: unknown, @Headers("content-type") contentType: string | undefined, @Req() req: Request) {
    return { data: await this.files.upload(ctx, id(patientId), parse(uploadQuerySchema, query), contentType, req.body) };
  }

  @RequirePermissions("PATIENT_READ")
  @Get("patients/:id/files")
  async list(@Ctx() ctx: RequestContext, @Param("id") patientId: string) {
    return { data: await this.files.list(ctx, id(patientId)) };
  }

  /** Served with a sandboxing CSP and `nosniff` so an uploaded file can never run as a page, and never cached. */
  @RequirePermissions("PATIENT_READ")
  @Get("files/:id/content")
  async content(@Ctx() ctx: RequestContext, @Param("id") fileId: string, @Query("download") download: string | undefined, @Res() res: Response) {
    const { file, data } = await this.files.content(ctx, id(fileId));
    const asciiName = file.fileName.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
    res.setHeader("Content-Type", file.contentType);
    res.setHeader("Content-Length", String(data.length));
    res.setHeader("Content-Disposition", `${download === "1" || file.kind === "DOCUMENT" && download !== "0" ? "attachment" : "inline"}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, no-store");
    res.status(200).send(data);
  }

  @RequirePermissions("PATIENT_UPDATE")
  @Post("files/:id/remove")
  @HttpCode(200)
  async remove(@Ctx() ctx: RequestContext, @Param("id") fileId: string, @Body() body: unknown) {
    return { data: await this.files.remove(ctx, id(fileId), parse(removeFileSchema, body).reason) };
  }
}
