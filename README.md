# codex-hands

English | [中文](README.zh-TW.md)

Codex's computer use, lent to Claude Code on Windows. With this plugin, Claude can see the windows of desktop apps
(screenshots and the accessibility tree) and click, type, press keys, scroll and drag in them.

Repository: https://github.com/linfengwei/codex-hands. This is a personal project; it is not made or supported by
Anthropic or OpenAI.

- Step-by-step install and usage guide: [docs/how-to-use.html](docs/how-to-use.html) (Chinese:
  [docs/how-to-use.zh-TW.html](docs/how-to-use.zh-TW.html)). Open it in a browser.
- 15-second intro video: [docs/promo/codex-hands-promo-720p.mp4](docs/promo/codex-hands-promo-720p.mp4).

## Who it is for

People who use Claude Code (for example on a Team plan) but cannot use computer use on Windows. With this plugin,
you ask Claude to operate a Windows app:

```
/codex-hands:do In Video Editor, add a clip to the timeline
```

## How it works

It has no automation engine of its own. It uses `@oai/sky` and `codex-computer-use.exe` from the **installed Codex
app** (Microsoft Store package `OpenAI.Codex`) and runs on that app's own `node.exe`. Nothing is copied out of the
app. The Codex app only has to be installed; it does not have to be open or signed in.

```
Claude Code ── MCP tools ──> server.mjs (on the Codex app's node.exe)
                                │ import @oai/sky (direct helper mode, no node_repl)
                                └─> codex-computer-use.exe ──> SendInput / UI Automation / Graphics.Capture
```

## Contents

| Path | What it is |
| --- | --- |
| `.claude-plugin/marketplace.json` | Makes this repo a local plugin marketplace |
| `plugins/codex-hands/.mcp.json` | Starts the MCP server |
| `plugins/codex-hands/server/launch.mjs` | Finds the Codex app and starts `server.mjs` on its `node.exe` |
| `plugins/codex-hands/server/server.mjs` | MCP server: 14 fixed tools around the sky Windows client, and the dialog that allows an app |
| `plugins/codex-hands/server/turn-ended.mjs` | Stop hook: closes the helper when a turn ends |
| `plugins/codex-hands/skills/do/SKILL.md` | Skill `/codex-hands:do`: how Claude uses the tools (workflow, recovery, safety) |
| `test/smoke.mjs` | Starts the server and calls it over JSON-RPC |
| `test/call.mjs` | Runs a sequence of tool calls against the server, for development |
| `docs/how-to-use.html`, `docs/how-to-use.zh-TW.html` | Guide for everyday users (English, Chinese): install, use, problems, with text to paste into Claude Code |
| `docs/promo/` | The intro video (MP4), its animation page `promo.html`, `music.mjs`, which synthesizes the soundtrack, and `render.mjs`, which makes the video |

## Requirements

- Windows 11 x64 with the Codex app installed (tested with `OpenAI.Codex` 26.1016.6573.0, `@oai/sky` 0.7.12).
- Node.js on `PATH` (only for `launch.mjs` and the Stop hook; the server runs on the Codex app's Node).
- Claude Code with plugin support (tested with 2.1.138): the terminal `claude` or the Code tab of the Claude
  desktop app.

## Install

Run in a terminal:

```
claude plugin marketplace add linfengwei/codex-hands
claude plugin install codex-hands@codex-hands
```

Close Claude Code and open it again. If you prefer not to type commands, paste the text from section ① of
[docs/how-to-use.html](docs/how-to-use.html) into Claude Code and it installs the plugin for you.

To update to the latest version on GitHub:

```
claude plugin marketplace update codex-hands
claude plugin update codex-hands@codex-hands
```

For development, clone the repository and load the plugin in one session only:

```
git clone https://github.com/linfengwei/codex-hands
claude --plugin-dir codex-hands/plugins/codex-hands
```

## Use

Type the slash command in Claude Code, followed by the task:

```
/codex-hands:do Take a screenshot of Video Editor and tell me which page it is on
```

The `codex-hands:` prefix is how Claude Code names plugin skills; it cannot be left out. You can also ask in
plain words without the slash command. Claude usually loads the skill by itself, but not every time. While the
helper runs, a "Codex is using your computer" notice is on the screen; press Esc at any time to stop it.

## Allowing an app

Before the helper touches an app, it asks. Only the user answers; Claude cannot answer, and there is no other way to
add an app.

1. The server first asks Claude Code to show a dialog (MCP elicitation).
2. When Claude Code cannot show it, the server opens a Windows dialog (a `powershell.exe` WinForms window) with the
   same choices. "Cannot show it" means: the client has no elicitation, the request fails, or the answer is
   "decline" or "cancel" in less than 1 second (no person answers that fast). This is what happens in the Code tab of
   the Claude desktop app: it runs Claude Code in print mode, and the desktop app declines the elicitation in about
   10 ms without showing anything (Claude Code 2.1.138).
3. No answer in 3 minutes counts as "not allowed".

Both dialogs follow the Windows display language: Chinese when it is `zh-*`, English otherwise. Set `CODEX_HANDS_LANG`
to `zh` or `en` to choose one.

| The user picks | Result |
| --- | --- |
| Always allow | Saved in the plugin's data folder from Claude Code: `${CLAUDE_PLUGIN_DATA}/allowed-apps.json`; not asked again |
| Allow until Claude Code closes | Kept in the server's memory only |
| Deny (or closes the dialog) | This action fails and nothing is saved; the next time it asks again |

Terminals (including `powershell.exe`, so Claude cannot use this plugin to click the Windows dialog), Codex, ChatGPT,
the Claude app and the lock screen are always refused, without a dialog.
The `allowed_apps` tool lists the allowed apps; when the user asks, Claude can use it to remove an app.
Codex's `~/.codex/computer-use/config.toml` is not read.

## Test

```
node test/smoke.mjs                 # start, list tools, list windows
node test/smoke.mjs "Video Editor"  # also observe the window with exactly this title (read-only); the dialog asks on the terminal
node test/call.mjs '[{"name":"click","arguments":{"window_title":"Video Editor","x":38,"y":700}}]'
```

The test clients answer the dialog from `CODEX_HANDS_TEST_ANSWER` (always, session, decline, cancel); `CODEX_HANDS_TEST_DELAY_MS`
makes them answer later.

## Limits

- `@oai/sky` and the helper are private parts of the Codex app. An app update can change them; the server logs a
  warning when the sky version is not a tested one. Check the license terms before you share this with others.
- The helper closes after 2 idle minutes and when a turn ends; the next call starts a new one.
- Before you use element numbers, the last change must be followed by a `get_window_state` with both
  `include_text` and `include_screenshot`.
