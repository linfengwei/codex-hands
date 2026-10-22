// MCP server (stdio) that exposes the Windows computer-use API of @oai/sky as fixed tools.
// It runs on the node.exe inside the installed Codex app; launch.mjs finds it and sets SKY_DIR.
// stdout carries MCP messages only; everything else goes to stderr.
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { execFile } from "node:child_process";

const SERVER = { name: "codex-hands", version: "0.3.0" };
const TESTED_SKY = ["0.7.12"];
const IDLE_CLOSE_MS = 120_000;
const DIALOG_TIMEOUT_MS = 180_000;
// A "no" faster than this did not come from a person, so Claude Code showed no dialog.
const NOT_SHOWN_MS = 1_000;
const TURN_ENDED_FILE = join(tmpdir(), "codex-hands", "turn-ended");
// Claude Code gives each plugin a data folder; .mcp.json also passes it as CODEX_HANDS_DATA.
const DATA_DIR = [process.env.CLAUDE_PLUGIN_DATA, process.env.CODEX_HANDS_DATA].find((d) => d && !d.includes("${"));
const ALLOWED_FILE = DATA_DIR ? join(DATA_DIR, "allowed-apps.json") : null;
// Always refused, and never asked about: terminals, the agent hosts themselves, and the lock screen.
const DENIED_APPS = new Set([
  "cmd.exe", "powershell.exe", "pwsh.exe", "windowsterminal.exe", "wt.exe", "conhost.exe", "openconsole.exe",
  "chatgpt.exe", "codex.exe", "claude.exe", "lockapp.exe",
]);

const log = (...a) => process.stderr.write(`[codex-hands] ${a.join(" ")}\n`);
console.log = log;
console.info = log;

const skyDir = process.env.SKY_DIR;
if (!skyDir) {
  log("SKY_DIR is not set; start the server through launch.mjs");
  process.exit(1);
}
const skyVersion = JSON.parse(readFileSync(join(skyDir, "package.json"), "utf8")).version;
if (!TESTED_SKY.includes(skyVersion)) log(`@oai/sky ${skyVersion} is not a tested version (${TESTED_SKY.join(", ")})`);
const { WindowsComputerUseClient } = await import(
  pathToFileURL(join(skyDir, "dist", "project", "cua", "sky_js", "src", "targets", "windows", "internal", "computer_use_client.js")).href
);

// ---- app approval -------------------------------------------------------------------------------
// The helper asks before it touches an app; sky passes the question to nodeRepl.createElicitation.
// The answer comes only from the user: an app they chose "always allow" for earlier (ALLOWED_FILE),
// one they allowed in this session, or a new answer in Claude Code's dialog (MCP elicitation) or, when
// Claude Code shows none, in a Windows dialog.
const sessionApps = new Set();

// A missing file is an empty list; an unreadable one throws, so a save never overwrites apps it could not read.
function allowedApps() {
  if (!ALLOWED_FILE) return [];
  let data;
  try {
    data = JSON.parse(readFileSync(ALLOWED_FILE, "utf8"));
  } catch (e) {
    if (e?.code === "ENOENT") return [];
    throw new Error(`cannot read ${ALLOWED_FILE}: ${e?.message ?? e}`);
  }
  return Array.isArray(data?.allowed) ? data.allowed.map((a) => String(a).toLowerCase()) : [];
}

function saveAllowedApps(list) {
  if (!ALLOWED_FILE) throw new Error("Claude Code gave no plugin data folder (CLAUDE_PLUGIN_DATA)");
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(ALLOWED_FILE, `${JSON.stringify({ allowed: [...new Set(list)].sort() }, null, 2)}\n`);
}

function isRemembered(app) {
  if (sessionApps.has(app)) return true;
  try {
    return allowedApps().includes(app);
  } catch (e) {
    log(e.message);
    return false;
  }
}

