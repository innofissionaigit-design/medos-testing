import "reflect-metadata";
import { createApp } from "./bootstrap";
import { loadConfig } from "./common/config";
import { logJson } from "./common/logger";

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await createApp();
  app.enableShutdownHooks();
  await app.listen(config.PORT);
  logJson("info", "api_started", { port: config.PORT });
}

main().catch((e: unknown) => {
  process.stderr.write(`Fatal startup error: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
