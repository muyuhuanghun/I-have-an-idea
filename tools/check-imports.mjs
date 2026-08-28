import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const roots = ["packages/core/src", "packages/crypto/src"];
const sourceExtensions = new Set([".ts", ".mts", ".cts", ".tsx"]);

// This is intentionally a small build gate. It checks module specifiers only;
// domain code must stay runtime-neutral and obtain platform behavior through ports.
const forbiddenSpecifier = /(?:from|import|require)\s*\(?\s*["'](?:node:)?(?:fs|path)(?:\/[^"']*)?["']|(?:from|import|require)\s*\(?\s*["'](?:electron|obsidian)["']|["'](?:https?:\/\/)?(?:localhost|127\.0\.0\.1)(?::\d+)?["']/u;

async function sourceFiles(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await sourceFiles(path));
    } else if (sourceExtensions.has(path.slice(path.lastIndexOf(".")))) {
      files.push(path);
    }
  }
  return files;
}

const violations = [];
for (const root of roots) {
  for (const file of await sourceFiles(root)) {
    const text = await readFile(file, "utf8");
    if (forbiddenSpecifier.test(text)) {
      violations.push(relative(process.cwd(), file));
    }
  }
}

if (violations.length > 0) {
  console.error("Forbidden runtime imports in shared core:");
  for (const file of violations) {
    console.error(`- ${file}`);
  }
  process.exitCode = 1;
} else {
  console.log("Shared-core import gate: PASS");
}