// Dialog text, in the Windows display language: Chinese for zh-*, English otherwise. CODEX_HANDS_LANG (zh or en) overrides it.
const DIALOG_TEXT = {
  zh: {
    ask: (app) => `codex-hands 想操作 ${app}（看畫面、點擊、打字）。要允許嗎？`,
    title: (app) => `允許操作 ${app}`,
    always: "一律允許（記住，以後不再問）",
    session: "只允許到 Claude Code 關掉",
    deny: "拒絕",
    why: "Claude Code 在這裡沒辦法顯示權限對話框，所以改用這個視窗問你。",
    font: "Microsoft JhengHei UI",
  },
  en: {
    ask: (app) => `codex-hands wants to use ${app} (see the screen, click, type). Allow it?`,
    title: (app) => `Allow ${app}`,
    always: "Always allow (remember, don't ask again)",
    session: "Allow until Claude Code closes",
    deny: "Deny",
    why: "Claude Code can't show a permission dialog here, so this window asks you instead.",
    font: "Segoe UI",
  },
};
let dialogLanguage = null;

async function dialogText() {
  if (!dialogLanguage) {
    const forced = process.env.CODEX_HANDS_LANG?.trim().toLowerCase();
    let ui = forced;
    if (!ui) {
      ui = await new Promise((resolve) =>
        execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "[Globalization.CultureInfo]::CurrentUICulture.Name"],
          { windowsHide: true, timeout: 10_000 }, (e, stdout) => resolve(e ? Intl.DateTimeFormat().resolvedOptions().locale : stdout.trim())));
    }
    dialogLanguage = ui.toLowerCase().startsWith("zh") ? "zh" : "en";
    log(`dialog language ${dialogLanguage} (${forced ? "CODEX_HANDS_LANG" : "Windows display language"} ${ui})`);
  }
  return DIALOG_TEXT[dialogLanguage];
}

// Asks in Claude Code's dialog (MCP elicitation). Returns always, session, decline or cancel, or null when
// Claude Code showed no dialog: it has no elicitation, the request failed, or it answered faster than a
// person can (the Code tab of the Claude desktop app declines in about 10 ms and shows nothing).
async function askInClaudeCode(app) {
  if (!clientCanElicit) {
    log(`the client has no MCP elicitation; asking about ${app} in a Windows dialog`);
    return null;
  }
  const text = await dialogText();
  const started = Date.now();
  let r;
  try {
    r = await request("elicitation/create", {
      message: text.ask(app),
      requestedSchema: {
        type: "object",
        properties: {
          choice: {
            type: "string",
            title: text.title(app),
            enum: ["always", "session"],
            enumNames: [text.always, text.session],
            default: "session",
          },
        },
        required: ["choice"],
      },
    }, DIALOG_TIMEOUT_MS);
  } catch (e) {
    if (e instanceof DialogTimeout) throw e;
    log(`Claude Code's dialog failed (${e?.message ?? e}); asking about ${app} in a Windows dialog`);
    return null;
  }
  if (r?.action === "accept") return r.content?.choice === "always" ? "always" : "session";
  const ms = Date.now() - started;
  if (ms < NOT_SHOWN_MS) {
    log(`Claude Code answered ${r?.action} in ${ms} ms, so it showed no dialog; asking about ${app} in a Windows dialog`);
    return null;
  }
  return r?.action === "decline" ? "decline" : "cancel";
}

