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
import { PluginConsoleHost } from "./console-host.js";
import { TeamHost } from "./team-host.js";
import { TeamPanelModel } from "./team-panel-model.js";
import { TeamView, VIEW_TYPE_EKD_TEAM } from "./team-view.js";
import { STRINGS } from "./strings.js";
import { WebCryptoKeyAgreementProvider } from "@ekd/crypto";
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
  readonly consoleEnabled: boolean;
  readonly domainIdHex: string;
  readonly objectStorePath: string;
  readonly snapshotLogPath: string;
  readonly recoveryFilePath: string;
  readonly runtimeLimitsPath: string;
  readonly snapshotReportPath: string;
  readonly teamStateDir: string;
  readonly teamDeviceId: string;
  readonly teamAuthoritySpkiBase64url: string;
  readonly teamReviewerPrivateKeyPkcs8Base64url: string;
  readonly teamReviewerId: string;
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
  consoleEnabled: false,
  teamStateDir: "",
  teamDeviceId: "",
  teamAuthoritySpkiBase64url: "",
  teamReviewerPrivateKeyPkcs8Base64url: "",
  teamReviewerId: "",
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

/** Settings fields that hold strings; `consoleEnabled` is boolean and toggled separately. */
type StringSettingKey = Exclude<keyof EkdSettings, "consoleEnabled">;

interface SnapshotPathSettings {
  readonly objectStorePath: string;
  readonly snapshotLogPath: string;
  readonly recoveryFilePath: string;
  readonly runtimeLimitsPath: string;
  readonly snapshotReportPath: string;
}

