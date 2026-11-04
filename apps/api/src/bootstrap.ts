import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { raw, type RequestHandler } from "express";
import helmet from "helmet";
import { AppModule } from "./app.module";
import { loadConfig } from "./common/config";
import { requestLogMiddleware } from "./common/http-pipeline";
import { tenantScopeMiddleware } from "./common/tenant-scope";

/** Shared by main.ts and the test harness so tests exercise the real HTTP configuration. */
export async function createApp(): Promise<NestExpressApplication> {
  const config = loadConfig();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: config.NODE_ENV === "test" ? false : ["error", "warn"],
    bodyParser: false,
  });
  app.setGlobalPrefix("api/v1");
  app.disable("x-powered-by");
  // Only these peers may report the client address in X-Forwarded-For (the web server, which relays every browser).
  app.set("trust proxy", config.TRUST_PROXY);
  app.use(requestLogMiddleware);
  app.useBodyParser("json", { limit: "256kb" });
  // Raw file bodies (PNG/JPEG/PDF) are accepted only on the patient file upload route, only from callers that sent credentials
  // (so anonymous requests cannot make the server buffer large bodies), and only up to the size limit.
  const rawFiles = raw({ type: ["image/png", "image/jpeg", "application/pdf"], limit: "6mb" });
  const authedOnly: RequestHandler = (req, res, next) => (req.method === "POST" && req.headers.authorization && /^\/api\/v1\/(patients\/[^/]+\/files|encounters\/[^/]+\/prescription-scans)\/?$/.test(req.path) ? rawFiles(req, res, next) : next());
  app.use(authedOnly);
  // CSV imports (docs/import.md): same rule, own limit.
  const rawCsv = raw({ type: ["text/csv"], limit: "5mb" });
  app.use(((req, res, next) => (req.method === "POST" && req.headers.authorization && /^\/api\/v1\/imports\/[^/]+\/?$/.test(req.path) ? rawCsv(req, res, next) : next())) as RequestHandler);
  app.use(helmet());
  // Row-level security scope for the request (docs/rls.md). After body parsing on purpose: the parsers' stream callbacks can
  // lose async context, which would leave the guards and handlers with no scope.
  app.use(tenantScopeMiddleware);
  const origins = config.CORS_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean);
  app.enableCors({ origin: origins, credentials: false, methods: ["GET", "POST", "PUT", "PATCH", "DELETE"], maxAge: 600 });
  return app;
}
