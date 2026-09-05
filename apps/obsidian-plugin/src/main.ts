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
import type { ObsidianVaultLike } from "@ekd/adapters/obsidian-vault";
import type * as NodePathApi from "node:path";
import type * as NodeFsPromisesApi from "node:fs/promises";
import { NobleAes256Provider, NOBLE_CANDIDATE } from "@ekd/crypto/noble";
import { WebCryptoAes256Provider, WEBCRYPTO_CANDIDATE } from "@ekd/crypto/webcrypto";
import {
  base64UrlToBytes,
  bytesToBase64Url,
  createSmokeReport,
  createSmokeReportSchemaValidator,
  hexToBytes,
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
import {
  runPluginSnapshotV1,
  type PluginSnapshotProgress,
  type PluginSnapshotReportV1
} from "./p0-snapshot.js";
import { SnapshotPanelModel } from "./snapshot-panel-model.js";
import { P0SnapshotView, VIEW_TYPE_EKD_P0_SNAPSHOT } from "./snapshot-view.js";
import {
  createNodeVaultPathValidator,
  requireNewReportTarget,
  requireRealDirectory,
  requireSnapshotPathsDisjoint,
  writeReportExclusive
} from "./node-path-safety.js";

interface BuildMeta {
  readonly schema_version: "phase1-build-meta-v1";
  readonly source_commit: string;
  readonly source_tree_state: "clean" | "dirty";
  readonly lockfile_sha256: string;
  readonly vector_manifest_sha256: string;
  readonly vectors_sha256: string;
  readonly bundle_sha256: string;
}

interface EkdSettings {
  readonly androidDeviceModel: string;
  readonly androidOsVersion: string;
  readonly androidArchitecture: string;
  readonly domainIdHex: string;
  readonly objectStorePath: string;
  readonly snapshotLogPath: string;
  readonly recoveryFilePath: string;
  readonly runtimeLimitsPath: string;
  readonly snapshotReportPath: string;
}

interface StoredDeviceKey {
  readonly private_key_pkcs8_base64url: string;
  readonly public_key_spki_base64url: string;
}

type CandidateName = "webcrypto" | "noble";

const DEFAULT_SETTINGS: EkdSettings = {
  androidDeviceModel: "",
  androidOsVersion: "",
  androidArchitecture: "",
  domainIdHex: "",
  objectStorePath: "",
  snapshotLogPath: "",
  recoveryFilePath: "",
  runtimeLimitsPath: "",
  snapshotReportPath: ""
};

/** SHA-256 of `docs/contracts/p0-runtime-limits-v1.json`; cross-checked against the real file by the contract verifier. */
const PLUGIN_ACCEPTED_RUNTIME_LIMITS_SHA256 = "e1971ab746f6b08b06522463f907143036d99e41c470532482b5da8eafc44acd";

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

type NodePath = typeof NodePathApi;

interface SnapshotPathSettings {
  readonly objectStorePath: string;
  readonly snapshotLogPath: string;
  readonly recoveryFilePath: string;
  readonly runtimeLimitsPath: string;
  readonly snapshotReportPath: string;
}

function requireSnapshotSettings(settings: EkdSettings, nodePath: NodePath): SnapshotPathSettings {
  if (!/^[0-9a-f]{64}$/u.test(settings.domainIdHex)) {
    throw new Error("Domain ID must be exactly 64 lowercase hexadecimal characters.");
  }
  const paths: SnapshotPathSettings = {
    objectStorePath: settings.objectStorePath,
    snapshotLogPath: settings.snapshotLogPath,
    recoveryFilePath: settings.recoveryFilePath,
    runtimeLimitsPath: settings.runtimeLimitsPath,
    snapshotReportPath: settings.snapshotReportPath
  };
  for (const [label, pathValue] of Object.entries(paths)) {
    if (pathValue.length === 0 || !nodePath.isAbsolute(pathValue)) {
      throw new Error(`${label} must be an explicit absolute path.`);
    }
  }
  return paths;
}

class Phase1SettingTab extends PluginSettingTab {
  readonly #plugin: EkdPhase1Plugin;

  constructor(app: App, plugin: EkdPhase1Plugin) {
    super(app, plugin);
    this.#plugin = plugin;
  }

  display(): void {
    this.containerEl.empty();
    this.containerEl.createEl("h2", { text: "EKD P0 snapshot creation" });
    this.containerEl.createEl("p", {
      text: "Windows desktop only. Set every path explicitly; the ObjectStore directory and every output parent must already exist outside the source Vault. Snapshot creation never writes protocol artifacts into the Vault."
    });
    const snapshotFields: readonly [keyof EkdSettings, string, string][] = [
      ["domainIdHex", "Domain ID", "64 lowercase hexadecimal characters"],
      ["objectStorePath", "ObjectStore directory", "Absolute path to an existing directory"],
      ["snapshotLogPath", "Snapshot log", "Absolute path to a new .jsonl file"],
      ["recoveryFilePath", "Recovery File", "Absolute path to a new .ekdr file"],
      ["runtimeLimitsPath", "Runtime limits contract", "Absolute path to p0-runtime-limits-v1.json"],
      ["snapshotReportPath", "Plugin snapshot report", "Absolute path to a new .json report file"]
    ];
    for (const [key, name, placeholder] of snapshotFields) {
      new Setting(this.containerEl)
        .setName(name)
        .addText((text) => text
          .setPlaceholder(placeholder)
          .setValue(this.#plugin.settings[key])
          .onChange(async (value) => {
            if (!(await this.#plugin.updateSetting(key, value))) text.setValue(this.#plugin.settings[key]);
          }));
    }

    this.containerEl.createEl("h2", { text: "EKD Phase 1 Android smoke metadata" });
    this.containerEl.createEl("p", {
      text: "These fields identify the physical Android smoke environment. The generated key binds the report to this plugin runtime; it is not a production keystore or hardware attestation."
    });
    const fields: readonly [keyof EkdSettings, string, string][] = [
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
            if (!(await this.#plugin.updateSetting(key, value))) text.setValue(this.#plugin.settings[key]);
          }));
    }
  }
}

export default class EkdPhase1Plugin extends Plugin {
  settings: EkdSettings = DEFAULT_SETTINGS;
  #running = false;
  #reportValidator: SmokeReportSchemaValidator | undefined;
  #pluginReportValidator: SmokeReportSchemaValidator | undefined;
  #snapshotStatus: HTMLElement | undefined;
  #settingsWrites: Promise<void> = Promise.resolve();
  readonly #panelModel = new SnapshotPanelModel();

  async updateSetting(key: keyof EkdSettings, value: string): Promise<boolean> {
    if (this.#running) {
      new Notice("Settings cannot change while an EKD operation is active.");
      return false;
    }
    this.settings = { ...this.settings, [key]: value.trim() };
    const settingsToPersist = this.settings;
    const write = this.#settingsWrites.then(async () => this.saveData(settingsToPersist));
    this.#settingsWrites = write.then(() => undefined, () => undefined);
    await write;
    return true;
  }

  async onload(): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData() as Partial<EkdSettings> | null ?? {}) };
    this.#reportValidator = createSmokeReportSchemaValidator(JSON.parse(__SMOKE_REPORT_SCHEMA_JSON__) as unknown);
    this.#pluginReportValidator = createSmokeReportSchemaValidator(JSON.parse(__PLUGIN_SNAPSHOT_REPORT_SCHEMA_JSON__) as unknown);
    this.#snapshotStatus = this.addStatusBarItem();
    this.#snapshotStatus.setText("EKD snapshot: idle");
    this.addSettingTab(new Phase1SettingTab(this.app, this));
    this.registerView(VIEW_TYPE_EKD_P0_SNAPSHOT, (leaf) => new P0SnapshotView(leaf, {
      onTrigger: () => { void this.runSnapshot(); },
      onOpenReport: (reportPath) => { this.#openReportFile(reportPath); },
      isRunning: () => this.#running
    }));
    this.addRibbonIcon("lock", "EKD P0 snapshot", () => { void this.activateSnapshotView(); });
    this.addCommand({
      id: "p0-create-snapshot",
      name: "Create P0 snapshot",
      callback: () => { void this.activateSnapshotView().then(() => this.runSnapshot()); }
    });
    for (const selected of ["webcrypto", "noble"] as const) {
      this.addCommand({
        id: `phase1-smoke-${selected}`,
        name: `Run Phase 1 smoke: ${selected}`,
        callback: () => { void this.runSmoke(selected); }
      });
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

  #showSnapshotProgress(progress: PluginSnapshotProgress): void {
    let text: string;
    if (progress.phase === "scanning") {
      text = progress.status === "active"
        ? `EKD snapshot: scanning ${progress.scannedFiles} file(s)`
        : `EKD snapshot: scanned ${progress.fileCount} file(s), ${progress.totalPlaintextBytes} plaintext byte(s)`;
    } else if (progress.phase === "encrypting") {
      text = progress.status === "active"
        ? `EKD snapshot: encrypting ${progress.fileOrdinal}/${progress.fileCount}, ${progress.totalPlaintextBytes} plaintext byte(s)`
        : `EKD snapshot: encrypted ${progress.fileCount} file(s)`;
    } else {
      text = progress.status === "verifying"
        ? "EKD snapshot: verifying Recovery File ownership target"
        : "EKD snapshot: Recovery File ownership complete";
    }
    this.#snapshotStatus?.setText(text);
    this.#panelModel.onProgress(progress);
    this.#syncSnapshotView();
  }

  /** ADR-0023 §2.1: the dockable panel view; commands open it before triggering a run. */
  async activateSnapshotView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_EKD_P0_SNAPSHOT);
    const leaf = existing[0] ?? this.app.workspace.getRightLeaf(false);
    if (leaf === null) return;
    if (existing.length === 0) await leaf.setViewState({ type: VIEW_TYPE_EKD_P0_SNAPSHOT, active: true });
    this.app.workspace.revealLeaf(leaf);
    this.#syncSnapshotView();
  }

  #syncSnapshotView(): void {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_EKD_P0_SNAPSHOT)[0];
    if (leaf !== undefined) (leaf.view as P0SnapshotView).updateFromModel(this.#panelModel.render);
  }

  #openReportFile(reportPath: string): void {
    const nodeRequire = (globalThis as { require?: (id: string) => unknown }).require;
    if (typeof nodeRequire !== "function") throw new Error("Node module loader unavailable.");
    const electron = nodeRequire("electron") as { shell?: { openPath?: (path: string) => Promise<string> } };
    const openPath = electron.shell?.openPath;
    if (typeof openPath !== "function") throw new Error("Electron shell.openPath is unavailable in this runtime.");
    void openPath.call(electron.shell, reportPath).then((message) => {
      if (typeof message === "string" && message.length > 0) new Notice(`Could not open report: ${message}`);
    });
  }

  async runSnapshot(): Promise<void> {
    if (this.#running) {
      new Notice("An EKD operation is already active.");
      return;
    }
    this.#running = true;
    this.#panelModel.reset();
    this.#syncSnapshotView();
    try {
      this.#snapshotStatus?.setText("EKD snapshot: waiting for settings writes");
      await this.#settingsWrites;
      if (!Platform.isDesktopApp || !Platform.isWin) {
        throw new Error("P0 snapshot creation is currently scoped to Obsidian on Windows desktop.");
      }
      // Electron's renderer blocks ESM dynamic import of node: specifiers (CORS on
      // app://obsidian.md); Obsidian desktop exposes the CJS loader instead.
      const nodeRequire = (globalThis as { require?: (id: string) => unknown }).require;
      if (typeof nodeRequire !== "function") {
        throw new Error("Obsidian desktop did not expose the Node module loader; P0 snapshot cannot load filesystem adapters.");
      }
      const [nodeFs, nodePath, obsidianAdapter, objectStoreAdapter, snapshotIoAdapter, adapterErrors] = await Promise.all([
        Promise.resolve(nodeRequire("node:fs/promises") as typeof NodeFsPromisesApi),
        Promise.resolve(nodeRequire("node:path") as typeof NodePathApi),
        import("@ekd/adapters/obsidian-vault"),
        import("@ekd/adapters/node-object-store"),
        import("@ekd/adapters/node-snapshot-io"),
        import("@ekd/adapters/errors")
      ]);
      const configured = requireSnapshotSettings(this.settings, nodePath);
      const fileSystemAdapter = this.app.vault.adapter as unknown as { readonly getBasePath?: () => string };
      if (typeof fileSystemAdapter.getBasePath !== "function") {
        throw new Error("Obsidian did not expose a desktop Vault filesystem path.");
      }
      const vaultRoot = nodePath.resolve(fileSystemAdapter.getBasePath());
      const objectStorePath = nodePath.resolve(configured.objectStorePath);
      const snapshotLogPath = nodePath.resolve(configured.snapshotLogPath);
      const recoveryFilePath = nodePath.resolve(configured.recoveryFilePath);
      const runtimeLimitsPath = nodePath.resolve(configured.runtimeLimitsPath);
      const snapshotReportPath = nodePath.resolve(configured.snapshotReportPath);
      const snapshotPaths = [
        ["Source Vault", vaultRoot],
        ["ObjectStore", objectStorePath],
        ["snapshot log", snapshotLogPath],
        ["Recovery File", recoveryFilePath],
        ["plugin snapshot report", snapshotReportPath]
      ] as const;

      await Promise.all([
        requireRealDirectory(vaultRoot, "Source Vault", nodeFs),
        requireRealDirectory(objectStorePath, "ObjectStore", nodeFs),
        requireNewReportTarget(snapshotReportPath, nodeFs, nodePath),
        requireSnapshotPathsDisjoint(snapshotPaths, nodeFs, nodePath)
      ]);

      const embeddedLimitsBytes = utf8Bytes(__P0_RUNTIME_LIMITS_JSON__);
      if (sha256Hex(embeddedLimitsBytes) !== PLUGIN_ACCEPTED_RUNTIME_LIMITS_SHA256) {
        throw new Error("Embedded runtime-limits bytes do not match the accepted contract hash.");
      }
      const embeddedLimits = JSON.parse(__P0_RUNTIME_LIMITS_JSON__) as { readonly schema_version?: unknown };
      if (embeddedLimits.schema_version !== "p0-runtime-limits-v1") {
        throw new Error("Embedded runtime-limits copy is not p0-runtime-limits-v1.");
      }
      const diskLimitsBytes = new Uint8Array(await nodeFs.readFile(runtimeLimitsPath));
      const diskLimitsSha256 = sha256Hex(diskLimitsBytes);
      if (diskLimitsSha256 !== PLUGIN_ACCEPTED_RUNTIME_LIMITS_SHA256) {
        throw new Error(`Configured runtime-limits sha256 ${diskLimitsSha256} does not match the accepted contract.`);
      }
      const diskLimits = JSON.parse(new TextDecoder().decode(diskLimitsBytes)) as { readonly schema_version?: unknown };
      if (diskLimits.schema_version !== "p0-runtime-limits-v1") {
        throw new Error("Configured runtime-limits file is not p0-runtime-limits-v1.");
      }
      if (this.#pluginReportValidator === undefined) {
        throw new Error("Plugin snapshot report validator is unavailable.");
      }

      const pathValidator = createNodeVaultPathValidator(
        vaultRoot,
        nodeFs,
        nodePath,
        (code, relativePath, message, cause) => new adapterErrors.VaultAdapterError(
          code,
          relativePath,
          message,
          cause === undefined ? undefined : { cause }
        )
      );
      const provider = new WebCryptoAes256Provider();
      this.#snapshotStatus?.setText("EKD snapshot: starting");
      const execution = await runPluginSnapshotV1({
        domainId: hexToBytes(this.settings.domainIdHex),
        runtimeLimits: {
          schemaVersion: "p0-runtime-limits-v1",
          sha256Hex: diskLimitsSha256
        }
      }, {
        vaultSource: new obsidianAdapter.ObsidianVaultSource(
          this.app.vault as unknown as ObsidianVaultLike,
          { validatePath: pathValidator }
        ),
        objectStore: new objectStoreAdapter.DirectoryObjectStoreV1(objectStorePath),
        cryptoProvider: provider,
        randomSource: provider,
        clock: { nowMilliseconds: () => Date.now() },
        logSink: new snapshotIoAdapter.NodeSnapshotLogSink(snapshotLogPath, {
          vaultRoot,
          objectStoreRoot: objectStorePath
        }),
        recoveryFileTarget: new snapshotIoAdapter.NodeRecoveryFileTarget(recoveryFilePath, {
          vaultRoot,
          objectStoreRoot: objectStorePath
        }),
        readSnapshotLogBytes: async () => new Uint8Array(await nodeFs.readFile(snapshotLogPath)),
        writeReportExclusive: async (bytes) => {
          await requireNewReportTarget(snapshotReportPath, nodeFs, nodePath);
          await requireSnapshotPathsDisjoint(snapshotPaths, nodeFs, nodePath);
          await writeReportExclusive(snapshotReportPath, bytes, nodeFs);
        },
        validateReport: (value) => this.#pluginReportValidator?.validateSmokeReport(value) ?? {
          valid: false,
          errors: ["validator unavailable"]
        }
      }, (progress) => {
        this.#showSnapshotProgress(progress);
      });

      if (execution.snapshot.status !== "complete" || execution.report === undefined) {
        throw new Error(
          `Snapshot failed in ${execution.snapshot.failedPhase ?? "unknown phase"} ` +
          `(${execution.snapshot.errorCode ?? "unknown error"}); no pass report was exported.`
        );
      }
      this.#showSnapshotResult(execution.report, snapshotReportPath);
      const summary = execution.report.visibility_summary;
      this.#snapshotStatus?.setText(
        `EKD snapshot complete: ${execution.report.file_count} file(s), ` +
        `${execution.report.total_plaintext_bytes} plaintext / ${summary.total_ciphertext_bytes} ciphertext byte(s)`
      );
      new Notice(
        `P0 snapshot complete: ${summary.object_count} object(s), ${execution.report.file_count} file(s). ` +
        "The plugin visibility summary is not formal ACC-32/33 evidence.",
        10000
      );
    } catch (error) {
      console.error("EKD P0 snapshot failed", error);
      this.#snapshotStatus?.setText("EKD snapshot: failed");
      this.#panelModel.onError(error);
      this.#syncSnapshotView();
      new Notice(`P0 snapshot failed: ${error instanceof Error ? error.message : String(error)}`, 10000);
    } finally {
      this.#running = false;
    }
  }

  #showSnapshotResult(report: PluginSnapshotReportV1, snapshotReportPath: string): void {
    this.#panelModel.onResult(report);
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_EKD_P0_SNAPSHOT)[0];
    if (leaf !== undefined) (leaf.view as P0SnapshotView).setReportPath(snapshotReportPath);
    this.#syncSnapshotView();
  }

  async runSmoke(selected: CandidateName): Promise<void> {
    if (this.#running) {
      new Notice("A Phase 1 smoke run is already active.");
      return;
    }
    this.#running = true;
    try {
      if (!Platform.isAndroidApp && !Platform.isWin) throw new Error("Phase 1 plugin smoke is scoped to Windows and Android.");
      if (Platform.isAndroidApp && [
        this.settings.androidDeviceModel,
        this.settings.androidOsVersion,
        this.settings.androidArchitecture
      ].some((value) => value.length === 0)) {
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
