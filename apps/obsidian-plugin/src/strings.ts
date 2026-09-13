// 插件中文本地化（开发者 2026-09-05 推迟、2026-09-12 随 DP-018 轮重启授权）：
// 单一 zh-CN 资源模块，纯 UI 层——协议归一化错误码、schema 字段与 evidence 文本保持原样，
// 只有面向用户的界面文案与通知走这里。新增用户可见文案必须先落本模块，禁止散落硬编码。
export const STRINGS = {
  view: {
    title: "EKD 快照",
    header: "EKD P0 快照",
    description: "通过共享核心为本 Vault 创建 P0 快照。Vault 永不被写入；日志、存储、恢复文件与报告目标均来自插件设置。",
    createSnapshot: "创建快照",
    snapshotRunning: "快照运行中…",
    progress: "进度",
    noRunYet: "本次会话还没有快照运行。",
    lastResult: "最近结果",
    idle: "空闲。",
    failedPrefix: "失败：",
    failedHint: "请检查插件设置（域 ID 与输出路径），并确认各目标尚不存在。",
    openReport: "打开报告文件",
    openReportFailed: (message: string) => `无法打开报告：${message}`,
    openConsole: "打开状态页",
    consoleHint: "状态页仅监听本机 127.0.0.1，只读展示进程/存储/任务摘要。",
    visibilityScopeNote: (scope: string) => `可见性摘要范围：${scope}（非正式 ACC-32/33 证据）。`,
    table: {
      runId: "运行 ID",
      snapshotId: "快照 ID",
      files: "文件数",
      plaintextBytes: "明文字节",
      ciphertextBytes: "密文字节",
      objects: "对象数",
      completedAt: "完成时间"
    }
  },
  statusBar: {
    idle: "EKD 快照：空闲",
    waitingSettings: "EKD 快照：等待设置写入",
    starting: "EKD 快照：启动中",
    failed: "EKD 快照：失败",
    scanningActive: (count: number) => `EKD 快照：扫描中，已扫 ${count} 个文件`,
    scanningDone: (files: number, bytes: number) => `EKD 快照：扫描完成 ${files} 个文件 / ${bytes} 明文字节`,
    encryptingActive: (ordinal: number, total: number, bytes: number) => `EKD 快照：加密 ${ordinal}/${total}，累计 ${bytes} 明文字节`,
    encryptingDone: (files: number) => `EKD 快照：已加密 ${files} 个文件`,
    recoveryVerifying: "EKD 快照：正在验证恢复文件持有权",
    recoveryDone: "EKD 快照：恢复文件持有权验证完成",
    complete: (files: number, plain: number, cipher: number) => `EKD 快照完成：${files} 个文件，${plain} 明文 / ${cipher} 密文字节`
  },
  panel: {
    scanActive: (count: number) => `扫描：${count} 个文件…`,
    scanDone: (files: number, bytes: number) => `扫描完成：${files} 个文件，${bytes} 明文字节。`,
    encryptActive: (ordinal: number, total: number, bytes: number) => `加密：${ordinal}/${total} — 累计 ${bytes} 明文字节。`,
    encryptDone: (files: number) => `已加密 ${files} 个文件。`,
    recoveryVerifying: "恢复文件：验证持有中…",
    recoveryDone: "恢复文件：持有权验证完成（独占写入 + 字节一致回读）。",
    complete: (files: number, plain: number, cipher: number, objects: number) =>
      `快照完成：${files} 个文件，${plain} 明文 / ${cipher} 密文字节，${objects} 个对象。`,
    failed: (message: string) => `快照失败：${message}`
  },
  notices: {
    operationActive: "已有 EKD 操作正在进行。",
    settingsLocked: "EKD 操作进行中，设置暂不可修改。",
    snapshotComplete: (objects: number, files: number) =>
      `P0 快照完成：${objects} 个对象 / ${files} 个文件。可见性摘要不是正式 ACC-32/33 证据。`,
    snapshotFailed: (message: string) => `P0 快照失败：${message}`,
    snapshotFailedWindow: "本机运行异常，请查看控制台日志。恢复文件没有产生。请检查：\n1. 存储目录/日志/恢复文件路径是否有效；\n2. 上次失败残留的目标文件是否已清理。"
  },
  settings: {
    snapshotSection: "EKD P0 快照",
    snapshotIntro: "仅限 Windows 桌面端。所有路径必须显式给出；ObjectStore 目录与各输出父目录必须已存在且在源 Vault 之外。快照绝不向 Vault 写入任何协议产物。",
    domainId: "域 ID",
    domainIdHint: "64 位小写十六进制字符",
    objectStore: "ObjectStore 目录",
    absoluteDirHint: "已存在目录的绝对路径",
    snapshotLog: "快照日志",
    newJsonlHint: "新 .jsonl 文件的绝对路径",
    recoveryFile: "恢复文件",
    newEkdrHint: "新 .ekdr 文件的绝对路径",
    runtimeLimits: "运行时上限合同",
    runtimeLimitsHint: "p0-runtime-limits-v1.json 的绝对路径",
    snapshotReport: "插件快照报告",
    newJsonHint: "新 .json 报告文件的绝对路径",
    androidSection: "EKD Phase 1 Android 冒烟元数据",
    androidIntro: "这些字段描述实体 Android 冒烟环境。生成的密钥把报告绑定到本插件运行时，不是生产密钥库或硬件认证。",
    deviceModel: "设备型号",
    deviceModelHint: "例如：Pixel 8",
    androidVersion: "Android 版本",
    androidVersionHint: "例如：Android 16",
    architecture: "架构",
    architectureHint: "例如：arm64-v8a",
    consoleSection: "EKD 本机状态页（只读）",
    consoleIntro: "ADR-0030/0031：启用后插件在本机 127.0.0.1 随机端口运行只读状态服务（进程健康、密文侧存储统计、最近快照任务）。服务不经 URL/日志传递凭据，不提供任何写操作，不监听局域网。默认关闭。",
    consoleToggle: "启用本机状态页",
    consoleEnabled: (url: string) => `EKD 状态页已启用：${url}（仅本机 127.0.0.1，只读）`,
    consoleStartFailed: (message: string) => `EKD 状态页启动失败：${message}`,
    consoleNotEnabled: "EKD 状态页未启用；请先在设置中开启。",
    consoleOpenFailed: (message: string) => `无法打开状态页：${message}`
  },
  errors: {
    /** 常见 preflight/流水线归一化错误码的可操作提示（交互友好：告诉用户下一步做什么）。 */
    hints: {
      UNSUPPORTED_FILES_FOUND: "Vault 内含不支持的文件类型（如 .base 等非 Markdown 附件）。请移出这些文件后重试。",
      LOG_WRITE_FAILED: "快照日志写入失败。最常见原因：上一次运行（含失败运行）已创建了同名日志文件——独占创建语义不会覆盖，请删除或更换日志路径后重试。",
      RECOVERY_FILE_WRITE_FAILED: "恢复文件写入失败。恢复文件必须是不存在的新文件——请删除或更换路径后重试。",
      ENTRY_PATH_ESCAPE: "扫描发现越界路径（符号链接或目录穿越）。请移出 Vault 内的链接类文件后重试。",
      CASE_COLLISION: "目标目录存在仅大小写不同的同名文件，Windows 无法安全写入。请调整恢复目标后重试。",
      NON_EMPTY_TARGET: "恢复目标目录已存在且非空。恢复只允许写入空目录。",
      ENTRY_PATH_DUPLICATE: "Vault 内存在逻辑路径重复的文件，无法生成唯一对象引用。",
      ENTRY_SIZE_MISMATCH: "文件在扫描与读取之间发生变化。请重试快照。",
      FILE_CHANGED_DURING_SCAN: "文件在扫描过程中被修改。请暂停占用该文件的程序后重试。",
      SOURCE_FILE_READ_FAILED: "源文件读取失败。请检查文件是否被占用或已删除。",
      REPARSE_POINT_FOUND: "存储/日志/恢复路径中存在符号链接或 Junction。请改用真实目录。"
    },
    genericHint: "请检查插件设置与目标路径后重试。",
    hintFor(errorCode: string | undefined): string {
      if (errorCode !== undefined && errorCode in this.hints) {
        return this.hints[errorCode as keyof typeof this.hints];
      }
      return this.genericHint;
    }
  },
  commands: {
    createSnapshot: "创建 P0 快照",
    smoke: (candidate: string) => `运行 Phase 1 冒烟：${candidate}`
  },
  team: {
    viewTitle: "EKD 团队",
    unconfigured: "团队域未配置：请在设置中填写团队域状态目录与本设备 ID。",
    errorPrefix: "团队面板错误：",
    epochInfo: (epoch: number, members: number) => `当前 epoch ${epoch} · 成员 ${members} 人`,
    submitTitle: "提交提案",
    titlePlaceholder: "提案标题",
    contentPlaceholder: "提案内容",
    submitting: "提交中…",
    submitButton: "提交提案",
    listTitle: "提案列表",
    noProposals: "暂无提案。",
    proposalMeta: (at: string, approvals: number) => `${at} · 已获 ${approvals} 项审批`,
    approveButton: "审批通过",
    acceptedLabel: "已获所需审批",
    refresh: "刷新",
    approvedNotice: "审批已签名并写入提案。",
    submittedNotice: "提案已加密提交。",
    refreshNotice: "团队状态已刷新。"
  },
  faults: {
    domainIdInvalid: "域 ID 必须是恰好 64 位小写十六进制字符。",
    pathMustBeAbsolute: (label: string) => `${label} 必须是显式的绝对路径。`,
    nodeLoaderUnavailable: "未获得 Node 模块加载器，无法加载文件系统适配器。",
    vaultPathUnavailable: "Obsidian 未暴露桌面 Vault 的文件系统路径。",
    electronOpenPathUnavailable: "当前运行时不可用 Electron shell.openPath。",
    electronOpenExternalUnavailable: "当前运行时不可用 Electron shell.openExternal。",
    buildMetaInvalid: "Phase 1 插件构建元数据无效。",
    bundleMismatch: "插件包与构建元数据不一致。",
    limitsEmbeddedMismatch: "内嵌运行时上限字节与已接受合同哈希不一致。",
    limitsEmbeddedWrongVersion: "内嵌运行时上限副本不是 p0-runtime-limits-v1。",
    limitsHashMismatch: (sha: string) => `配置的运行时上限 sha256 ${sha} 与已接受合同不一致。`,
    limitsNotContract: "配置的运行时上限文件不是 p0-runtime-limits-v1。",
    reportValidatorUnavailable: "快照报告校验器不可用。",
    smokeActive: "已有 Phase 1 冒烟运行在进行。",
    smokePlatformScope: "Phase 1 插件冒烟仅限 Windows 与 Android。",
    smokeAndroidFieldsRequired: "运行 Android 冒烟前请先填写设备型号、Android 版本与架构。",
    smokeComplete: (candidate: string, verdict: string, mode: string) => `Phase 1 ${candidate} 冒烟：${verdict}；${mode}。`,
    smokeFailed: (message: string) => `Phase 1 冒烟失败：${message}`,
    smokeFormal: "正式",
    smokeDirtyDev: "仅开发（源码树不干净；不能关闭 DP）"
  }
} as const;
