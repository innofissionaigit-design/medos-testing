import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../app.module";
import { tenantScope } from "../common/tenant-scope";
import { provisionSchema, TenantsService } from "../modules/tenants/tenants.service";

/**
 * Platform-operator CLI: provisions a tenant, first facility and administrator.
 * Input is a JSON file path (argv[2]) so the admin password never appears in the process list/shell history.
 *   node dist/cli/provision.js ./tenant.json
 */
async function run(): Promise<void> {
  const path = process.argv[2];
  if (!path) throw new Error("Usage: provision <config.json>");
  const { readFileSync } = await import("node:fs");
  const input = provisionSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ["error"] });
  try {
    // Provisioning is an owner operation: it creates a hospital, so no hospital scope exists yet. Run it with the OWNER database
    // login (never the API's restricted one); see docs/rls.md.
    const result = await tenantScope.owner(() => app.get(TenantsService).provision(input));
    process.stdout.write(`Provisioned tenant ${result.tenantId} facility ${result.facilityId} admin ${result.adminUserId}\n`);
  } finally {
    await app.close();
  }
}

run().catch((e: unknown) => {
  process.stderr.write(`Provision failed: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
