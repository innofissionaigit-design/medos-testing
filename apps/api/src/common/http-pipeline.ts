import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from "@nestjs/common";
import { DomainError } from "@medos/shared";
import { Prisma } from "@medos/database";
import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { logJson } from "./logger";
import { validationError } from "./http";
import type { AuthedRequest } from "./request-context";

const SAFE_REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;

/**
 * Assigns a request id (accepting a well-formed inbound one) and logs one structured line per request.
 * Registered with app.use() BEFORE body parsing so even body-parser failures carry a request id.
 */
export function requestLogMiddleware(req: Request, res: Response, next: NextFunction): void {
  {
    const inbound = req.headers["x-request-id"];
    const requestId = typeof inbound === "string" && SAFE_REQUEST_ID.test(inbound) ? inbound : randomUUID();
    (req as unknown as AuthedRequest).requestId = requestId;
    res.setHeader("x-request-id", requestId);
    const started = process.hrtime.bigint();
    res.on("finish", () => {
      const r = req as unknown as AuthedRequest & { errorCode?: string };
      const ms = Number((process.hrtime.bigint() - started) / 1_000_000n);
      logJson("info", "http_request", {
        requestId,
        tenantId: r.ctx?.tenantId,
        facilityId: r.ctx?.facilityId,
        userId: r.ctx?.userId,
        method: req.method,
        route: req.route?.path ?? "unmatched",
        status: res.statusCode,
        errorCode: r.errorCode,
        ms,
      });
    });
    next();
  }
}

/** body-parser (express) errors carry a numeric status and a type like entity.too.large. */
function isBodyParserError(e: unknown): e is { status: number; type: string } {
  return typeof e === "object" && e !== null && typeof (e as { status?: unknown }).status === "number"
    && typeof (e as { type?: unknown }).type === "string" && (e as { type: string }).type.startsWith("entity.");
}

interface ErrorBody { error: { code: string; message: string; details?: unknown; requestId?: string } }

/** Central mapping of every failure to the stable error envelope; never leaks internals. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<AuthedRequest & { errorCode?: string }>();
    const res = http.getResponse<Response>();
    const requestId = req.requestId;

    let status = 500;
    let body: ErrorBody = { error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred", requestId } };

    if (exception instanceof DomainError) {
      status = exception.httpStatus;
      body = { error: { code: exception.code, message: exception.message, details: exception.details, requestId } };
      // Tells well-behaved clients how long to wait (RFC 9110 Retry-After, in seconds) when they are throttled.
      const wait = (exception.details as { retryAfterSeconds?: unknown } | undefined)?.retryAfterSeconds;
      if (status === 429 && typeof wait === "number" && Number.isFinite(wait) && wait > 0) res.setHeader("Retry-After", String(Math.ceil(wait)));
    } else if (exception instanceof ZodError) {
      const e = validationError(exception);
      status = 400;
      body = { error: { code: e.code, message: e.message, details: e.details, requestId } };
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const map: Record<number, [string, string]> = {
        400: ["VALIDATION_FAILED", "Malformed request"],
        401: ["UNAUTHENTICATED", "Authentication required"],
        403: ["FORBIDDEN", "You do not have permission to perform this action"],
        404: ["NOT_FOUND", "Resource not found"],
        413: ["VALIDATION_FAILED", "Request body too large"],
        415: ["VALIDATION_FAILED", "Unsupported content type"],
        429: ["RATE_LIMITED", "Too many requests. Try again later."],
      };
      const [code, message] = map[status] ?? ["INTERNAL_ERROR", "An unexpected error occurred"];
      body = { error: { code, message, requestId } };
    } else if (isBodyParserError(exception)) {
      status = exception.status === 413 ? 413 : 400;
      body = status === 413
        ? { error: { code: "PAYLOAD_TOO_LARGE", message: "Request body too large", requestId } }
        : { error: { code: "VALIDATION_FAILED", message: "Malformed request body", requestId } };
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === "P2002") {
        status = 409;
        body = { error: { code: "CONFLICT", message: "A record with these values already exists", requestId } };
      } else if (exception.code === "P2034") {
        status = 409;
        body = { error: { code: "CONFLICT", message: "The system was busy with a conflicting update. Please try again.", requestId } };
      } else if (exception.code === "P2025") {
        status = 404;
        body = { error: { code: "NOT_FOUND", message: "Resource not found", requestId } };
      }
    }

    if (status >= 500) {
      logJson("error", "unhandled_exception", {
        requestId,
        errorName: exception instanceof Error ? exception.name : typeof exception,
        // message may contain SQL; it is logged server-side only and never returned.
        errorMessage: exception instanceof Error ? exception.message.slice(0, 500) : undefined,
      });
    }
    req.errorCode = body.error.code;
    res.status(status).json(body);
  }
}