// The Windows dialog for when Claude Code shows none. It prints always, session, decline or cancel.
// Its text comes in through CODEX_HANDS_* variables, so the app name is never parsed as PowerShell.
const WINDOWS_DIALOG_PS = String.raw`
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$r = @{ answer = 'cancel' }
$f = New-Object System.Windows.Forms.Form
$f.Text = 'codex-hands'
$f.TopMost = $true
$f.StartPosition = 'CenterScreen'
$f.FormBorderStyle = 'FixedDialog'
$f.MaximizeBox = $false
$f.MinimizeBox = $false
$f.AutoSize = $true
$f.AutoSizeMode = 'GrowAndShrink'
$f.Padding = New-Object System.Windows.Forms.Padding 16
$f.Font = New-Object System.Drawing.Font($env:CODEX_HANDS_FONT, 10)
$col = New-Object System.Windows.Forms.FlowLayoutPanel
$col.FlowDirection = 'TopDown'
$col.AutoSize = $true
$col.Location = New-Object System.Drawing.Point 16, 16
$l = New-Object System.Windows.Forms.Label
$l.AutoSize = $true
$l.MaximumSize = New-Object System.Drawing.Size 560, 0
$l.Margin = New-Object System.Windows.Forms.Padding 0, 0, 0, 12
$l.Text = $env:CODEX_HANDS_ASK + [Environment]::NewLine + [Environment]::NewLine + $env:CODEX_HANDS_WHY
$col.Controls.Add($l)
$row = New-Object System.Windows.Forms.FlowLayoutPanel
$row.AutoSize = $true
foreach ($b in @(@('always', $env:CODEX_HANDS_ALWAYS), @('session', $env:CODEX_HANDS_SESSION), @('decline', $env:CODEX_HANDS_DENY))) {
  $btn = New-Object System.Windows.Forms.Button
  $btn.Text = $b[1]
  $btn.Tag = $b[0]
  $btn.AutoSize = $true
  $btn.Padding = New-Object System.Windows.Forms.Padding 8, 4, 8, 4
  $btn.add_Click({ param($s) $r.answer = $s.Tag; $f.Close() })
  $row.Controls.Add($btn)
  if ($b[0] -eq 'session') { $sessionBtn = $btn }
}
$col.Controls.Add($row)
$f.Controls.Add($col)
$f.ActiveControl = $sessionBtn
# Started with windowsHide, Windows keeps the first window of this process hidden, so show it again.
Add-Type -Namespace SkyCu -Name Win -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);'
$f.add_Shown({ [void][SkyCu.Win]::ShowWindow($f.Handle, 5); $f.Activate() })
[void]$f.ShowDialog()
[Console]::Out.Write($r.answer)
`;

async function askInWindowsDialog(app) {
  const text = await dialogText();
  const env = {
    ...process.env,
    CODEX_HANDS_ASK: text.ask(app),
    CODEX_HANDS_WHY: text.why,
    CODEX_HANDS_ALWAYS: text.always,
    CODEX_HANDS_SESSION: text.session,
    CODEX_HANDS_DENY: text.deny,
    CODEX_HANDS_FONT: text.font,
  };
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", Buffer.from(WINDOWS_DIALOG_PS, "utf16le").toString("base64")],
      { env, timeout: DIALOG_TIMEOUT_MS, windowsHide: true },
      (e, stdout, stderr) => {
        if (e?.killed) return reject(new DialogTimeout(`no answer in the Windows dialog within ${DIALOG_TIMEOUT_MS} ms`));
        if (e) {
          // PowerShell writes stderr as CLIXML when stdout is redirected; keep only its error lines.
          const why = stderr.startsWith("#< CLIXML")
            ? [...stderr.matchAll(/<S S="Error">(.*?)<\/S>/g)].map((m) => m[1].replaceAll("_x000D__x000A_", " ")).join("").trim()
            : stderr.trim();
          return reject(new Error(`the Windows dialog ended with exit code ${e.code}${why ? `: ${why.slice(0, 300)}` : ""}`));
        }
        resolve(stdout.trim());
      },
    );
  });
}

async function askUser(app) {
  const answer = (await askInClaudeCode(app)) ?? (await askInWindowsDialog(app));
  if (answer === "decline") return { ok: false, why: "declined" };
  if (answer !== "always" && answer !== "session") return { ok: false, why: "dismissed" };
  sessionApps.add(app);
  if (answer !== "always") return { ok: true, how: "session" };
  try {
    saveAllowedApps([...allowedApps(), app]);
    return { ok: true, how: "always" };
  } catch (e) {
    log(`could not save ${app}: ${e?.message ?? e}`);
    return { ok: true, how: "session", note: `Note for the user: ${app} is allowed until Claude Code closes, but "always allow" could not be saved (${e?.message ?? e}).` };
  }
}

let lastApproval = null;
globalThis.nodeRepl = {
  config: {},
  createElicitation: async (req) => {
    const app = String(req?.meta?.tool_params?.app ?? "").toLowerCase();
    let result;
    if (!app || DENIED_APPS.has(app)) result = { ok: false, why: "always-refused" };
    else if (isRemembered(app)) result = { ok: true, how: "remembered" };
    else {
      result = await askUser(app).catch((e) =>
        e instanceof DialogTimeout ? { ok: false, why: "no-answer" } : { ok: false, why: "dialog-failed", detail: e?.message ?? String(e) });
    }
    lastApproval = { app, ...result };
    log(`approval ${app}: ${result.ok ? `accept (${result.how})` : `decline (${result.why}${result.detail ? `: ${result.detail}` : ""})`}`);
    return { action: result.ok ? "accept" : "decline" };
  },
};