function requireSnapshotSettings(settings: EkdSettings, nodePath: NodePath): SnapshotPathSettings {
  if (!/^[0-9a-f]{64}$/u.test(settings.domainIdHex)) {
    throw new Error(STRINGS.faults.domainIdInvalid);
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
      throw new Error(STRINGS.faults.pathMustBeAbsolute(label));
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
    this.containerEl.createEl("h2", { text: STRINGS.settings.snapshotSection });
    this.containerEl.createEl("p", { text: STRINGS.settings.snapshotIntro });
    const snapshotFields: readonly [StringSettingKey, string, string][] = [
      ["domainIdHex", STRINGS.settings.domainId, STRINGS.settings.domainIdHint],
      ["objectStorePath", STRINGS.settings.objectStore, STRINGS.settings.absoluteDirHint],
      ["snapshotLogPath", STRINGS.settings.snapshotLog, STRINGS.settings.newJsonlHint],
      ["recoveryFilePath", STRINGS.settings.recoveryFile, STRINGS.settings.newEkdrHint],
      ["runtimeLimitsPath", STRINGS.settings.runtimeLimits, STRINGS.settings.runtimeLimitsHint],
      ["snapshotReportPath", STRINGS.settings.snapshotReport, STRINGS.settings.newJsonHint]
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

    this.containerEl.createEl("h2", { text: STRINGS.settings.consoleSection });
    this.containerEl.createEl("p", { text: STRINGS.settings.consoleIntro });
    new Setting(this.containerEl)
      .setName(STRINGS.settings.consoleToggle)
      .addToggle((toggle) => toggle
        .setValue(this.#plugin.settings.consoleEnabled)
        .onChange(async (value) => {
          await this.#plugin.setConsoleEnabled(value);
          toggle.setValue(this.#plugin.settings.consoleEnabled);
        }));

    this.containerEl.createEl("h2", { text: STRINGS.settings.androidSection });
    this.containerEl.createEl("p", { text: STRINGS.settings.androidIntro });
    const fields: readonly [StringSettingKey, string, string][] = [
      ["androidDeviceModel", STRINGS.settings.deviceModel, STRINGS.settings.deviceModelHint],
      ["androidOsVersion", STRINGS.settings.androidVersion, STRINGS.settings.androidVersionHint],
      ["androidArchitecture", STRINGS.settings.architecture, STRINGS.settings.architectureHint]
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
  readonly #teamModel = new TeamPanelModel();
  #teamHost: TeamHost | undefined;
  readonly #console = new PluginConsoleHost({
    version: "p1-console-v1",
    build: async () => (await this.#loadBuildMeta()).source_commit,
    objectStorePath: () => {
      const value = this.settings.objectStorePath.trim();
      return value.length === 0 ? undefined : value;
    },
    log: (line) => console.log(`[ekd-console] ${line}`)
  });
  #consoleBuildNoticeShown = false;

  async updateSetting(key: keyof EkdSettings, value: string): Promise<boolean> {
    if (this.#running) {
      new Notice(STRINGS.notices.settingsLocked);
      return false;
    }
    this.settings = { ...this.settings, [key]: value.trim() };
    const settingsToPersist = this.settings;
    const write = this.#settingsWrites.then(async () => this.saveData(settingsToPersist));
    this.#settingsWrites = write.then(() => undefined, () => undefined);
    await write;
    return true;
  }

  /** ADR-0031 §13: the read-only localhost console is off by default and toggled here. */
  async setConsoleEnabled(enabled: boolean): Promise<void> {
    if (this.#running) {
      new Notice(STRINGS.notices.settingsLocked);
      return;
    }
    this.settings = { ...this.settings, consoleEnabled: enabled };
    await this.saveData(this.settings);
    if (enabled) {
      await this.#startConsole();
    } else {
      await this.#console.stop();
    }
    this.#syncSnapshotView();
  }

  async #startConsole(): Promise<void> {
    try {
      const url = await this.#console.start();
      new Notice(STRINGS.settings.consoleEnabled(url));
    } catch (error) {
      await this.#console.stop();
      this.settings = { ...this.settings, consoleEnabled: false };
      await this.saveData(this.settings);
      if (!this.#consoleBuildNoticeShown) {
        this.#consoleBuildNoticeShown = true;
        new Notice(STRINGS.settings.consoleStartFailed(error instanceof Error ? error.message : String(error)));
      }
    }
  }

  #openConsoleInBrowser(): void {
    const url = this.#console.url;
    if (url === undefined) {
      new Notice(STRINGS.settings.consoleNotEnabled);
      return;
    }
    const nodeRequire = (globalThis as { require?: (id: string) => unknown }).require;
    if (typeof nodeRequire !== "function") throw new Error(STRINGS.faults.nodeLoaderUnavailable);
    const electron = nodeRequire("electron") as { shell?: { openExternal?: (url: string) => Promise<void> } };
    const openExternal = electron.shell?.openExternal;
    if (typeof openExternal !== "function") throw new Error(STRINGS.faults.electronOpenExternalUnavailable);
    // The URL carries no credential — the page bootstraps its session same-origin (ADR-0030 §3.4.6).
    void openExternal.call(electron.shell, url).catch((error: unknown) => {
      new Notice(STRINGS.settings.consoleOpenFailed(error instanceof Error ? error.message : String(error)));
    });
  }

  onunload(): void {
    void this.#console.stop();
  }

  async onload(): Promise<void> {
    this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData() as Partial<EkdSettings> | null ?? {}) };
    this.#reportValidator = createSmokeReportSchemaValidator(JSON.parse(__SMOKE_REPORT_SCHEMA_JSON__) as unknown);
    this.#pluginReportValidator = createSmokeReportSchemaValidator(JSON.parse(__PLUGIN_SNAPSHOT_REPORT_SCHEMA_JSON__) as unknown);
    this.#snapshotStatus = this.addStatusBarItem();
    this.#snapshotStatus.setText(STRINGS.statusBar.idle);
    this.addSettingTab(new Phase1SettingTab(this.app, this));
    this.registerView(VIEW_TYPE_EKD_P0_SNAPSHOT, (leaf) => new P0SnapshotView(leaf, {
      onTrigger: () => { void this.runSnapshot(); },
      onOpenReport: (reportPath) => { this.#openReportFile(reportPath); },
      isRunning: () => this.#running,
      consoleAvailable: () => this.#console.running,
      onOpenConsole: () => {
        try {
          this.#openConsoleInBrowser();
        } catch (error) {
          new Notice(STRINGS.settings.consoleOpenFailed(error instanceof Error ? error.message : String(error)));
        }
      }
    }));
    this.addRibbonIcon("lock", STRINGS.view.header, () => { void this.activateSnapshotView(); });
    this.registerView(VIEW_TYPE_EKD_TEAM, (leaf) => new TeamView(leaf, {
      refresh: () => { void this.teamRefresh(); },
      submit: (title, content) => { void this.teamSubmit(title, content); },
      approve: (proposalId) => { void this.teamApprove(proposalId); },
      isBusy: () => this.#teamBusy,
      isReviewer: () => this.#teamIsReviewer
    }));
    this.addRibbonIcon("users", STRINGS.team.viewTitle, () => { void this.activateTeamView(); });
    this.addCommand({
      id: "p0-create-snapshot",
      name: STRINGS.commands.createSnapshot,
      callback: () => { void this.activateSnapshotView().then(() => this.runSnapshot()); }
    });
    if (this.settings.consoleEnabled) void this.#startConsole();
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
    if (!isBuildMeta(value)) throw new Error(STRINGS.faults.buildMetaInvalid);
    const mainBytes = new Uint8Array(await this.app.vault.adapter.readBinary(normalizePath(`${pluginRoot}/main.js`)));
    if (sha256Hex(mainBytes) !== value.bundle_sha256) throw new Error(STRINGS.faults.bundleMismatch);
    return value;
  }

  #showSnapshotProgress(progress: PluginSnapshotProgress): void {
    let text: string;
    if (progress.phase === "scanning") {
      text = progress.status === "active"
        ? STRINGS.statusBar.scanningActive(progress.scannedFiles)
        : STRINGS.statusBar.scanningDone(progress.fileCount, progress.totalPlaintextBytes);
    } else if (progress.phase === "encrypting") {
      text = progress.status === "active"
        ? STRINGS.statusBar.encryptingActive(progress.fileOrdinal, progress.fileCount, progress.totalPlaintextBytes)
        : STRINGS.statusBar.encryptingDone(progress.fileCount);
    } else {
      text = progress.status === "verifying"
        ? STRINGS.statusBar.recoveryVerifying
        : STRINGS.statusBar.recoveryDone;
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
    if (typeof nodeRequire !== "function") throw new Error(STRINGS.faults.nodeLoaderUnavailable);
    const electron = nodeRequire("electron") as { shell?: { openPath?: (path: string) => Promise<string> } };
    const openPath = electron.shell?.openPath;
    if (typeof openPath !== "function") throw new Error(STRINGS.faults.electronOpenPathUnavailable);
    void openPath.call(electron.shell, reportPath).then((message) => {
      if (typeof message === "string" && message.length > 0) new Notice(STRINGS.view.openReportFailed(message));
    });
  }

  #teamBusy = false;
  #teamIsReviewer = false;

  async activateTeamView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_EKD_TEAM);
    const leaf = existing[0] ?? this.app.workspace.getRightLeaf(false);
    if (leaf === null) return;
    if (existing.length === 0) await leaf.setViewState({ type: VIEW_TYPE_EKD_TEAM, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  #syncTeamView(): void {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_EKD_TEAM)[0];
    if (leaf !== undefined) (leaf.view as TeamView).updateFromModel(this.#teamModel.render);
  }

  #teamDeps(): ConstructorParameters<typeof TeamHost>[0] | undefined {
    if (this.settings.teamStateDir.trim().length === 0 || !/^[0-9a-f]{32}$/u.test(this.settings.teamDeviceId)) return undefined;
    const keyAgreement = new WebCryptoKeyAgreementProvider();
    const reviewerKey = this.settings.teamReviewerPrivateKeyPkcs8Base64url.trim();
    const reviewerId = this.settings.teamReviewerId.trim();
    return {
      domainIdSha256: sha256Hex(new TextEncoder().encode(this.settings.domainIdHex.trim() || "team-domain")),
      teamStateDir: this.settings.teamStateDir.trim(),
      teamDeviceId: this.settings.teamDeviceId,
      authoritySpkiBase64url: this.settings.teamAuthoritySpkiBase64url.trim(),
      keyAgreement,
      aead: new WebCryptoAes256Provider(),
      reviewerPrivateKeyPkcs8Base64url: reviewerKey.length > 0 ? reviewerKey : undefined,
      reviewerId: reviewerId.length > 0 ? reviewerId : undefined
    };
  }

  async teamRefresh(): Promise<void> {
    if (this.settings.teamStateDir.trim().length === 0 || !/^[0-9a-f]{32}$/u.test(this.settings.teamDeviceId)) {
      this.#teamModel.setUnconfigured();
      this.#syncTeamView();
      return;
    }
    this.#teamModel.setBusy();
    this.#syncTeamView();
    try {
      const deps = this.#teamDeps();
      if (deps === undefined) {
        this.#teamModel.setUnconfigured();
        this.#syncTeamView();
        return;
      }
      this.#teamHost = new TeamHost(deps);
      const snapshot = await this.#teamHost.refresh();
      this.#teamIsReviewer = snapshot.isReviewer;
      this.#teamModel.setReady({
        epoch: snapshot.epoch,
        memberCount: snapshot.memberCount,
        proposals: snapshot.proposals.map((entry) => ({
          proposalId: entry.proposal_id,
          title: entry.title,
          authorDeviceId: entry.author_device_id,
          createdAt: entry.created_at,
          approvals: entry.approvals.length,
          accepted: entry.approvals.length > 0
        })),
        isReviewer: snapshot.isReviewer
      });
    } catch (error) {
      this.#teamModel.setError(error instanceof Error ? error.message : String(error));
    }
    this.#syncTeamView();
  }

  async teamSubmit(title: string, content: string): Promise<void> {
    if (this.#teamBusy) return;
    this.#teamBusy = true;
    this.#syncTeamView();
    try {
      if (this.#teamHost === undefined) throw new Error("团队域未初始化。");
      const summary = await this.#teamHost.submit({ title, content });
      new Notice(STRINGS.team.submittedNotice);
      await this.teamRefresh();
      void summary;
    } catch (error) {
      new Notice(`${STRINGS.team.errorPrefix}${error instanceof Error ? error.message : String(error)}`, 10000);
    } finally {
      this.#teamBusy = false;
      this.#syncTeamView();
    }
  }

  async teamApprove(proposalId: string): Promise<void> {
    try {
      if (this.#teamHost === undefined) throw new Error("团队域未初始化。");
      await this.#teamHost.approve(proposalId);
      new Notice(STRINGS.team.approvedNotice);
      await this.teamRefresh();
    } catch (error) {
      new Notice(`${STRINGS.team.errorPrefix}${error instanceof Error ? error.message : String(error)}`, 10000);
    }
  }

  async runSnapshot(): Promise<void> {
    if (this.#running) {
      new Notice(STRINGS.notices.operationActive);
      return;
    }
    this.#running = true;
    this.#panelModel.reset();
    this.#syncSnapshotView();
    let snapshotErrorCode: string | undefined;
    try {
      this.#snapshotStatus?.setText(STRINGS.statusBar.waitingSettings);
      await this.#settingsWrites;
      if (!Platform.isDesktopApp || !Platform.isWin) {
        throw new Error("P0 快照目前仅限 Windows 桌面端的 Obsidian。");
      }
      // Electron's renderer blocks ESM dynamic import of node: specifiers (CORS on
      // app://obsidian.md); Obsidian desktop exposes the CJS loader instead.
      const nodeRequire = (globalThis as { require?: (id: string) => unknown }).require;
      if (typeof nodeRequire !== "function") {
        throw new Error(STRINGS.faults.nodeLoaderUnavailable);
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
        throw new Error(STRINGS.faults.vaultPathUnavailable);
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
        throw new Error(STRINGS.faults.limitsEmbeddedMismatch);
      }
      const embeddedLimits = JSON.parse(__P0_RUNTIME_LIMITS_JSON__) as { readonly schema_version?: unknown };
      if (embeddedLimits.schema_version !== "p0-runtime-limits-v1") {
        throw new Error(STRINGS.faults.limitsEmbeddedWrongVersion);
      }
      const diskLimitsBytes = new Uint8Array(await nodeFs.readFile(runtimeLimitsPath));
      const diskLimitsSha256 = sha256Hex(diskLimitsBytes);
      if (diskLimitsSha256 !== PLUGIN_ACCEPTED_RUNTIME_LIMITS_SHA256) {
        throw new Error(STRINGS.faults.limitsHashMismatch(diskLimitsSha256));
      }
      const diskLimits = JSON.parse(new TextDecoder().decode(diskLimitsBytes)) as { readonly schema_version?: unknown };
      if (diskLimits.schema_version !== "p0-runtime-limits-v1") {
        throw new Error(STRINGS.faults.limitsNotContract);
      }
      if (this.#pluginReportValidator === undefined) {
        throw new Error(STRINGS.faults.reportValidatorUnavailable);
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
      this.#snapshotStatus?.setText(STRINGS.statusBar.starting);
      const snapshotStartedAt = new Date().toISOString();
      const snapshotStartMs = Date.now();
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
        const errorCode = execution.snapshot.errorCode ?? "SNAPSHOT_FAILED";
        // ADR-0031 §13: pipeline failures feed the console task ring (counters stay 0).
        const normalizedCode = /^[A-Z][A-Z0-9_]*$/.test(errorCode) ? errorCode : "SNAPSHOT_FAILED";
        snapshotErrorCode = normalizedCode === "SNAPSHOT_FAILED" ? undefined : normalizedCode;
        // ADR-0031 §13: pipeline failures feed the console task ring (counters stay 0).
        this.#console.recordSnapshotFailure(
          normalizedCode,
          snapshotStartedAt,
          new Date().toISOString(),
          Date.now() - snapshotStartMs
        );
        throw new Error(
          `快照在 ${execution.snapshot.failedPhase ?? "未知阶段"} 失败（${errorCode}）；未导出通过报告。`
        );
      }
      this.#console.recordSnapshotSuccess({
        schema_version: execution.report.schema_version,
        verdict: execution.report.verdict,
        created_at: execution.report.completed_at,
        object_count: execution.report.visibility_summary.object_count,
        total_ciphertext_bytes: execution.report.total_ciphertext_bytes
      }, snapshotStartedAt, Date.now() - snapshotStartMs);
      this.#showSnapshotResult(execution.report, snapshotReportPath);
      const summary = execution.report.visibility_summary;
      this.#snapshotStatus?.setText(
        STRINGS.statusBar.complete(execution.report.file_count, execution.report.total_plaintext_bytes, summary.total_ciphertext_bytes)
      );
      new Notice(
        STRINGS.notices.snapshotComplete(summary.object_count, execution.report.file_count),
        10000
      );
    } catch (error) {
      console.error("EKD P0 snapshot failed", error);
      this.#snapshotStatus?.setText(STRINGS.statusBar.failed);
      this.#panelModel.onError(error, STRINGS.errors.hintFor(snapshotErrorCode));
      this.#syncSnapshotView();
      new Notice(STRINGS.notices.snapshotFailed(error instanceof Error ? error.message : String(error)), 10000);
    } finally {
      this.#running = false;
      // The catch path renders while #running is still true; re-sync so the panel
      // button does not stay stuck on the stale running state after a failure.
      this.#syncSnapshotView();
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
      new Notice(STRINGS.faults.smokeActive);
      return;
    }
    this.#running = true;
    try {
      if (!Platform.isAndroidApp && !Platform.isWin) throw new Error(STRINGS.faults.smokePlatformScope);
      if (Platform.isAndroidApp && [
        this.settings.androidDeviceModel,
        this.settings.androidOsVersion,
        this.settings.androidArchitecture
      ].some((value) => value.length === 0)) {
        throw new Error(STRINGS.faults.smokeAndroidFieldsRequired);
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
      const mode = meta.source_tree_state === "clean" ? STRINGS.faults.smokeFormal : STRINGS.faults.smokeDirtyDev;
      new Notice(STRINGS.faults.smokeComplete(selected, report.aggregate.verdict, mode));
    } catch (error) {
      console.error("EKD Phase 1 smoke failed", error);
      new Notice(STRINGS.faults.smokeFailed(error instanceof Error ? error.message : String(error)), 10000);
    } finally {
      this.#running = false;
    }
  }
}
