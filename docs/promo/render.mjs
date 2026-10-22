// Renders promo.html to a 1280x720, 30 fps, 15 s MP4 with headless Edge (DevTools protocol) and ffmpeg,
// with the soundtrack from music.mjs.
// Each frame is seeked with the page's seek(ms), so the result does not depend on timing.
// Usage: node docs/promo/render.mjs [out.mp4] [--frames 0,120,300 to write PNGs of those frames only]
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const framesArg = args.includes("--frames") ? args[args.indexOf("--frames") + 1].split(",").map(Number) : null;
const out = args.find((a) => a.endsWith(".mp4")) ?? join(here, "codex-hands-promo-720p.mp4");
const FPS = 30;
const SECONDS = 15;
const [W, H] = [1280, 720];
const PORT = 9333;
const EDGE = ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"].find(existsSync);
if (!EDGE) throw new Error("Microsoft Edge not found");

const edge = spawn(EDGE, ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), "promo-edge-"))}`, `--window-size=${W},${H}`, "about:blank"], { stdio: "ignore" });

let target;
for (let i = 0; i < 50 && !target; i++) {
  await new Promise((r) => setTimeout(r, 200));
  target = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json()).then((l) => l.find((t) => t.type === "page")).catch(() => null);
}
if (!target) throw new Error("Edge DevTools did not start");

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let nextId = 1;
const waiting = new Map();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) {
    waiting.get(m.id)(m);
    waiting.delete(m.id);
  }
});
const cdp = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    waiting.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = (expression) => cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });

await cdp("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
await cdp("Page.navigate", { url: `${pathToFileURL(join(here, "promo.html")).href}?render` });
await evaluate(`new Promise((r) => { const ok = () => document.fonts.ready.then(() => Promise.all([...document.images].map((i) => i.decode()))).then(r);
  document.readyState === "complete" ? ok() : addEventListener("load", ok); })`);

const shot = async (frame) => {
  await evaluate(`seek(${(frame * 1000) / FPS}); new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`);
  const { data } = await cdp("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: W, height: H, scale: 1 } });
  return Buffer.from(data, "base64");
};

if (framesArg) {
  for (const f of framesArg) {
    const file = join(here, "..", "..", "test", "out", `promo-frame-${String(f).padStart(3, "0")}.png`);
    writeFileSync(file, await shot(f));
    console.log(file);
  }
} else {
  const wav = join(mkdtempSync(join(tmpdir(), "promo-music-")), "music.wav");
  execFileSync(process.execPath, [join(here, "music.mjs"), wav], { stdio: "inherit" });
  const ffmpeg = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-i", "-", "-i", wav,
    "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-shortest",
    "-movflags", "+faststart", out], { stdio: ["pipe", "inherit", "inherit"] });
  const done = new Promise((r) => ffmpeg.on("exit", r));
  for (let f = 0; f < FPS * SECONDS; f++) {
    const png = await shot(f);
    if (!ffmpeg.stdin.write(png)) await new Promise((r) => ffmpeg.stdin.once("drain", r));
    if (f % 60 === 0) console.log(`frame ${f}/${FPS * SECONDS}`);
  }
  ffmpeg.stdin.end();
  const code = await done;
  console.log(code === 0 ? `wrote ${out}` : `ffmpeg failed (${code})`);
}
ws.close();
edge.kill();
