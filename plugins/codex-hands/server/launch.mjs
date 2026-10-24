// Starts server.mjs on the node.exe inside the installed Codex app, with SKY_DIR pointing at its @oai/sky.
// Nothing is copied out of the app. Runs on any Node on PATH; stdio is passed straight through for MCP.
// codex-app.mjs finds the app (CODEX_HANDS_CODEX_DIR overrides its install folder).
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { findCodexApp } from "./codex-app.mjs";

const fail = (msg) => {
  process.stderr.write(`[codex-hands] ${msg}\n`);
  process.exit(1);
};

if (process.platform !== "win32") fail("Windows only.");

let app;
try {
  app = findCodexApp();
} catch (e) {
  fail(e.message);
}

const server = join(dirname(fileURLToPath(import.meta.url)), "server.mjs");
const child = spawn(app.node, [server], { stdio: "inherit", windowsHide: true, env: { ...process.env, SKY_DIR: app.skyDir } });
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
child.on("error", (e) => fail(`could not start the Codex app's node.exe: ${e.message}`));
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => child.kill());
