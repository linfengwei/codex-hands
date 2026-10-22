// Calls a sequence of tools on the MCP server, for development.
// Usage: node test/call.mjs '<JSON array of {"name": tool, "arguments": {...}}>' [out dir]
// In arguments, "window_title": "<exact title>" is replaced by the matching window_id.
// Images are saved to <out dir>; text is printed.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [stepsJson, outDir = join(here, "out")] = process.argv.slice(2);
const steps = JSON.parse(stepsJson ?? "[]");
const server = spawn(process.execPath, [join(here, "..", "plugins", "codex-hands", "server", "launch.mjs")], {
  stdio: ["pipe", "pipe", "inherit"],
});

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

let failed = false;
let image = 0;
try {
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: { elicitation: {} }, clientInfo: { name: "call", version: "0" } });
  let windows = null;
  for (const step of steps) {
    const args = { ...step.arguments };
    if (args.window_title != null) {
      windows ??= JSON.parse((await rpc("tools/call", { name: "list_windows", arguments: {} })).content[0].text);
      const hits = windows.filter((w) => w.title === args.window_title);
      if (hits.length !== 1) throw new Error(`expected one window titled "${args.window_title}", found ${hits.length}`);
      args.window_id = hits[0].id;
      delete args.window_title;
    }
    const r = await rpc("tools/call", { name: step.name, arguments: args });
    console.log(`== ${step.name} ${JSON.stringify(args)}${r.isError ? " (error)" : ""}`);
    for (const c of r.content) {
      if (c.type === "image") {
        mkdirSync(outDir, { recursive: true });
        const file = join(outDir, `call-${String(++image).padStart(2, "0")}.${c.mimeType.split("/")[1]}`);
        writeFileSync(file, Buffer.from(c.data, "base64"));
        console.log(`[image] ${file}`);
      } else {
        console.log(c.text.split("\n").slice(0, step.lines ?? 30).join("\n"));
      }
    }
    if (r.isError) {
      failed = true;
      break;
    }
  }
} catch (e) {
  failed = true;
  console.log("FAILED:", e.message);
}
server.stdin.end();
server.on("exit", () => process.exit(failed ? 1 : 0));
