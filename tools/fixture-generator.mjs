import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Buffer } from "node:buffer";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { TextEncoder } from "node:util";
import { fileURLToPath } from "node:url";

const VERSION = "1.1.0";
const SEED = "ekd-tiny-v1";
const REPRESENTATIVE_SEED = "ekd-representative-v1";
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

/**
 * ADR-0019 §2: deterministic representative-fixture planning. The path list and per-file
 * sizes are pure functions of (profile, seed); the same path distribution is used by both
 * representative profiles and only the content volume scales (baseline §60).
 */
const REPRESENTATIVE_PROFILES = Object.freeze({
  "representative-small": { files: 10000, minBytes: 127506842, maxBytes: 140928614 },
  "representative-large": { files: 10000, minBytes: 1020054733, maxBytes: 1127428915 }
});

function mulberry32(seedBytes) {
  let state = 0;
  for (let index = 0; index < 4; index += 1) {
    state = (state * 256 + (seedBytes[index] ?? 0)) >>> 0;
  }
  if (state === 0) state = 0x9e3779b9;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededRandom(pathKey, salt) {
  return mulberry32(createHash("sha256").update(`${REPRESENTATIVE_SEED}|${salt}|${pathKey}`).digest());
}

const REPRESENTATIVE_CLASSES = Object.freeze([
  { suffix: ".md", directory: "notes", prefix: "note", contentClass: "markdown", minBytes: 4096, maxBytes: 16384, weight: 4 },
  { suffix: ".png", directory: "assets", prefix: "img", contentClass: "image", minBytes: 32768, maxBytes: 262144, weight: 1 },
  { suffix: ".pdf", directory: "docs", prefix: "doc", contentClass: "pdf", minBytes: 65536, maxBytes: 524288, weight: 1 },
  { suffix: ".canvas", directory: "canvas", prefix: "board", contentClass: "canvas", minBytes: 1024, maxBytes: 4096, weight: 1 },
  { suffix: ".c", directory: "code", prefix: "src", contentClass: "c", minBytes: 1024, maxBytes: 4096, weight: 1 },
  { suffix: ".py", directory: "code", prefix: "tool", contentClass: "python", minBytes: 1024, maxBytes: 4096, weight: 1 },
  { suffix: ".md", directory: "中文/笔记", prefix: "笔记", contentClass: "markdown", minBytes: 2048, maxBytes: 8192, weight: 1 }
]);

function representativeClass(index) {
  const totalWeight = REPRESENTATIVE_CLASSES.reduce((sum, entry) => sum + entry.weight, 0);
  let pick = index % totalWeight;
  for (const entry of REPRESENTATIVE_CLASSES) {
    if (pick < entry.weight) return entry;
    pick -= entry.weight;
  }
  return REPRESENTATIVE_CLASSES[0];
}

export function buildRepresentativePlan(profile) {
  const bounds = REPRESENTATIVE_PROFILES[profile];
  if (bounds === undefined) throw new Error(`Unknown representative profile: ${profile}`);
  const entries = [];
  for (let index = 0; index < bounds.files; index += 1) {
    const entryClass = representativeClass(index);
    const padded = String(index).padStart(5, "0");
    const relativePath =
      index % 97 === 0
        ? `deep/a/b/c/${entryClass.directory}/${entryClass.prefix}-${padded}${entryClass.suffix}`
        : `${entryClass.directory}/${entryClass.prefix}-${padded}${entryClass.suffix}`;
    const random = seededRandom(relativePath, "size");
    const span = entryClass.maxBytes - entryClass.minBytes;
    entries.push({ relativePath, entryClass, size: entryClass.minBytes + Math.floor(random() * span) });
  }
  const rawTotal = entries.reduce((sum, entry) => sum + entry.size, 0);
  const targetTotal = Math.floor((bounds.minBytes + bounds.maxBytes) / 2);
  const scale = targetTotal / rawTotal;
  let adjustedTotal = 0;
  for (const entry of entries) {
    entry.size = Math.max(1, Math.round(entry.size * scale));
    adjustedTotal += entry.size;
  }
  // Deterministic drift correction: walk in order, nudging ±1 byte until inside the range.
  let cursor = 0;
  while (adjustedTotal > bounds.maxBytes && cursor < entries.length) {
    const entry = entries[cursor % entries.length];
    if (entry.size > 1) {
      entry.size -= 1;
      adjustedTotal -= 1;
    }
    cursor += 1;
  }
  while (adjustedTotal < bounds.minBytes && cursor < entries.length) {
    entries[cursor % entries.length].size += 1;
    adjustedTotal += 1;
    cursor += 1;
  }
  if (adjustedTotal < bounds.minBytes || adjustedTotal > bounds.maxBytes) {
    throw new Error(`Representative plan failed to land in the frozen byte range: ${adjustedTotal}`);
  }
  return { entries, totalBytes: adjustedTotal };
}

function representativeContent(relativePath, size, entryClass) {
  const buffer = Buffer.alloc(size);
  const random = seededRandom(relativePath, "content");
  const seedBytes = createHash("sha256").update(`${REPRESENTATIVE_SEED}|content|${relativePath}`).digest();
  buffer.set(seedBytes.subarray(0, Math.min(16, size)), 0);
  if (entryClass.contentClass === "markdown" || entryClass.contentClass === "python" || entryClass.contentClass === "c") {
    const words = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron".split(" ");
    let offset = 0;
    while (offset < size) {
      const word = words[Math.floor(random() * words.length)] ?? "x";
      const chunk = `${word} `;
      if (offset + chunk.length > size) break;
      buffer.write(chunk, offset, "latin1");
      offset += chunk.length;
    }
    if (offset < size) buffer.write("\n", Math.min(offset, size - 1), "latin1");
  } else {
    for (let index = 16; index < size; index += 1) {
      buffer[index] = Math.floor(random() * 256);
    }
  }
  return buffer;
}

async function generateRepresentativeFixture(profile, outputRoot, gitCommit = currentCommit()) {
  if (!/^[0-9a-f]{40}$/u.test(gitCommit)) throw new Error("--git-commit must be exactly 40 lowercase hex characters.");
  const resolvedOutput = resolve(outputRoot);
  const vaultRoot = resolve(resolvedOutput, "vault");
  const { entries: plan, totalBytes } = buildRepresentativePlan(profile);

  const sorted = [...plan].sort((left, right) => rawUtf8Order(left.relativePath, right.relativePath));
  const hashByPath = new Map();
  for (const entry of sorted) {
    const bytes = representativeContent(entry.relativePath, entry.size, entry.entryClass);
    hashByPath.set(entry.relativePath, sha256(bytes));
    const target = resolve(vaultRoot, ...entry.relativePath.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }

  const manifestEntries = sorted.map((entry) => ({
    relative_path: entry.relativePath,
    size_bytes: entry.size,
    sha256: hashByPath.get(entry.relativePath),
    content_class: entry.entryClass.contentClass,
    features: entry.relativePath.includes("中文") ? ["chinese-path"] : []
  }));
  const generatorBytes = new Uint8Array(await readFile(SELF_PATH));
  const manifest = {
    schema_version: "fixture-manifest-v1",
    fixture_id: `${profile}-v1`,
    profile,
    seed: REPRESENTATIVE_SEED,
    generator: {
      path: normalizeRepositoryPath(SELF_PATH),
      git_commit: gitCommit,
      sha256: sha256(generatorBytes),
      version: VERSION
    },
    totals: { files: manifestEntries.length, bytes: totalBytes },
    entries_sha256: sha256(text(JSON.stringify(manifestEntries))),
    entries: manifestEntries,
    feature_coverage: ["markdown", "image", "pdf", "canvas", "c", "python", "chinese-path", "deep-path"],
    constraints: {
      min_files: REPRESENTATIVE_PROFILES[profile].files,
      max_files: REPRESENTATIVE_PROFILES[profile].files,
      min_bytes: REPRESENTATIVE_PROFILES[profile].minBytes,
      max_bytes: REPRESENTATIVE_PROFILES[profile].maxBytes,
      validation_errors: [],
      verdict: "pass"
    }
  };
  await mkdir(resolvedOutput, { recursive: true });
  await writeFile(resolve(resolvedOutput, "fixture-manifest-v1.json"), `${JSON.stringify(manifest)}\n`, "utf8");
  return manifest;
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
  if (profile === undefined) throw new Error("--profile is required (tiny | representative-small | representative-large).");
  if (output === undefined) throw new Error("--output is required.");
  let manifest;
  if (profile === "tiny") {
    manifest = await generateTinyFixture(output, gitCommit);
  } else if (profile in REPRESENTATIVE_PROFILES) {
    manifest = await generateRepresentativeFixture(profile, output, gitCommit);
  } else {
    throw new Error(`Unknown profile: ${profile}`);
  }
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
