// Finds node.exe and @oai/sky inside the installed Codex app. launch.mjs uses it at start; server.mjs uses it
// again when the folder it started with is gone (the Codex app updates itself and removes the old version's folder).
// CODEX_HANDS_CODEX_DIR overrides the app's install folder (the folder that contains "app\resources").
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export function findCodexApp() {
  let appDir = process.env.CODEX_HANDS_CODEX_DIR?.trim();
  if (!appDir) {
    try {
      appDir = execFileSync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", "(Get-AppxPackage -Name 'OpenAI.Codex' | Select-Object -First 1).InstallLocation"],
        { encoding: "utf8", windowsHide: true },
      ).trim();
    } catch (e) {
      throw new Error(`could not query the Codex app package: ${e.message}`);
    }
  }
  if (!appDir) throw new Error("The Codex app (OpenAI.Codex) is not installed for this Windows account. Install it from https://chatgpt.com/codex.");

  const bin = join(appDir, "app", "resources", "cua_node", "bin");
  const node = join(bin, "node.exe");
  const skyDir = join(bin, "node_modules", "@oai", "sky");
  if (!existsSync(node)) throw new Error(`no node.exe in the Codex app: ${node}`);
  if (!existsSync(join(skyDir, "package.json"))) throw new Error(`no @oai/sky in the Codex app: ${skyDir}`);
  return { appDir, node, skyDir };
}
