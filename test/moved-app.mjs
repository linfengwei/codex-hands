// Checks that the server follows the Codex app when its folder goes away (the app updates itself and
// removes the old version's folder). The server starts with SKY_DIR in a temporary copy of the app's
// cua_node folder; after the first list_windows the helper is closed and the copy deleted, and the second
// list_windows (a new helper) must still work. The copy is about 250 MB.
// Usage: node test/moved-app.mjs
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { cpSync, rmSync, mkdtempSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { findCodexApp } from "../plugins/codex-hands/server/codex-app.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const app = findCodexApp();
const cuaNode = join(app.appDir, "app", "resources", "cua_node");
const old = mkdtempSync(join(tmpdir(), "codex-hands-moved-"));
const oldCuaNode = join(old, "app", "resources", "cua_node");
cpSync(cuaNode, oldCuaNode, { recursive: true });
const oldSky = join(oldCuaNode, relative(cuaNode, app.skyDir));

const env = { ...process.env, SKY_DIR: oldSky };
delete env.CODEX_HANDS_CODEX_DIR;
const server = spawn(app.node, [join(here, "..", "plugins", "codex-hands", "server", "server.mjs")], { stdio: ["pipe", "pipe", "pipe"], env });
let stderr = "";
server.stderr.on("data", (d) => (stderr += d));

const pending = new Map();
let nextId = 1;
createInterface({ input: server.stdout }).on("line", (line) => {
  const msg = JSON.parse(line);
  pending.get(msg.id)?.(msg);
  pending.delete(msg.id);
});
const rpc = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 60_000);
    pending.set(id, (m) => (clearTimeout(timer), m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
    server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
const windowCount = async () => {
  const r = await rpc("tools/call", { name: "list_windows", arguments: {} });
  if (r.isError) throw new Error(r.content[0].text);
  return r.content[0].text.split("\n").length;
};

let failed = false;
try {
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "moved-app", version: "0" } });
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  console.log(`before: list_windows from the copy in ${old}: ${await windowCount()} lines`);
  // The open helper runs from the copy; close it so the copy can be deleted, as an app update deletes the old folder.
  await rpc("tools/call", { name: "end_session", arguments: {} });
  rmSync(old, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  console.log("helper closed, copy deleted");
  console.log(`after: list_windows: ${await windowCount()} lines`);
  if (!stderr.includes("@oai/sky moved:")) throw new Error("the server did not log that sky moved");
  console.log("ok: the server loaded sky from", app.skyDir);
} catch (e) {
  failed = true;
  console.error("FAILED:", e.message);
  console.error(stderr);
} finally {
  server.stdin.end();
  rmSync(old, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  process.exitCode = failed ? 1 : 0;
}
