import {
  Notice,
  Platform,
  Plugin,
  PluginSettingTab,
  Setting,
  apiVersion,
  normalizePath,
  type App
} from "obsidian";
import type { CryptoProvider } from "@ekd/core";
import { NobleAes256Provider, NOBLE_CANDIDATE } from "@ekd/crypto/noble";
import { WebCryptoAes256Provider, WEBCRYPTO_CANDIDATE } from "@ekd/crypto/webcrypto";
import {
  base64UrlToBytes,
  bytesToBase64Url,
  createSmokeReport,
  createSmokeReportSchemaValidator,
  parseCryptoVectorManifest,
  parseCryptoVectorsFile,
  runSmokeVectors,
  sha256Hex,
  utf8Bytes,
  validateRequiredVectorCounts,
  type CandidateMetadata,
  type DeviceBinding,
  type EnvironmentManifest,
  type LoadedVectorSet,
  type SmokeExecutionOptions,
  type SmokeReportSchemaValidator
} from "@ekd/smoke";
import { createSnapshotV1, restoreSnapshotV1 } from "@ekd/core";
import { P0SettingTab, type P0Settings, DEFAULT_P0_SETTINGS } from "./p0.js";

interface BuildMeta {
  readonly schema_version: "phase1-build-meta-v1";
  readonly source_commit: string;
  readonly source_tree_state: "clean" | "dirty";
  readonly lockfile_sha256: string;
  readonly vector_manifest_sha256: string;
  readonly vectors_sha256: string;
  readonly bundle_sha256: string;
}

interface Phase1Settings {
  readonly androidDeviceModel: string;
  readonly androidOsVersion: string;
  readonly androidArchitecture: string;
}

interface StoredDeviceKey {
  readonly private_key_pkcs8_base64url: string;
  readonly public_key_spki_base64url: string;
}

type CandidateName = "webcrypto" | "noble";

const DEFAULT_SETTINGS: Phase1Settings = {
  androidDeviceModel: "",
  androidOsVersion: "",
  androidArchitecture: ""
};

function isBuildMeta(value: unknown): value is BuildMeta {
  if (typeof value !== "object" || value === null) return false;
  const meta = value as Record<string, unknown>;
  return meta.schema_version === "phase1-build-meta-v1" &&
    (meta.source_tree_state === "clean" || meta.source_tree_state === "dirty") &&
    typeof meta.source_commit === "string" && /^[0-9a-f]{40}$/.test(meta.source_commit) &&
    [meta.lockfile_sha256, meta.vector_manifest_sha256, meta.vectors_sha256, meta.bundle_sha256]
      .every((field) => typeof field === "string" && /^[0-9a-f]{64}$/.test(field));
}

function candidate(name: CandidateName): {
  readonly provider: CryptoProvider;
  readonly faults: NonNullable<SmokeExecutionOptions["random_source_faults"]>;
  readonly metadata: Omit<CandidateMetadata, "bundle_sha256">;
} {
  const create = (randomBytes?: (length: number) => Uint8Array): CryptoProvider => name === "webcrypto"
    ? new WebCryptoAes256Provider(randomBytes === undefined ? {} : { randomBytes })
    : new NobleAes256Provider(randomBytes === undefined ? {} : { randomBytes });
  const definition = name === "webcrypto" ? WEBCRYPTO_CANDIDATE : NOBLE_CANDIDATE;
  return {
    provider: create(),
    faults: {
      short_read: create((length) => new Uint8Array(length - 1)),
      failure: create(() => { throw new Error("injected random-source failure"); }),
      all_zero: create((length) => new Uint8Array(length))
    },
    metadata: {
      name: definition.name,
      version: definition.version,
      package_integrity: definition.packageIntegrity
    }
  };
}