// ---- helper lifecycle ---------------------------------------------------------------------------
// One sky client (one codex-computer-use.exe) at a time. It closes when idle or when a turn ends
// (the Stop hook touches TURN_ENDED_FILE); the next call starts a new one.
let client = null;
let generation = 0;
let idleTimer = null;
let turnSeen = turnEndedStamp();
const windows = new Map(); // id -> Window from the helper
const observed = new Map(); // id -> { generation, screenshotId, text }

function turnEndedStamp() {
  try {
    return statSync(TURN_ENDED_FILE).mtimeMs;
  } catch {
    return 0;
  }
}

function sky() {
  if (client == null) {
    client = new WindowsComputerUseClient();
    generation += 1;
    observed.clear();
  }
  return client;
}

async function closeClient(reason) {
  if (client == null) return;
  const c = client;
  client = null;
  observed.clear();
  log(`closing helper (${reason})`);
  await c.close().catch((e) => log(`close failed: ${e?.message ?? e}`));
}

function touchIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => queue(() => closeClient("idle")), IDLE_CLOSE_MS);
}

setInterval(() => {
  const stamp = turnEndedStamp();
  if (stamp > turnSeen) {
    turnSeen = stamp;
    queue(() => closeClient("turn ended"));
  }
}, 1000).unref();

// ---- window and observation helpers -------------------------------------------------------------
function remember(list) {
  for (const w of list) windows.set(w.id, w);
  return list;
}

async function windowById(id) {
  if (!Number.isInteger(id) || id < 0) throw new Error("window_id must be an integer from list_windows or list_apps");
  const known = windows.get(id);
  const w = await sky().get_window(known ? { id, app: known.app } : { id });
  windows.set(w.id, w);
  return w;
}

async function observe(window, { screenshot = true, text = false } = {}) {
  const state = await sky().get_window_state({ window, include_screenshot: screenshot, include_text: text });
  windows.set(state.window.id, state.window);
  const prev = observed.get(state.window.id);
  observed.set(state.window.id, {
    generation,
    screenshotId: state.screenshots[0]?.id ?? (prev?.generation === generation ? prev.screenshotId : undefined),
    text: text || (prev?.generation === generation && prev.text && !screenshot),
  });
  return state;
}

// Coordinates are mapped from the helper's latest screenshot of the window, so make sure one exists.
async function screenshotIdFor(window) {
  const o = observed.get(window.id);
  if (o?.generation === generation && o.screenshotId) return o.screenshotId;
  return (await observe(window, { screenshot: true })).screenshots[0]?.id;
}

function requireTextObservation(window) {
  const o = observed.get(window.id);
  if (o?.generation !== generation || !o.text) {
    throw new Error("element_index needs a current accessibility tree: call get_window_state with include_text=true first");
  }
}

function stateContent(state, note) {
  const content = [];
  const head = [note, `window ${state.window.id} "${state.window.title ?? ""}" (${state.window.app})`].filter(Boolean);
  for (const s of state.screenshots) {
    head.push(`screenshot ${s.id}: ${s.width ?? "?"}x${s.height ?? "?"} at (${s.originX ?? 0},${s.originY ?? 0}) z=${s.zIndex}`);
  }
  content.push({ type: "text", text: head.join("\n") });
  for (const s of state.screenshots) {
    const m = /^data:([^;]+);base64,(.*)$/s.exec(s.url);
    if (m) content.push({ type: "image", mimeType: m[1], data: m[2] });
  }
  const a = state.accessibility;
  if (a) {
    const parts = [a.tree];
    if (a.focused_element) parts.push(`focused: ${a.focused_element}`);
    if (a.selected_text) parts.push(`selected text: ${a.selected_text}`);
    if (a.selected_elements?.length) parts.push(`selected: ${a.selected_elements.join(" | ")}`);
    if (a.document_text) parts.push(`document text:\n${a.document_text}`);
    content.push({ type: "text", text: parts.join("\n") });
  }
  return content;
}

// After an input action, wait and return a fresh observation unless the caller opts out.
async function afterAction(window, args, what) {
  if (args.observe === false) return [{ type: "text", text: `${what}: done` }];
  await new Promise((r) => setTimeout(r, clampWait(args.wait_ms)));
  const state = await observe(window, { screenshot: true, text: !!args.include_text });
  return stateContent(state, `${what}: done; state after the action:`);
}

