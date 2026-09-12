// 插件中文本地化（2026-09-12）的护栏测试：资源键非空、无英文 UI 残留、
// 错误码 → 可操作提示映射正确、面板模型的 hint 通道生效。
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SnapshotPanelModel } from "../src/snapshot-panel-model.js";
import { STRINGS } from "../src/strings.js";

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function dirname(path: string): string {
  return resolve(path, "..");
}

function walkStrings(node: unknown, path: string, found: Array<{ path: string; value: string }>): void {
  if (typeof node === "string") {
    found.push({ path, value: node });
    return;
  }
  if (typeof node === "function") return; // 模板函数按引用抽样验证，不在遍历中调用
  if (typeof node === "object" && node !== null) {
    for (const [key, value] of Object.entries(node)) {
      walkStrings(value, `${path}.${key}`, found);
    }
  }
}

describe("zh-CN 资源模块（中文本地化护栏）", () => {
  it("每个字符串资源都非空", () => {
    const found: Array<{ path: string; value: string }> = [];
    walkStrings(STRINGS, "STRINGS", found);
    expect(found.length).toBeGreaterThan(40);
    for (const entry of found) {
      expect(entry.value.trim(), entry.path).not.toBe("");
    }
  });

  it("模板函数产出非空中文文案（抽样）", () => {
    expect(STRINGS.statusBar.scanningActive(3)).toContain("3");
    expect(STRINGS.panel.complete(1, 2, 3, 4)).toContain("快照完成");
    expect(STRINGS.settings.consoleEnabled("http://127.0.0.1:1/")).toContain("127.0.0.1");
    expect(STRINGS.faults.pathMustBeAbsolute("日志")).toContain("日志");
    expect(STRINGS.view.visibilityScopeNote("scope-x")).toContain("scope-x");
  });

  it("视图与面板模型源文件不再包含已抽取的英文 UI 文案", () => {
    const banned = [
      "Create snapshot",
      "Snapshot running",
      "No snapshot run in this session yet",
      "Last result",
      "Scanning:",
      "Encrypting:",
      "Snapshot complete:",
      "Snapshot failed:",
      "EKD snapshot: idle",
      "Open report file",
      "Settings cannot change while an EKD operation is active"
    ];
    for (const file of ["snapshot-view.ts", "snapshot-panel-model.ts", "main.ts"]) {
      const source = readFileSync(join(PLUGIN_ROOT, "src", file), "utf8");
      for (const literal of banned) {
        expect(source.includes(literal), `${file} 残留英文文案: ${literal}`).toBe(false);
      }
    }
  });

  it("常见归一化错误码都有可操作提示，未知码走通用提示", () => {
    for (const code of ["UNSUPPORTED_FILES_FOUND", "LOG_WRITE_FAILED", "RECOVERY_FILE_WRITE_FAILED", "CASE_COLLISION", "NON_EMPTY_TARGET"]) {
      const hint = STRINGS.errors.hintFor(code);
      expect(hint, code).not.toBe(STRINGS.errors.genericHint);
      expect(hint.length).toBeGreaterThan(8);
    }
    expect(STRINGS.errors.hintFor("TOTALLY_UNKNOWN_CODE")).toBe(STRINGS.errors.genericHint);
    expect(STRINGS.errors.hintFor(undefined)).toBe(STRINGS.errors.genericHint);
  });

  it("面板模型的 hint 通道把错误提示透传到 render", () => {
    const model = new SnapshotPanelModel();
    const error = new Error("快照在 preflight 失败（LOG_WRITE_FAILED）；未导出通过报告。");
    model.onError(error, STRINGS.errors.hintFor("LOG_WRITE_FAILED"));
    const render = model.render;
    expect(render.phase).toBe("failed");
    expect(render.errorHint).toContain("独占创建");
    expect(render.progressLines.at(-1)).toContain("快照失败：");
  });
});