function embeddedVectors(): LoadedVectorSet {
  const manifest = parseCryptoVectorManifest(JSON.parse(__VECTOR_MANIFEST_JSON__) as unknown);
  const vectorsFile = parseCryptoVectorsFile(JSON.parse(__VECTORS_JSON__) as unknown);
  const vectorsSha256 = sha256Hex(utf8Bytes(__VECTORS_JSON__));
  if (vectorsSha256 !== manifest.vectors_sha256) throw new Error("Embedded vectors do not match their manifest.");
  validateRequiredVectorCounts(vectorsFile.vectors);
  return {
    manifest,
    vectorsFile,
    vectors: vectorsFile.vectors,
    manifestPath: "embedded:fixtures/crypto-vectors/manifest.json",
    vectorsPath: "embedded:fixtures/crypto-vectors/vectors.json",
    manifestPathForReport: "fixtures/crypto-vectors/manifest.json",
    manifestSha256: sha256Hex(utf8Bytes(__VECTOR_MANIFEST_JSON__)),
    vectorsSha256
  };
}

function environmentManifest(meta: BuildMeta, items: readonly { readonly key: string; readonly value: string }[]): EnvironmentManifest {
  const values = [
    { key: "source_tree_state", value: meta.source_tree_state },
    { key: "test_scope", value: "phase1-crypto-portability-smoke" },
    { key: "network", value: "unused" },
    ...items
  ];
  return {
    recorded_at: new Date().toISOString(),
    items: values,
    items_sha256: sha256Hex(utf8Bytes(JSON.stringify(values)))
  };
}

async function createAndroidDeviceBinding(
  pluginId: string,
  runId: string,
  manifestSha: string,
  bundleSha: string
): Promise<{ readonly binding: DeviceBinding; readonly publicKey: string }> {
  const storageKey = `${pluginId}:phase1-smoke-device-key-v1`;
  let stored: StoredDeviceKey | undefined;
  const encoded = localStorage.getItem(storageKey);
  if (encoded !== null) {
    try {
      const value = JSON.parse(encoded) as Partial<StoredDeviceKey>;
      if (typeof value.private_key_pkcs8_base64url === "string" && typeof value.public_key_spki_base64url === "string") {
        stored = value as StoredDeviceKey;
      }
    } catch {
      stored = undefined;
    }
  }
  if (stored === undefined) {
    const pair = await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["sign", "verify"]
    ) as CryptoKeyPair;
    stored = {
      private_key_pkcs8_base64url: bytesToBase64Url(new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))),
      public_key_spki_base64url: bytesToBase64Url(new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)))
    };
    localStorage.setItem(storageKey, JSON.stringify(stored));
  }
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    base64UrlToBytes(stored.private_key_pkcs8_base64url),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  const publicKeyBytes = base64UrlToBytes(stored.public_key_spki_base64url);
  const publicKey = await crypto.subtle.importKey(
    "spki",
    publicKeyBytes,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"]
  );
  const payload = utf8Bytes(`${runId}\n${manifestSha}\n${bundleSha}`);
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, payload));
  const verified = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, signature, payload);
  if (!verified) throw new Error("Android smoke device signature failed immediate verification.");
  return {
    publicKey: stored.public_key_spki_base64url,
    binding: {
      signature_algorithm: "ECDSA-P256-SHA256",
      public_key_fingerprint: sha256Hex(publicKeyBytes),
      device_signature_base64url: bytesToBase64Url(signature),
      run_id: runId,
      vector_manifest_sha256: manifestSha,
      plugin_bundle_sha256: bundleSha,
      verified: true
    }
  };
}

class Phase1SettingTab extends PluginSettingTab {
  readonly #plugin: EkdPhase1Plugin;

  constructor(app: App, plugin: EkdPhase1Plugin) {
    super(app, plugin);
    this.#plugin = plugin;
  }