function clampWait(ms) {
  return Number.isFinite(ms) ? Math.min(Math.max(ms, 0), 10_000) : 800;
}

async function withGeometryRetry(window, run) {
  try {
    return await run(await screenshotIdFor(window));
  } catch (e) {
    if (!/geometry is unavailable|screenshot/i.test(String(e?.message))) throw e;
    const fresh = (await observe(window, { screenshot: true })).screenshots[0]?.id;
    return run(fresh);
  }
}

// ---- tools --------------------------------------------------------------------------------------
const W = { window_id: { type: "integer", description: "Window id from list_windows or list_apps" } };
const OBS = {
  observe: { type: "boolean", description: "Return a screenshot after the action (default true)" },
  include_text: { type: "boolean", description: "Also return the accessibility tree after the action" },
  wait_ms: { type: "integer", description: "Wait before the observation, 0-10000 ms (default 800)" },
};
const obj = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });

const TOOLS = [
  {
    name: "list_windows",
    description: "List open top-level windows that can be targeted (id, app, title).",
    inputSchema: obj({}),
    run: async () => text(remember(await sky().list_windows())),
  },
  {
    name: "list_apps",
    description: "List installed and running apps with their open windows. Use running_only to shorten the list.",
    inputSchema: obj({ running_only: { type: "boolean" } }),
    run: async (a) => {
      const apps = (await sky().list_apps()).filter((x) => !a.running_only || x.isRunning || x.windows.length);
      for (const x of apps) remember(x.windows);
      return text(apps.map((x) => ({ id: x.id, name: x.displayName, running: x.isRunning, windows: x.windows })));
    },
  },
  {
    name: "launch_app",
    description: "Launch an app by id from list_apps, or by an explicit .exe path. Then call list_windows.",
    inputSchema: obj({ app: { type: "string" } }, ["app"]),
    run: async (a) => {
      await sky().launch_app({ app: a.app });
      return text(`launched ${a.app}`);
    },
  },
  {
    name: "get_window_state",
    description:
      "Observe one window: a screenshot (default) and/or the accessibility tree with element indexes. " +
      "Indexes, screenshot ids and coordinates are valid only until the next change.",
    inputSchema: obj(
      {
        ...W,
        include_screenshot: { type: "boolean", description: "Default true" },
        include_text: { type: "boolean", description: "Accessibility tree with element indexes; default false" },
      },
      ["window_id"],
    ),
    run: async (a) => {
      const w = await windowById(a.window_id);
      const shot = a.include_screenshot !== false;
      const txt = !!a.include_text;
      if (!shot && !txt) throw new Error("request include_screenshot, include_text, or both");
      return stateContent(await observe(w, { screenshot: shot, text: txt }));
    },
  },
  {
    name: "click",
    description:
      "Click an element by element_index (from the latest include_text observation) or at window-relative x,y " +
      "(pixels of the latest screenshot).",
    inputSchema: obj(
      {
        ...W,
        element_index: { type: "integer" },
        x: { type: "number" },
        y: { type: "number" },
        click_count: { type: "integer", description: "Default 1; 2 for a double click" },
        mouse_button: { type: "string", enum: ["left", "right", "middle"] },
        ...OBS,
      },
      ["window_id"],
    ),
    run: async (a) => {
      const w = await windowById(a.window_id);
      const base = { window: w, click_count: a.click_count ?? 1, mouse_button: a.mouse_button ?? "left" };
      if (a.element_index != null) {
        requireTextObservation(w);
        if (!observed.get(w.id)?.screenshotId) {
          // A new screenshot could change the indexes, so do not take one silently here.
          throw new Error("element clicks need a screenshot too: call get_window_state with include_text=true and include_screenshot=true");
        }
        await sky().click({ ...base, element_index: a.element_index });
      } else {
        if (!Number.isFinite(a.x) || !Number.isFinite(a.y)) throw new Error("give element_index, or both x and y");
        await withGeometryRetry(w, (screenshotId) => sky().click({ ...base, screenshotId, x: a.x, y: a.y }));
      }
      return afterAction(w, a, "click");
    },
  },
  {
    name: "type_text",
    description: "Type literal text into the focused element of the window. Check focus first; use press_key for Enter, Tab and shortcuts.",
    inputSchema: obj({ ...W, text: { type: "string" }, ...OBS }, ["window_id", "text"]),
    run: async (a) => {
      const w = await windowById(a.window_id);
      await sky().type_text({ window: w, text: a.text });
      return afterAction(w, a, "type_text");
    },
  },
  {
    name: "press_key",
    description:
      "Press a key or a '+'-separated chord with X keysym-style names, e.g. Return, Tab, Escape, Control_L+a, " +
      "Control_L+Shift_L+period. The Windows key is not allowed.",
    inputSchema: obj({ ...W, key: { type: "string" }, ...OBS }, ["window_id", "key"]),
    run: async (a) => {
      if (/(^|\+)\s*(meta|win|windows|super|cmd|command|os)\s*($|\+)/i.test(a.key)) throw new Error("The Windows key is not allowed");
      const w = await windowById(a.window_id);
      await sky().press_key({ window: w, key: a.key });
      return afterAction(w, a, "press_key");
    },
  },
  {
    name: "scroll",
    description: "Scroll from window-relative x,y. Positive scroll_y scrolls down, negative up; scroll_x likewise right/left.",
    inputSchema: obj(
      { ...W, x: { type: "number" }, y: { type: "number" }, scroll_x: { type: "number" }, scroll_y: { type: "number" }, ...OBS },
      ["window_id", "x", "y"],
    ),
    run: async (a) => {
      const w = await windowById(a.window_id);
      await withGeometryRetry(w, (screenshotId) =>
        sky().scroll({ window: w, screenshotId, x: a.x, y: a.y, scrollX: a.scroll_x ?? 0, scrollY: a.scroll_y ?? 0 }),
      );
      return afterAction(w, a, "scroll");
    },
  },
  {
    name: "drag",
    description: "Drag from one window-relative point to another.",
    inputSchema: obj(
      { ...W, from_x: { type: "number" }, from_y: { type: "number" }, to_x: { type: "number" }, to_y: { type: "number" }, ...OBS },
      ["window_id", "from_x", "from_y", "to_x", "to_y"],
    ),
    run: async (a) => {
      const w = await windowById(a.window_id);
      await withGeometryRetry(w, (screenshotId) =>
        sky().drag({ window: w, screenshotId, from_x: a.from_x, from_y: a.from_y, to_x: a.to_x, to_y: a.to_y }),
      );
      return afterAction(w, a, "drag");
    },
  },
  {
    name: "set_value",
    description: "Replace the value of an editable element by element_index (from the latest include_text observation).",
    inputSchema: obj({ ...W, element_index: { type: "integer" }, value: { type: "string" }, ...OBS }, ["window_id", "element_index", "value"]),
    run: async (a) => {
      const w = await windowById(a.window_id);
      requireTextObservation(w);
      await sky().set_value({ window: w, element_index: a.element_index, value: a.value });
      return afterAction(w, a, "set_value");
    },
  },
  {
    name: "perform_secondary_action",
    description: "Run a secondary accessibility action listed in the tree (e.g. Expand, Collapse, Scroll Down) on an element.",
    inputSchema: obj({ ...W, element_index: { type: "integer" }, action: { type: "string" }, ...OBS }, ["window_id", "element_index", "action"]),
    run: async (a) => {
      const w = await windowById(a.window_id);
      requireTextObservation(w);
      await sky().perform_secondary_action({ window: w, element_index: a.element_index, action: a.action });
      return afterAction(w, a, "perform_secondary_action");
    },
  },
  {
    name: "activate_window",
    description: "Bring a window to the foreground. Input tools do this themselves; use it to recover when input lands on another window.",
    inputSchema: obj({ ...W }, ["window_id"]),
    run: async (a) => {
      const w = await windowById(a.window_id);
      await sky().activate_window({ window: w });
      return text(`activated ${w.id}`);
    },
  },
  {
    name: "allowed_apps",
    description:
      "List the apps the user chose to always allow, and the ones allowed until Claude Code closes. With remove, " +
      "forget those apps (only when the user asks). Apps cannot be added here: the user allows an app in the dialog " +
      "that appears the first time a tool touches it.",
    inputSchema: obj({ remove: { type: "array", items: { type: "string" }, description: "exe names to forget, e.g. videoeditor.exe" } }),
    run: async (a) => {
      const remove = new Set((a.remove ?? []).map((x) => String(x).toLowerCase()));
      if (remove.size) {
        for (const x of remove) sessionApps.delete(x);
        saveAllowedApps(allowedApps().filter((x) => !remove.has(x)));
      }
      return text({ always: allowedApps(), until_claude_code_closes: [...sessionApps], stored_in: ALLOWED_FILE ?? "(memory only)" });
    },
  },
  {
    name: "end_session",
    description: "Close the computer-use helper now (it also closes after 2 idle minutes or when the turn ends).",
    inputSchema: obj({}),
    run: async () => {
      await closeClient("end_session");
      return text("helper closed");
    },
  },
];

