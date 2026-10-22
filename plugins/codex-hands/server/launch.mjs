// Starts server.mjs on the node.exe inside the installed Codex app, with SKY_DIR pointing at its @oai/sky.
// Nothing is copied out of the app. Runs on any Node on PATH; stdio is passed straight through for MCP.
// CODEX_HANDS_CODEX_DIR overrides the app's install folder (the folder that contains "app\resources").
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const fail = (msg) => {
  process.stderr.write(`[codex-hands] ${msg}\n`);
  process.exit(1);
};

if (process.platform !== "win32") fail("Windows only.");

let appDir = process.env.CODEX_HANDS_CODEX_DIR?.trim();
if (!appDir) {
  try {
    appDir = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "(Get-AppxPackage -Name 'OpenAI.Codex' | Select-Object -First 1).InstallLocation"],
      { encoding: "utf8", windowsHide: true },
    ).trim();
  } catch (e) {
    fail(`could not query the Codex app package: ${e.message}`);
  }
}
if (!appDir) fail("The Codex app (OpenAI.Codex) is not installed for this Windows account. Install it from https://chatgpt.com/codex.");

const bin = join(appDir, "app", "resources", "cua_node", "bin");
const node = join(bin, "node.exe");
const skyDir = join(bin, "node_modules", "@oai", "sky");
if (!existsSync(node)) fail(`no node.exe in the Codex app: ${node}`);
if (!existsSync(join(skyDir, "package.json"))) fail(`no @oai/sky in the Codex app: ${skyDir}`);

const server = join(dirname(fileURLToPath(import.meta.url)), "server.mjs");
const child = spawn(node, [server], { stdio: "inherit", windowsHide: true, env: { ...process.env, SKY_DIR: skyDir } });
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
child.on("error", (e) => fail(`could not start the Codex app's node.exe: ${e.message}`));
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => child.kill());