  display(): void {
    this.containerEl.empty();
    this.containerEl.createEl("h2", { text: "EKD Phase 1 Android smoke metadata" });
    this.containerEl.createEl("p", {
      text: "These fields identify the physical Android smoke environment. The generated key binds the report to this plugin runtime; it is not a production keystore or hardware attestation."
    });
    const fields: readonly [keyof Phase1Settings, string, string][] = [
      ["androidDeviceModel", "Device model", "Example: Pixel 8"],
      ["androidOsVersion", "Android version", "Example: Android 16"],
      ["androidArchitecture", "Architecture", "Example: arm64-v8a"]
    ];
    for (const [key, name, placeholder] of fields) {
      new Setting(this.containerEl)
        .setName(name)
        .addText((text) => text
          .setPlaceholder(placeholder)
          .setValue(this.#plugin.settings[key])
          .onChange(async (value) => {
            this.#plugin.settings = { ...this.#plugin.settings, [key]: value.trim() };
            await this.#plugin.saveData(this.#plugin.settings);
          }));
    }
  }
}

export default class EkdPhase1Plugin extends Plugin {
  settings: Phase1Settings = DEFAULT_SETTINGS;
  p0Settings: P0Settings = DEFAULT_P0_SETTINGS;
  #running = false;
  #provider = new WebCryptoAes256Provider();
  #reportValidator: SmokeReportSchemaValidator | undefined;