function text(value) {
  return [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 1) }];
}

const APPROVAL_HINT = {
  "always-refused": "APP is always refused (terminals, agent apps, the lock screen). Do not retry.",
  declined: "The user declined APP in the permission dialog. Do not retry; tell the user and ask what to do.",
  dismissed: "The permission dialog for APP was closed without an answer. Ask the user whether to try again.",
  "no-answer": `Nobody answered the permission dialog for APP within ${DIALOG_TIMEOUT_MS / 60_000} minutes. Ask the user whether to try again.`,
  "dialog-failed": "The permission dialog for APP could not be shown (DETAIL). Tell the user; do not retry.",
};

// ---- MCP over stdio -----------------------------------------------------------------------------
let clientCanElicit = false;
const pendingRequests = new Map(); // id of our request to the client -> { resolve, reject }
let nextRequestId = 1;

class DialogTimeout extends Error {}

// Send a request to the client (Claude Code) and wait for its response, at most timeoutMs.
function request(method, params, timeoutMs) {
  const id = `sky-${nextRequestId++}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new DialogTimeout(`no response to ${method} within ${timeoutMs} ms`));
    }, timeoutMs);
    const settle = (fn) => (value) => (clearTimeout(timer), fn(value));
    pendingRequests.set(id, { resolve: settle(resolve), reject: settle(reject) });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

let chain = Promise.resolve();
function queue(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

async function callTool(name, args) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { content: text(`unknown tool ${name}`), isError: true };
  // lastApproval is reset and read inside the queued run, so overlapping calls keep their own result.
  const { content, error, approval } = await queue(async () => {
    lastApproval = null;
    try {
      return { content: await tool.run(args ?? {}), approval: lastApproval };
    } catch (e) {
      return { error: e, approval: lastApproval };
    }
  });
  touchIdle();
  if (!error) return { content: approval?.note ? [...text(approval.note), ...content] : content };
  let message = error?.message ?? String(error);
  if (approval && !approval.ok) {
    message += `\n${APPROVAL_HINT[approval.why].replaceAll("APP", approval.app).replace("DETAIL", () => approval.detail ?? "")}`;
  }
  return { content: text(`ERROR: ${message}`), isError: true };
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // notification
  if (method === undefined) {
    // A response to one of our requests.
    const p = pendingRequests.get(id);
    pendingRequests.delete(id);
    if (msg.error) p?.reject(new Error(msg.error.message));
    else p?.resolve(msg.result);
    return;
  }
  try {
    if (method === "initialize") {
      clientCanElicit = !!params?.capabilities?.elicitation;
      log(`client ${params?.clientInfo?.name ?? "?"}: elicitation ${clientCanElicit ? "yes" : "no"}; allowed apps in ${ALLOWED_FILE ?? "memory only"}`);
      return send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: SERVER,
          instructions: "Windows computer use through the Codex app's sky runtime. Read the do skill (/codex-hands:do) before using these tools.",
        },
      });
    }
    if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
    if (method === "tools/list") {
      return send({ jsonrpc: "2.0", id, result: { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } });
    }
    if (method === "tools/call") return send({ jsonrpc: "2.0", id, result: await callTool(params?.name, params?.arguments) });
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
  } catch (e) {
    send({ jsonrpc: "2.0", id, error: { code: -32603, message: e?.message ?? String(e) } });
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
  }
  handle(msg);
}).on("close", async () => {
  await closeClient("stdin closed");
  process.exit(0);
});

log(`ready; @oai/sky ${skyVersion}`);
