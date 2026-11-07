import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { Ctx, id, parse, RequirePermissions } from "../../common/http";
import type { RequestContext } from "../../common/request-context";
import { imageUploadQuerySchema, RadImagesService, removeImageSchema } from "./rad-images.service";

/** Images of a radiology study (docs/radiology.md). Bytes are sent as the raw request body (PNG, JPEG or DICOM), metadata in the query string. */
@Controller()
export class RadImagesController {
  constructor(private readonly images: RadImagesService) {}

  @RequirePermissions("RAD_PERFORM")
  @Post("rad/studies/:id/images")
  @HttpCode(201)
  async upload(@Ctx() ctx: RequestContext, @Param("id") studyId: string, @Query() query: unknown, @Headers("content-type") contentType: string | undefined, @Req() req: Request) {
    return { data: await this.images.upload(ctx, id(studyId), parse(imageUploadQuerySchema, query), contentType, req.body) };
  }

  @RequirePermissions("RAD_READ")
  @Get("rad/studies/:id/images")
  async list(@Ctx() ctx: RequestContext, @Param("id") studyId: string) { return { data: await this.images.list(ctx, id(studyId)) }; }

  /** Served with a sandboxing CSP and `nosniff` so an uploaded file can never run as a page, and never cached. */
  @RequirePermissions("RAD_READ")
  @Get("rad/images/:id/content")
  async content(@Ctx() ctx: RequestContext, @Param("id") imageId: string, @Query("download") download: string | undefined, @Res() res: Response) {
    const { image, data } = await this.images.content(ctx, id(imageId));
    const asciiName = image.fileName.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
    res.setHeader("Content-Type", image.contentType);
    res.setHeader("Content-Length", String(data.length));
    res.setHeader("Content-Disposition", `${download === "1" || image.contentType === "application/dicom" ? "attachment" : "inline"}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(image.fileName)}`);
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, no-store");
    res.status(200).send(data);
  }

  @RequirePermissions("RAD_PERFORM")
  @Post("rad/images/:id/remove")
  @HttpCode(200)
  async remove(@Ctx() ctx: RequestContext, @Param("id") imageId: string, @Body() body: unknown) { return { data: await this.images.remove(ctx, id(imageId), parse(removeImageSchema, body).reason) }; }
}
