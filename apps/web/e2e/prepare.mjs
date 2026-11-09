import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
// Rebuild and seed the end-to-end database (medos_e2e) before any server starts.
execFileSync("powershell", ["-NoProfile", "-File", path.join(root, "scripts", "e2e-prepare.ps1")], { stdio: "inherit", cwd: root });
