import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const codexCommand = process.platform === "win32" ? "codex.cmd" : "codex";
const checks = [];

checks.push({
  name: "Node.js 20以上",
  ok: Number(process.versions.node.split(".")[0]) >= 20,
  detail: `v${process.versions.node}`
});

const codexVersion = spawnSync(codexCommand, ["--version"], { encoding: "utf8" });
checks.push({
  name: "Codex CLI",
  ok: codexVersion.status === 0,
  detail: (codexVersion.stdout || codexVersion.stderr || "未検出").trim()
});

const loginStatus = spawnSync(codexCommand, ["login", "status"], { encoding: "utf8" });
checks.push({
  name: "Codexログイン",
  ok: loginStatus.status === 0,
  detail: (loginStatus.stdout || loginStatus.stderr || "未ログイン").trim()
});

const skillPath = join(homedir(), ".codex", "skills", ".system", "imagegen", "SKILL.md");
checks.push({
  name: "Codex画像生成スキル",
  ok: existsSync(skillPath),
  detail: existsSync(skillPath) ? skillPath : "imagegenスキルが見つかりません"
});

for (const check of checks) {
  console.log(`${check.ok ? "OK" : "NG"}  ${check.name}: ${check.detail}`);
}

if (checks.some(check => !check.ok)) {
  console.error("\n不足項目を解消してから npm start を実行してください。");
  process.exitCode = 1;
} else {
  console.log("\n起動準備は完了しています。npm start を実行してください。");
}
