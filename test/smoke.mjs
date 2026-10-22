// Smoke test: start the MCP server through launch.mjs, then initialize, list tools and list windows.
// With an exact window title, also observe that window (read-only) and save its screenshot.
// Usage: node test/smoke.mjs [exact window title] [out dir]
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const [title, outDir = join(dirname(fileURLToPath(import.meta.url)), "out")] = process.argv.slice(2);
const launch = join(dirname(fileURLToPath(import.meta.url)), "..", "plugins", "codex-hands", "server", "launch.mjs");
const server = spawn(process.execPath, [launch], { stdio: ["pipe", "pipe", "inherit"] });

// Stands in for Claude Code's permission dialog: asks on this terminal, or uses CODEX_HANDS_TEST_ANSWER
// (always | session | decline | cancel) when there is no terminal. Without either, it declines.
// CODEX_HANDS_TEST_DELAY_MS waits before answering; an answer under 1 s counts as "no dialog shown" in the server.
async function answerElicitation(params) {
  let answer = process.env.CODEX_HANDS_TEST_ANSWER;
  if (!answer && process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    answer = await new Promise((r) => rl.question(`${params.message}\n  always / session / decline / cancel? `, r));
    rl.close();
  }
  await new Promise((r) => setTimeout(r, Number(process.env.CODEX_HANDS_TEST_DELAY_MS ?? 0)));
  console.log(`[dialog] ${params.message} -> ${answer || "decline"}`);
  if (answer === "cancel") return { action: "cancel" };
  return ["always", "session"].includes(answer) ? { action: "accept", content: { choice: answer } } : { action: "decline" };
}

const pending = new Map();
let nextId = 1;
createInterface({ input: server.stdout }).on("line", async (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "elicitation/create") {
    const result = await answerElicitation(msg.params);
    return server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n`);
  }
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
const call = async (name, args = {}) => {
  const r = await rpc("tools/call", { name, arguments: args });
  if (r.isError) throw new Error(r.content[0].text);
  return r.content;
};

let failed = false;
try {
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: { elicitation: {} }, clientInfo: { name: "smoke", version: "0" } });
  console.log("initialize:", init.serverInfo.name, init.serverInfo.version, init.protocolVersion);
  server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const { tools } = await rpc("tools/list", {});
  console.log("tools:", tools.map((t) => t.name).join(", "));
  const windows = JSON.parse((await call("list_windows"))[0].text);
  console.log("list_windows:", windows.length, "windows");
  if (title) {
    const hits = windows.filter((w) => w.title === title);
    if (hits.length !== 1) throw new Error(`expected one window titled "${title}", found ${hits.length}`);
    const content = await call("get_window_state", { window_id: hits[0].id, include_text: true });
    console.log(content[0].text);
    const image = content.find((c) => c.type === "image");
    if (!image) throw new Error("no screenshot returned");
    mkdirSync(outDir, { recursive: true });
    const file = join(outDir, `state.${image.mimeType.split("/")[1]}`);
    writeFileSync(file, Buffer.from(image.data, "base64"));
    const tree = content.find((c, i) => i > 0 && c.type === "text")?.text ?? "";
    console.log("screenshot:", file, "| tree lines:", tree.split("\n").length);
  }
  await call("end_session");
} catch (e) {
  failed = true;
  console.log("FAILED:", e.message);
}
server.stdin.end();
server.on("exit", () => process.exit(failed ? 1 : 0));