  async onload(): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData() as Partial<Phase1Settings> | null ?? {}) };
    this.p0Settings = { ...DEFAULT_P0_SETTINGS, ...(await this.loadData() as Partial<P0Settings> | null ?? {}) };
    this.#reportValidator = createSmokeReportSchemaValidator(JSON.parse(__SMOKE_REPORT_SCHEMA_JSON__) as unknown);
    this.addSettingTab(new Phase1SettingTab(this.app, this));
    this.addSettingTab(new P0SettingTab(this.app, this, () => this.p0Settings, async (s) => { this.p0Settings = s; await this.saveData({ ...this.settings, ...s }); }));
    for (const selected of ["webcrypto", "noble"] as const) {
      this.addCommand({
        id: `phase1-smoke-${selected}`,
        name: `Run Phase 1 smoke: ${selected}`,
        callback: () => { void this.runSmoke(selected); }
      });
    }
    this.addCommand({
      id: "p0-create-snapshot",
      name: "P0: Create Snapshot",
      callback: () => { void this.#runP0Create(); }
    });
    this.addCommand({
      id: "p0-restore-snapshot",
      name: "P0: Restore Snapshot",
      callback: () => { void this.#runP0Restore(); }
    });
  }

  async #runP0Create(): Promise<void> {
    if (this.#running) { new Notice("A P0 operation is already running."); return; }
    this.#running = true;
    try {
      const s = this.p0Settings;
      if (!s.objectStorePath || !s.recoveryFilePath || !s.logFilePath) throw new Error("Set ObjectStore, Recovery File, and Log paths in settings.");
      const vaultPath = (this.app.vault.adapter as { basePath?: string }).basePath;
      if (typeof vaultPath !== "string") throw new Error("Vault base path is only available on desktop.");
      const domainKeyPath = normalizePath(`${this.app.vault.configDir}/plugins/${this.manifest.id}/p0-domain-id.hex`);
      let domainId: Uint8Array;
      if (await this.app.vault.adapter.exists(domainKeyPath)) {
        const hex = await this.app.vault.adapter.read(domainKeyPath);
        domainId = new Uint8Array(32);
        for (let i = 0; i < 32; i++) domainId[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      } else {
        domainId = crypto.getRandomValues(new Uint8Array(32));
        const hex = Array.from(domainId).map(b => b.toString(16).padStart(2, "0")).join("");
        await this.app.vault.adapter.write(domainKeyPath, hex);
      }
      const { NodeVaultSource, DirectoryObjectStoreV1, NodeSnapshotLogSink, NodeRecoveryFileTarget } = await import("@ekd/adapters");
      const limitsSha = sha256Hex(utf8Bytes(__VECTOR_MANIFEST_JSON__)).slice(0, 64);
      new Notice("P0 snapshot: starting…");
      const result = await createSnapshotV1(
        { domainId, runtimeLimits: { schemaVersion: "p0-runtime-limits-v1", sha256Hex: limitsSha } },
        {
          vaultSource: new NodeVaultSource(vaultPath),
          objectStore: new DirectoryObjectStoreV1(s.objectStorePath),
          cryptoProvider: this.#provider,
          randomSource: this.#provider,
          clock: { nowMilliseconds: () => Date.now() },
          logSink: new NodeSnapshotLogSink(s.logFilePath, { vaultRoot: vaultPath, objectStoreRoot: s.objectStorePath }),
          recoveryFileTarget: new NodeRecoveryFileTarget(s.recoveryFilePath, { vaultRoot: vaultPath, objectStoreRoot: s.objectStorePath })
        }
      );
      if (result.status === "complete") {
        new Notice(`P0 snapshot: ${result.fileCount} files, ${(result.totalPlaintextBytes! / 1048576).toFixed(1)} MB, recovery file created.`, 10_000);
      } else {
        new Notice(`P0 snapshot failed: ${result.errorCode} (phase: ${result.failedPhase})`, 10_000);
      }
    } catch (error) {
      new Notice(`P0 snapshot error: ${error instanceof Error ? error.message : String(error)}`, 10_000);
    } finally {
      this.#running = false;
    }
  }

  async #runP0Restore(): Promise<void> {
    if (this.#running) { new Notice("A P0 operation is already running."); return; }
    this.#running = true;
    try {
      const s = this.p0Settings;
      if (!s.objectStorePath || !s.recoveryFilePath) throw new Error("Set ObjectStore and Recovery File paths in settings.");
      const targetPath = s.objectStorePath + "/restored-vault";
      const { DirectoryObjectStoreV1, NodeRestoreTarget } = await import("@ekd/adapters");
      new Notice("P0 restore: starting…");
      const { readFile: rf } = await import("node:fs/promises");
      const recoveryBytes = new Uint8Array(await rf(s.recoveryFilePath));
      const result = await restoreSnapshotV1(
        { recoveryFileBytes: recoveryBytes },
        { objectStore: new DirectoryObjectStoreV1(s.objectStorePath), cryptoProvider: this.#provider, restoreTarget: new NodeRestoreTarget(targetPath) }
      );
      if (result.status === "complete") {
        new Notice(`P0 restore: ${result.restoredFileCount} files, ${(result.totalBytesWritten! / 1048576).toFixed(1)} MB → ${targetPath}`, 10_000);
      } else {
        new Notice(`P0 restore failed: ${result.errorCode} (restored ${result.restoredFileCount} files)`, 10_000);
      }
    } catch (error) {
      new Notice(`P0 restore error: ${error instanceof Error ? error.message : String(error)}`, 10_000);
    } finally {
      this.#running = false;
    }
  }


  async #ensureFolder(path: string): Promise<void> {
    if (!(await this.app.vault.adapter.exists(path))) await this.app.vault.adapter.mkdir(path);
  }

  async #loadBuildMeta(): Promise<BuildMeta> {
    const pluginRoot = normalizePath(`${this.app.vault.configDir}/plugins/${this.manifest.id}`);
    const value = JSON.parse(await this.app.vault.adapter.read(normalizePath(`${pluginRoot}/build-meta.json`))) as unknown;
    if (!isBuildMeta(value)) throw new Error("Invalid Phase 1 plugin build metadata.");
    const mainBytes = new Uint8Array(await this.app.vault.adapter.readBinary(normalizePath(`${pluginRoot}/main.js`)));
    if (sha256Hex(mainBytes) !== value.bundle_sha256) throw new Error("Plugin bundle does not match build metadata.");
    return value;
  }

  async runSmoke(selected: CandidateName): Promise<void> {
    if (this.#running) {
      new Notice("A Phase 1 smoke run is already active.");
      return;
    }
    this.#running = true;
    try {
      if (!Platform.isAndroidApp && !Platform.isWin) throw new Error("Phase 1 plugin smoke is scoped to Windows and Android.");
      if (Platform.isAndroidApp && Object.values(this.settings).some((value) => value.length === 0)) {
        throw new Error("Set device model, Android version, and architecture before the Android smoke run.");
      }
      const meta = await this.#loadBuildMeta();
      const vectorSet = embeddedVectors();
      if (vectorSet.manifestSha256 !== meta.vector_manifest_sha256 || vectorSet.vectorsSha256 !== meta.vectors_sha256) {
        throw new Error("Embedded vectors do not match plugin build metadata.");
      }
      if (typeof crypto.randomUUID !== "function") throw new Error("crypto.randomUUID is unavailable in this Obsidian runtime.");
      const runId = crypto.randomUUID();
      const selectedCandidate = candidate(selected);
      const vectorRun = await runSmokeVectors(selectedCandidate.provider, {
        vector_set: vectorSet,
        random_source_faults: selectedCandidate.faults
      });
      const environmentId = Platform.isAndroidApp ? "android-obsidian" : "windows-obsidian";
      const outputRoot = "phase1-smoke-output";
      await this.#ensureFolder(outputRoot);
      await this.#ensureFolder(normalizePath(`${outputRoot}/raw`));
      await this.#ensureFolder(normalizePath(`${outputRoot}/reports`));
      const rawRelative = `raw/${environmentId}-${selected}-${runId}.json`;
      const reportRelative = `reports/${environmentId}-${selected}-${runId}.json`;
      const rawText = `${JSON.stringify({
        schema_version: "phase1-smoke-raw-v1",
        run_id: runId,
        environment_id: environmentId,
        candidate: selectedCandidate.metadata,
        vector_results: vectorRun.vector_results,
        aggregate: vectorRun.aggregate
      }, null, 2)}\n`;
      await this.app.vault.adapter.write(normalizePath(`${outputRoot}/${rawRelative}`), rawText);
      let binding: DeviceBinding | null = null;
      let publicKey: string | null = null;
      if (Platform.isAndroidApp) {
        const device = await createAndroidDeviceBinding(this.manifest.id, runId, vectorSet.manifestSha256, meta.bundle_sha256);
        binding = device.binding;
        publicKey = device.publicKey;
      }
      const runtimeItems = [
        { key: "runtime", value: `Obsidian ${apiVersion}` },
        { key: "user_agent", value: navigator.userAgent }
      ];
      if (publicKey !== null) runtimeItems.push({ key: "device_public_key_spki_base64url", value: publicKey });
      const report = createSmokeReport(vectorRun, vectorSet, {
        run_id: runId,
        git_commit: meta.source_commit,
        candidate: { ...selectedCandidate.metadata, bundle_sha256: meta.bundle_sha256 },
        environment: {
          id: environmentId,
          os_name: Platform.isAndroidApp ? "Android" : "Windows",
          os_version: Platform.isAndroidApp ? this.settings.androidOsVersion : navigator.userAgent,
          runtime_name: "Obsidian",
          runtime_version: apiVersion,
          device_model: Platform.isAndroidApp ? this.settings.androidDeviceModel : null,
          architecture: Platform.isAndroidApp ? this.settings.androidArchitecture : "browser-reported",
          lockfile_sha256: meta.lockfile_sha256,
          source_commit: meta.source_commit,
          bundle_sha256: meta.bundle_sha256
        },
        environment_manifest: environmentManifest(meta, runtimeItems),
        raw_artifacts: [{ path: rawRelative, sha256: sha256Hex(utf8Bytes(rawText)) }],
        device_binding: binding
      });
      if (this.#reportValidator === undefined) throw new Error("Smoke report validator is unavailable.");
      const validation = this.#reportValidator.validateSmokeReport(report);
      if (!validation.valid) {
        console.error("Generated smoke report failed schema validation", validation.errors);
        throw new Error(`Generated report failed smoke-report-v1 validation (${validation.errors.length} errors).`);
      }
      await this.app.vault.adapter.write(
        normalizePath(`${outputRoot}/${reportRelative}`),
        `${JSON.stringify(report, null, 2)}\n`
      );
      const mode = meta.source_tree_state === "clean" ? "formal" : "DEV ONLY (dirty source; cannot close DP)";
      new Notice(`Phase 1 ${selected} smoke: ${report.aggregate.verdict}; ${mode}.`);
    } catch (error) {
      console.error("EKD Phase 1 smoke failed", error);
      new Notice(`Phase 1 smoke failed: ${error instanceof Error ? error.message : String(error)}`, 10000);
    } finally {
      this.#running = false;
    }
  }
}
