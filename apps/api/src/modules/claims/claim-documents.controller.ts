import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { Ctx, id, parse, RequirePermissions } from "../../common/http";
import type { RequestContext } from "../../common/request-context";
import { ClaimDocumentsService, documentUploadQuerySchema, removeDocumentSchema } from "./claim-documents.service";

/** Supporting documents of an insurance claim (docs/claims.md). Bytes are sent as the raw request body (PNG, JPEG or PDF), metadata in the query string. */
@Controller()
export class ClaimDocumentsController {
  constructor(private readonly documents: ClaimDocumentsService) {}

  @RequirePermissions("CLAIM_MANAGE")
  @Post("claims/:id/documents")
  @HttpCode(201)
  async upload(@Ctx() ctx: RequestContext, @Param("id") claimId: string, @Query() query: unknown, @Headers("content-type") contentType: string | undefined, @Req() req: Request) {
    return { data: await this.documents.upload(ctx, id(claimId), parse(documentUploadQuerySchema, query), contentType, req.body) };
  }

  @RequirePermissions("CLAIM_READ")
  @Get("claims/:id/documents")
  async list(@Ctx() ctx: RequestContext, @Param("id") claimId: string) { return { data: await this.documents.list(ctx, id(claimId)) }; }

  /** Served with a sandboxing CSP and `nosniff` so an uploaded file can never run as a page, and never cached. */
  @RequirePermissions("CLAIM_READ")
  @Get("claim-documents/:id/content")
  async content(@Ctx() ctx: RequestContext, @Param("id") documentId: string, @Query("download") download: string | undefined, @Res() res: Response) {
    const { document, data } = await this.documents.content(ctx, id(documentId));
    const asciiName = document.fileName.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
    res.setHeader("Content-Type", document.contentType);
    res.setHeader("Content-Length", String(data.length));
    res.setHeader("Content-Disposition", `${download === "0" ? "inline" : "attachment"}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(document.fileName)}`);
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, no-store");
    res.status(200).send(data);
  }

  @RequirePermissions("CLAIM_MANAGE")
  @Post("claim-documents/:id/remove")
  @HttpCode(200)
  async remove(@Ctx() ctx: RequestContext, @Param("id") documentId: string, @Body() body: unknown) { return { data: await this.documents.remove(ctx, id(documentId), parse(removeDocumentSchema, body).reason) }; }
}
