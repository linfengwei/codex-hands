# codex-hands

[English](README.md) | 中文

把 Codex 的 computer use 借給 Windows 上的 Claude Code。裝了這個 plugin，Claude 就能看桌面 app 的視窗（截圖和
accessibility tree），並在視窗裡點擊、打字、按鍵、捲動和拖曳。

Repository：https://github.com/linfengwei/codex-hands。這是個人專案，不是 Anthropic 或 OpenAI 做的，他們也不提供支援。

- 一步一步的安裝和使用說明：[docs/how-to-use.zh-TW.html](docs/how-to-use.zh-TW.html)（英文版：[docs/how-to-use.html](docs/how-to-use.html)），用瀏覽器打開。
- 15 秒的介紹影片（英文）：[docs/promo/codex-hands-promo-720p.mp4](docs/promo/codex-hands-promo-720p.mp4)。

## 給誰用

用 Claude Code（例如 Team 方案）、但 Claude Code 在 Windows 上沒辦法用 computer use 的人。裝了這個 plugin，
就能叫 Claude 操作 Windows 上的 app：

```
/codex-hands:do 在 Video Editor 加一段影片
```

## 怎麼做到的

它沒有自己的自動化引擎。它使用**已安裝的 Codex app**（Microsoft Store 套件 `OpenAI.Codex`）裡的
`@oai/sky` 和 `codex-computer-use.exe`，並在那個 app 自己的 `node.exe` 上執行。不從 app 裡複製任何東西。
Codex app 只要裝著就好，不用開，也不用登入。

```
Claude Code ── MCP tools ──> server.mjs (on the Codex app's node.exe)
                                │ import @oai/sky (direct helper mode, no node_repl)
                                └─> codex-computer-use.exe ──> SendInput / UI Automation / Graphics.Capture
```

## 內容

| 路徑 | 是什麼 |
| --- | --- |
| `.claude-plugin/marketplace.json` | 讓這個 repo 可以加成本機的 plugin 市集 |
| `plugins/codex-hands/.mcp.json` | 啟動 MCP server |
| `plugins/codex-hands/server/launch.mjs` | 找到 Codex app，用它的 `node.exe` 啟動 `server.mjs` |
| `plugins/codex-hands/server/server.mjs` | MCP server：包住 sky Windows client 的 14 個固定工具，和允許 app 的對話框 |
| `plugins/codex-hands/server/turn-ended.mjs` | Stop hook：一輪結束時關掉 helper |
| `plugins/codex-hands/skills/do/SKILL.md` | skill `/codex-hands:do`：Claude 使用這些工具的方法（流程、出錯處理、安全） |
| `test/smoke.mjs` | 啟動 server，用 JSON-RPC 呼叫它 |
| `test/call.mjs` | 對 server 執行一串工具呼叫，開發用 |
| `docs/how-to-use.zh-TW.html`、`docs/how-to-use.html` | 給一般使用者的說明（中文、英文）：安裝、使用、遇到問題，每段都是可以貼給 Claude Code 的話 |
| `docs/promo/` | 介紹影片（MP4）、它的動畫頁 `promo.html`、合成配樂的 `music.mjs` 和產生影片的 `render.mjs` |

## 需求

- Windows 11 x64，已安裝 Codex app（測試過 `OpenAI.Codex` 26.1016.6573.0、`@oai/sky` 0.7.12）。
- `PATH` 上有 Node.js（只給 `launch.mjs` 和 Stop hook 用；server 本身跑在 Codex app 的 Node 上）。
- 支援 plugin 的 Claude Code（測試過 2.1.138）：終端機的 `claude` 或 Claude 桌面 app 的 Code 分頁都可以。

## 安裝

在終端機執行：

```
claude plugin marketplace add linfengwei/codex-hands
claude plugin install codex-hands@codex-hands
```

關掉 Claude Code 再打開。不想打指令的話，照 [docs/how-to-use.zh-TW.html](docs/how-to-use.zh-TW.html) 的 ① 把一段話貼給 Claude Code，它會幫你裝。

更新到 GitHub 上最新的版本：

```
claude plugin marketplace update codex-hands
claude plugin update codex-hands@codex-hands
```

開發時，先 clone repository，再只在這一個 session 載入 plugin：

```
git clone https://github.com/linfengwei/codex-hands
claude --plugin-dir codex-hands/plugins/codex-hands
```

## 使用

在 Claude Code 打斜線指令，後面接要做的事：

```
/codex-hands:do 截一張 Video Editor 現在的畫面給我看
```

前綴 `codex-hands:` 是 Claude Code 對 plugin skill 的命名規則，不能省略。不打斜線、直接用一般的話說
也可以，Claude 通常會自己載入這個 skill，但不保證每次都會。helper 執行時，畫面上會有「Codex 正在使用你的電腦」
的提示；隨時按 Esc 就停。

## 允許一個 app

helper 碰一個 app 之前會先問，由使用者回答；Claude 不能回答，也不能用別的方法加入 app。

1. server 先用 MCP elicitation 請 Claude Code 跳出對話框。
2. Claude Code 跳不出來時，server 改跳一個 Windows 對話框（`powershell.exe` 的 WinForms 視窗），選項一樣。
   跳不出來是指：client 沒有 elicitation、請求失敗，或在 1 秒內就回「拒絕」或「取消」（人不可能這麼快）。
   Claude 桌面 app 的 Code 分頁就是這樣：它用 print 模式跑 Claude Code，桌面 app 收到 elicitation 後
   約 10 ms 就回 decline，畫面上什麼都沒有（Claude Code 2.1.138）。
3. 3 分鐘內沒回答，當作不允許。

兩種對話框都跟著 Windows 的顯示語言：`zh-*` 是中文，其他都是英文。設定 `CODEX_HANDS_LANG` 為 `zh` 或 `en` 可以指定語言。

| 使用者選 | 結果 |
| --- | --- |
| 一律允許 | 記在 Claude Code 給 plugin 的資料夾：`${CLAUDE_PLUGIN_DATA}/allowed-apps.json`，以後不再問 |
| 只允許到 Claude Code 關掉 | 只記在 server 的記憶體 |
| 拒絕（或關掉對話框） | 這次的操作失敗，不記住；下次碰這個 app 會再問 |

終端機（包括 `powershell.exe`，所以 Claude 也不能用這個 plugin 點 Windows 對話框）、Codex、ChatGPT 和
Claude app，以及鎖定畫面，一律拒絕，不會跳對話框。
`allowed_apps` 工具列出已允許的 app；使用者要求時，Claude 可以用它移除 app。
不再讀 Codex 的 `~/.codex/computer-use/config.toml`。

## 測試

```
node test/smoke.mjs                 # 啟動、列出工具、列出視窗
node test/smoke.mjs "Video Editor"  # 另外觀察 title 完全相同的視窗（只讀）；允許的對話框改在終端機問你
node test/call.mjs '[{"name":"click","arguments":{"window_title":"Video Editor","x":38,"y":700}}]'
```

測試 client 用 `CODEX_HANDS_TEST_ANSWER`（always、session、decline、cancel）回答對話框，`CODEX_HANDS_TEST_DELAY_MS` 讓它晚一點回答。

## 限制

- `@oai/sky` 和 helper 是 Codex app 的私有部分。app 更新可能改變它們；sky 版本不是測試過的版本時，
  server 會記一個警告。分享給別人之前，先確認授權條款。
- helper 閒置 2 分鐘和一輪結束時會關掉；下一次呼叫會開新的。
- 用元件編號之前，最後一次改變之後要有一次同時帶 `include_text` 和 `include_screenshot` 的
  `get_window_state`。
