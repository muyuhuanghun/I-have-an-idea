import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Hex } from "./bytes.js";
import { SmokeContractError } from "./errors.js";
import { parseCryptoVectorManifest, parseCryptoVectorsFile, validateRequiredVectorCounts } from "./vectors.js";
import type { LoadedVectorSet } from "./types.js";

export interface LoadVectorOptions {
  readonly manifest_path?: string;
  readonly vectors_path?: string;
  readonly manifest_path_for_report?: string;
}

function contract(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new SmokeContractError(message);
  }
}

function findDefaultManifest(): string {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(process.cwd(), "fixtures/crypto-vectors/manifest.json"),
    resolve(process.cwd(), "../../fixtures/crypto-vectors/manifest.json"),
    resolve(moduleDirectory, "../../../fixtures/crypto-vectors/manifest.json"),
    resolve(moduleDirectory, "../../fixtures/crypto-vectors/manifest.json")
  ];
  const result = candidates.find((candidate) => existsSync(candidate));
  contract(result !== undefined, "Unable to locate fixtures/crypto-vectors/manifest.json.");
  return result;
}

function findVectorsPath(manifestPath: string, manifestVectorsPath: string, explicitPath: string | undefined): string {
  if (explicitPath !== undefined) {
    return resolve(explicitPath);
  }
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(dirname(manifestPath), manifestVectorsPath),
    resolve(process.cwd(), manifestVectorsPath),
    resolve(process.cwd(), "../../", manifestVectorsPath),
    resolve(moduleDirectory, "../../../", manifestVectorsPath)
  ];
  const result = candidates.find((candidate) => existsSync(candidate));
  contract(result !== undefined, `Unable to locate vector file ${manifestVectorsPath}.`);
  return result;
}

function reportPath(manifestPath: string, explicitPath: string | undefined): string {
  if (explicitPath !== undefined) {
    return explicitPath.replaceAll("\\", "/");
  }
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const roots = [resolve(process.cwd()), resolve(moduleDirectory, "../../.."), resolve(moduleDirectory, "../..")];
  for (const root of roots) {
    const value = relative(root, manifestPath);
    if (value !== "" && !value.startsWith(`..${sep}`) && !isAbsolute(value)) {
      return value.replaceAll("\\", "/");
    }
  }
  return manifestPath.replaceAll("\\", "/");
}

export async function loadCryptoVectors(options: LoadVectorOptions = {}): Promise<LoadedVectorSet> {
  const manifestPath = resolve(options.manifest_path ?? findDefaultManifest());
  const manifestBytes = new Uint8Array(await readFile(manifestPath));
  const manifest = parseCryptoVectorManifest(JSON.parse(new TextDecoder().decode(manifestBytes)) as unknown);
  const vectorsPath = findVectorsPath(manifestPath, manifest.vectors_path, options.vectors_path);
  const vectorsBytes = new Uint8Array(await readFile(vectorsPath));
  const vectorsFile = parseCryptoVectorsFile(JSON.parse(new TextDecoder().decode(vectorsBytes)) as unknown);

  const manifestSha256 = sha256Hex(manifestBytes);
  const vectorsSha256 = sha256Hex(vectorsBytes);
  contract(manifest.vectors_sha256 === vectorsSha256, "Crypto vector file hash does not match its manifest.");
  contract(manifest.suite_id === vectorsFile.suite.suite_id, "Crypto vector suite_id does not match its manifest.");
  contract(manifest.suite_name === vectorsFile.suite.name, "Crypto vector suite name does not match its manifest.");
  contract(manifest.aad_contract === vectorsFile.suite.aad_contract, "Crypto vector AAD contract does not match its manifest.");
  validateRequiredVectorCounts(vectorsFile.vectors);

  return {
    manifest,
    vectorsFile,
    vectors: vectorsFile.vectors,
    manifestPath,
    vectorsPath,
    manifestPathForReport: reportPath(manifestPath, options.manifest_path_for_report),
    manifestSha256,
    vectorsSha256
  };
}

