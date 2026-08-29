import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { TextEncoder } from "node:util";
import { fileURLToPath } from "node:url";

const VERSION = "1.0.0";
const SEED = "ekd-tiny-v1";
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SELF_PATH = fileURLToPath(import.meta.url);

const text = (value) => new TextEncoder().encode(value);
const base64 = (value) => new Uint8Array(Buffer.from(value, "base64"));

const DEFINITIONS = Object.freeze([
  {
    relative_path: "README.md",
    bytes: text("---\ntitle: Tiny Vault\n---\n# Tiny Vault\n\n[[notes/links]]\n\n中文段落。\n\n![[attachments/pixel.png]]\n"),
    content_class: "markdown",
    features: ["frontmatter", "heading", "wikilink", "chinese-content", "attachment-reference"]
  },
  { relative_path: "attachments/anim.gif", bytes: base64("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="), content_class: "image", features: [] },
  { relative_path: "attachments/diagram.jpeg", bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), content_class: "image", features: [] },
  { relative_path: "attachments/document.pdf", bytes: text("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n"), content_class: "pdf", features: [] },
  { relative_path: "attachments/image.webp", bytes: text("RIFF\u0010\u0000\u0000\u0000WEBPVP8 \u0004\u0000\u0000\u0000tiny"), content_class: "image", features: [] },
  { relative_path: "attachments/photo.jpg", bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0xff, 0xd9]), content_class: "image", features: [] },
  { relative_path: "attachments/pixel.png", bytes: base64("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2iVQAAAAASUVORK5CYII="), content_class: "image", features: [] },
  { relative_path: "canvas/board.canvas", bytes: text("{\"nodes\":[],\"edges\":[]}"), content_class: "canvas", features: [] },
  { relative_path: "code/header.h", bytes: text("#pragma once\nint add(int left, int right);\n"), content_class: "c", features: [] },
  { relative_path: "code/header.hpp", bytes: text("#pragma once\nnamespace tiny { int value(); }\n"), content_class: "c", features: [] },
  { relative_path: "code/main.c", bytes: text("#include \"header.h\"\nint add(int left, int right) { return left + right; }\n"), content_class: "c", features: [] },
  { relative_path: "code/main.cpp", bytes: text("#include \"header.hpp\"\nint tiny::value() { return 7; }\n"), content_class: "c", features: [] },
  { relative_path: "code/tool.py", bytes: text("def add(left: int, right: int) -> int:\n    return left + right\n"), content_class: "python", features: [] },
  { relative_path: "deep/a/b/c/deep.md", bytes: text("# Deep\n"), content_class: "markdown", features: ["heading", "deep-path"] },
  { relative_path: "notes/attachments.md", bytes: text("# Attachments\n\n![[attachments/document.pdf]]\n"), content_class: "markdown", features: ["heading", "attachment-reference"] },
  { relative_path: "notes/empty.md", bytes: new Uint8Array(), content_class: "markdown", features: ["empty"] },
  { relative_path: "notes/links.md", bytes: text("# Links\n\n[[README]]\n"), content_class: "markdown", features: ["heading", "wikilink"] },
  { relative_path: "notes/second.md", bytes: text("# Second note\n\nPlain deterministic content.\n"), content_class: "markdown", features: ["heading"] },
  { relative_path: "notes/介绍.md", bytes: text("# 介绍\n\n这是固定的中文内容。\n"), content_class: "markdown", features: ["heading", "chinese-content"] },
  { relative_path: "中文/学习笔记.md", bytes: text("# 学习笔记\n\n[[README]]\n"), content_class: "markdown", features: ["heading", "wikilink", "chinese-content", "chinese-path"] }
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function rawUtf8Order(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function normalizeRepositoryPath(path) {
  return relative(REPOSITORY_ROOT, path).split("\\").join("/");
}

async function existingFiles(root) {
  try {
    const values = [];
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const path = resolve(root, entry.name);
      if (entry.isDirectory()) values.push(...await existingFiles(path));
      else values.push(path);
    }
    return values;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

function currentCommit() {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8"
  }).trim();
}

export async function generateTinyFixture(outputRoot, gitCommit = currentCommit()) {
  if (!/^[0-9a-f]{40}$/u.test(gitCommit)) throw new Error("--git-commit must be exactly 40 lowercase hex characters.");
  const resolvedOutput = resolve(outputRoot);
  const vaultRoot = resolve(resolvedOutput, "vault");
  const expectedPaths = new Set([
    resolve(resolvedOutput, "fixture-manifest-v1.json"),
    ...DEFINITIONS.map((definition) => resolve(vaultRoot, ...definition.relative_path.split("/")))
  ]);
  const unexpected = (await existingFiles(resolvedOutput)).filter((path) => !expectedPaths.has(path));
  if (unexpected.length > 0) throw new Error(`Fixture output contains unexpected files: ${unexpected.join(", ")}`);

  const sorted = [...DEFINITIONS].sort((left, right) => rawUtf8Order(left.relative_path, right.relative_path));
  for (const definition of sorted) {
    const target = resolve(vaultRoot, ...definition.relative_path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, definition.bytes);
  }

  const entries = sorted.map((definition) => ({
    relative_path: definition.relative_path,
    size_bytes: definition.bytes.byteLength,
    sha256: sha256(definition.bytes),
    content_class: definition.content_class,
    features: definition.features
  }));
  const totalBytes = entries.reduce((sum, entry) => sum + entry.size_bytes, 0);
  const generatorBytes = new Uint8Array(await readFile(SELF_PATH));
  const manifest = {
    schema_version: "fixture-manifest-v1",
    fixture_id: "tiny-v1",
    profile: "tiny",
    seed: SEED,
    generator: {
      path: normalizeRepositoryPath(SELF_PATH),
      git_commit: gitCommit,
      sha256: sha256(generatorBytes),
      version: VERSION
    },
    totals: { files: entries.length, bytes: totalBytes },
    entries_sha256: sha256(text(JSON.stringify(entries))),
    entries,
    feature_coverage: [
      "markdown",
      "image",
      "pdf",
      "canvas",
      "c",
      "python",
      "empty-file",
      "chinese-path",
      "deep-path"
    ],
    constraints: {
      min_files: 20,
      max_files: 50,
      min_bytes: 0,
      max_bytes: 5242880,
      validation_errors: [],
      verdict: "pass"
    }
  };
  await mkdir(resolvedOutput, { recursive: true });
  await writeFile(resolve(resolvedOutput, "fixture-manifest-v1.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

function option(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

async function main(args) {
  const profile = option(args, "--profile");
  const output = option(args, "--output");
  const gitCommit = option(args, "--git-commit");
  if (profile !== "tiny") throw new Error("Only the authorized tiny profile is implemented in Phase 2.");
  if (output === undefined) throw new Error("--output is required.");
  const manifest = await generateTinyFixture(output, gitCommit);
  console.log(JSON.stringify({
    fixture_id: manifest.fixture_id,
    files: manifest.totals.files,
    bytes: manifest.totals.bytes,
    output: normalizeRepositoryPath(resolve(output))
  }));
}

if (resolve(process.argv[1] ?? "") === SELF_PATH) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
