// Stop hook: mark that the turn ended, so a running server closes its computer-use helper.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = join(tmpdir(), "codex-hands");
try {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "turn-ended"), String(Date.now()));
} catch {
  // A missed signal only delays the close until the idle timeout.
}
