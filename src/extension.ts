import * as http from 'http';
import * as https from 'https';
import * as vscode from 'vscode';
import { LanguageServerCandidate, WindowsProcessDiscovery } from './windowsProcessDiscovery';

type SnapshotSource = 'api' | 'estimate' | 'mixed';

interface ExtensionConfig {
  pollIntervalSeconds: number;
  requestTimeoutMs: number;
  historySize: number;
  defaultContextLimit: number;
  modelContextOverrides: Record<string, number>;
  enableVerboseLogs: boolean;
}

interface ApiResponse<T = unknown> {
  statusCode: number;
  body: T | undefined;
  rawText: string;
}

interface ProbeResult {
  useTls: boolean;
}

interface LanguageServerConnection {
  candidate: LanguageServerCandidate;
  useTls: boolean;
}

interface TrajectorySummary {
  cascadeId: string;
  trajectoryId: string;
  summary: string;
  stepCount: number;
  status: string;
  lastModifiedTime: string;
  requestedModel: string;
  generatorModel: string;
  workspaceUris: string[];
}

interface ModelConfig {
  model: string;
  label: string;
}

const DEFAULT_MODEL_DISPLAY_NAMES: Record<string, string> = {
  MODEL_PLACEHOLDER_M37: 'Gemini 3.1 Pro (High)',
  MODEL_PLACEHOLDER_M36: 'Gemini 3.1 Pro (Low)',
  MODEL_PLACEHOLDER_M18: 'Gemini 3 Flash',
  MODEL_PLACEHOLDER_M35: 'Claude Sonnet 4.6 (Thinking)',
  MODEL_PLACEHOLDER_M26: 'Claude Opus 4.6 (Thinking)',
  MODEL_OPENAI_GPT_OSS_120B_MEDIUM: 'GPT-OSS 120B (Medium)',
};

interface ComputedUsage {
  contextUsed: number;
  totalOutputTokens: number;
  estimatedDeltaSinceCheckpoint: number;
  model: string;
  hasCheckpoint: boolean;
}

interface UsageSnapshot {
  title: string;
  model: string;
  modelDisplayName: string;
  usedTokens: number;
  maxTokens: number;
  remainingTokens: number;
  percentUsed: number;
  source: SnapshotSource;
  endpoint: string;
  port: number;
  pid: number;
  timestamp: number;
  sessionId: string;
  csrfTokenPresent: boolean;
  notes: string[];
  stepCount: number;
  status: string;
}

let monitor: AntigravityContextMonitor | undefined;

export function activate(context: vscode.ExtensionContext): void {
  monitor = new AntigravityContextMonitor(context);
  monitor.start();
}

export function deactivate(): void {
  monitor?.dispose();
  monitor = undefined;
}

class AntigravityContextMonitor implements vscode.Disposable {
  private readonly output = vscode.window.createOutputChannel('Antigravity Context Monitor');
  private readonly statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  private readonly refreshStatusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  private readonly discovery = new WindowsProcessDiscovery(this.output, () => this.getConfig());
  private readonly history: UsageSnapshot[] = [];
  private readonly modelDisplayNames = new Map<string, string>(Object.entries(DEFAULT_MODEL_DISPLAY_NAMES));
  private readonly previousStepCounts = new Map<string, number>();
  private readonly previousTrajectoryIds = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private cachedConnection: LanguageServerConnection | undefined;
  private lastWorkspaceFingerprint = '';
  private lastImplicitRefreshKey = '';
  private pendingForceRefresh = false;
  private pollInFlight = false;
  private trackedCascadeId: string | undefined;
  private firstPollCompleted = false;
  private lastError = 'Waiting for Antigravity language server / 等待 Antigravity 语言服务器';

  constructor(private readonly context: vscode.ExtensionContext) {}

  start(): void {
    this.statusBar.name = 'Antigravity Context Usage / 上下文使用量';
    this.statusBar.command = 'antigravityContextMonitor.showHistory';
    this.statusBar.text = '$(pulse) AG context: starting / 启动中';
    this.statusBar.tooltip = 'Antigravity context monitor is starting / Antigravity 上下文监控启动中';
    this.statusBar.show();

    this.refreshStatusBar.name = 'Antigravity Context Refresh / 刷新上下文';
    this.refreshStatusBar.command = 'antigravityContextMonitor.refresh';
    this.refreshStatusBar.text = '$(refresh)';
    this.refreshStatusBar.tooltip = 'Refresh and re-detect current model / 刷新并重新检测当前模型';
    this.refreshStatusBar.show();

    this.context.subscriptions.push(
      this.statusBar,
      this.refreshStatusBar,
      this.output,
      vscode.commands.registerCommand('antigravityContextMonitor.showHistory', () => this.showHistory()),
      vscode.commands.registerCommand('antigravityContextMonitor.refresh', async () => {
        await this.forceRefresh();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('antigravityContextMonitor')) {
          this.log('Configuration changed; restarting poll timer.');
          this.cachedConnection = undefined;
          this.startTimer();
          void this.poll(true);
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        this.log('Workspace folders changed; forcing rediscovery.');
        this.clearWindowState();
        void this.poll(true);
      }),
      vscode.window.onDidChangeActiveTextEditor(() => {
        const fingerprint = this.getWorkspaceFingerprint();
        if (fingerprint !== this.lastWorkspaceFingerprint) {
          this.log('Active editor changed window fingerprint; forcing rediscovery.');
          this.clearWindowState();
          void this.poll(true);
        }
      }),
      this,
    );

    this.startTimer();
    void this.poll(true);
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async forceRefresh(): Promise<void> {
    this.log('Manual refresh requested.');
    this.clearWindowState();
    this.pendingForceRefresh = true;
    this.refreshStatusBar.text = '$(sync~spin)';
    this.refreshStatusBar.tooltip = 'Refreshing and re-detecting current model / 正在刷新并重新检测当前模型';
    await this.poll(true);
  }

  private startTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }

    const intervalMs = Math.max(2, this.getConfig().pollIntervalSeconds) * 1000;
    this.timer = setInterval(() => {
      void this.poll(false);
    }, intervalMs);
  }

  private clearWindowState(): void {
    this.cachedConnection = undefined;
    this.trackedCascadeId = undefined;
    this.lastImplicitRefreshKey = '';
    this.previousStepCounts.clear();
    this.previousTrajectoryIds.clear();
    this.firstPollCompleted = false;
  }

  private async poll(forceRediscover: boolean): Promise<void> {
    if (this.pollInFlight) {
      if (forceRediscover) {
        this.pendingForceRefresh = true;
        this.log('Force refresh queued while polling is already in flight.');
        this.refreshStatusBar.text = '$(sync~spin)';
        this.refreshStatusBar.tooltip = 'Refresh queued; waiting for current poll / 已排队刷新，等待当前轮询完成';
      }
      return;
    }

    this.pendingForceRefresh = false;
    this.pollInFlight = true;
    try {
      const snapshot = await this.readCurrentSnapshot(forceRediscover);
      if (snapshot) {
        this.lastError = '';
        this.renderSnapshot(snapshot);
        return;
      }

      this.renderUnavailable(this.lastError);
    } catch (error) {
      this.lastError = formatError(error);
      this.log(`Polling failed: ${this.lastError}`);
      this.renderUnavailable(this.lastError);
    } finally {
      this.pollInFlight = false;
      if (this.pendingForceRefresh) {
        this.pendingForceRefresh = false;
        void this.poll(true);
      }
    }
  }

  private async readCurrentSnapshot(forceRediscover: boolean): Promise<UsageSnapshot | undefined> {
    const workspaceFingerprint = this.getWorkspaceFingerprint();
    if (workspaceFingerprint !== this.lastWorkspaceFingerprint) {
      this.clearWindowState();
      this.lastWorkspaceFingerprint = workspaceFingerprint;
    }

    let connection = await this.getConnection(forceRediscover);
    if (!connection) {
      this.lastError = 'Antigravity language server process not found / 未找到 Antigravity 语言服务器进程';
      return undefined;
    }

    try {
      await this.refreshModelDisplayNames(connection);
    } catch (error) {
      this.log(`Refreshing model display names failed: ${formatError(error)}`);
    }

    let trajectories: TrajectorySummary[];
    try {
      trajectories = await this.getAllTrajectories(connection);
    } catch (error) {
      if (forceRediscover) {
        throw error;
      }

      this.log(`Reading trajectories failed, retrying with rediscovery: ${formatError(error)}`);
      this.cachedConnection = undefined;
      connection = await this.getConnection(true);
      if (!connection) {
        this.lastError = 'Antigravity language server connection lost / Antigravity 语言服务器连接已断开';
        return undefined;
      }

      try {
        await this.refreshModelDisplayNames(connection);
      } catch (refreshError) {
        this.log(`Refreshing model display names after rediscovery failed: ${formatError(refreshError)}`);
      }

      trajectories = await this.getAllTrajectories(connection);
    }

    if (trajectories.length === 0) {
      this.lastError = 'No Antigravity conversations found / 未找到 Antigravity 对话';
      this.updateBaselines([]);
      return undefined;
    }

    const activeTrajectory = this.selectActiveTrajectory(trajectories);
    if (!activeTrajectory) {
      this.lastError = 'No Antigravity conversation found for this window / 当前窗口未找到对应对话';
      this.updateBaselines(trajectories);
      return undefined;
    }

    if (this.shouldImplicitlyRefresh(forceRediscover, activeTrajectory)) {
      this.log(`Implicit refresh triggered for ${activeTrajectory.cascadeId} after activity.`);
      this.cachedConnection = undefined;
      return this.readCurrentSnapshot(true);
    }

    let usage: ComputedUsage;
    try {
      usage = await this.getTrajectoryUsage(connection, activeTrajectory);
    } catch (error) {
      if (forceRediscover) {
        throw error;
      }

      this.log(`Reading trajectory usage failed, retrying with rediscovery: ${formatError(error)}`);
      this.cachedConnection = undefined;
      connection = await this.getConnection(true);
      if (!connection) {
        this.lastError = 'Antigravity language server connection lost / Antigravity 语言服务器连接已断开';
        return undefined;
      }

      usage = await this.getTrajectoryUsage(connection, activeTrajectory);
    }

    const model = usage.model || activeTrajectory.requestedModel || activeTrajectory.generatorModel || 'unknown';
    const maxTokens = inferContextLimit(model, this.getConfig());
    const usedTokens = Math.max(0, Math.round(usage.contextUsed));
    const remainingTokens = Math.max(0, maxTokens - usedTokens);
    const percentUsed = roundToSingleDecimal((usedTokens / Math.max(1, maxTokens)) * 100);
    const source: SnapshotSource = usage.hasCheckpoint
      ? (usage.estimatedDeltaSinceCheckpoint > 0 ? 'mixed' : 'api')
      : 'estimate';

    this.trackedCascadeId = activeTrajectory.cascadeId;
    this.updateBaselines(trajectories);

    const snapshot: UsageSnapshot = {
      title: activeTrajectory.summary || activeTrajectory.cascadeId,
      model,
      modelDisplayName: resolveModelDisplayName(model, this.modelDisplayNames),
      usedTokens,
      maxTokens,
      remainingTokens,
      percentUsed,
      source,
      endpoint: '/exa.language_server_pb.LanguageServerService/GetCascadeTrajectorySteps',
      port: connection.candidate.port,
      pid: connection.candidate.pid,
      timestamp: Date.now(),
      sessionId: activeTrajectory.cascadeId,
      csrfTokenPresent: Boolean(connection.candidate.csrfToken),
      notes: connection.candidate.notes,
      stepCount: activeTrajectory.stepCount,
      status: activeTrajectory.status,
    };

    this.recordSnapshot(snapshot);
    return snapshot;
  }

  private async getConnection(forceRediscover: boolean): Promise<LanguageServerConnection | undefined> {
    if (!forceRediscover && this.cachedConnection) {
      return this.cachedConnection;
    }

    const discovered = await this.discovery.discoverCandidates(vscode.workspace.workspaceFolders ?? []);
    for (const candidate of discovered) {
      const probe = await this.probeTransport(candidate);
      if (probe) {
        this.cachedConnection = { candidate, useTls: probe.useTls };
        return this.cachedConnection;
      }
    }

    this.cachedConnection = undefined;
    return undefined;
  }

  private async probeTransport(target: LanguageServerCandidate): Promise<ProbeResult | undefined> {
    for (const useTls of [true, false]) {
      const response = await this.postJson(
        target,
        '/exa.language_server_pb.LanguageServerService/GetUnleashData',
        {
          metadata: {
            ideName: 'antigravity',
            extensionName: 'antigravity',
            ideVersion: 'unknown',
            locale: 'en',
          },
        },
        useTls,
      );

      if (response) {
        this.log(`Probe succeeded on port ${target.port} via ${useTls ? 'https' : 'http'}.`);
        return { useTls };
      }
    }

    this.log(`No responsive transport found on port ${target.port}.`);
    return undefined;
  }

  private async refreshModelDisplayNames(connection: LanguageServerConnection): Promise<void> {
    const response = await this.rpcCall(connection, 'GetUserStatus', {
      metadata: {
        ideName: 'antigravity',
        extensionName: 'antigravity',
      },
    });

    const configs = readPath(response.body, 'userStatus.cascadeModelConfigData.clientModelConfigs');
    if (!Array.isArray(configs)) {
      return;
    }

    for (const item of configs) {
      const label = readPath(item, 'label');
      if (typeof label !== 'string' || !label) {
        continue;
      }

      for (const model of getCandidateModelKeys(item)) {
        this.modelDisplayNames.set(model, label);
      }
    }
  }

  private async getAllTrajectories(connection: LanguageServerConnection): Promise<TrajectorySummary[]> {
    const response = await this.rpcCall(connection, 'GetAllCascadeTrajectories', {
      metadata: {
        ideName: 'antigravity',
        extensionName: 'antigravity',
      },
    });

    const summaries = readPath(response.body, 'trajectorySummaries');
    if (!summaries || typeof summaries !== 'object') {
      return [];
    }

    const trajectories: TrajectorySummary[] = [];
    for (const [cascadeId, rawValue] of Object.entries(summaries as Record<string, unknown>)) {
      if (!rawValue || typeof rawValue !== 'object') {
        continue;
      }

      const value = rawValue as Record<string, unknown>;
      const latestTaskBoundaryStep = readPath(value, 'latestTaskBoundaryStep.step.metadata');
      const latestNotifyUserStep = readPath(value, 'latestNotifyUserStep.step.metadata');
      const latestMetadata = latestNotifyUserStep ?? latestTaskBoundaryStep;

      const requestedModel = firstString(latestMetadata, [
        'requestedModel.model',
      ]) ?? '';
      const generatorModel = firstString(latestMetadata, [
        'generatorModel',
      ]) ?? '';

      const rawWorkspaces = value.workspaces;
      const workspaceUris: string[] = [];
      if (Array.isArray(rawWorkspaces)) {
        for (const rawWorkspace of rawWorkspaces) {
          const workspaceUri = readPath(rawWorkspace, 'workspaceFolderAbsoluteUri');
          if (typeof workspaceUri === 'string' && workspaceUri) {
            workspaceUris.push(workspaceUri);
          }
        }
      }

      trajectories.push({
        cascadeId,
        trajectoryId: stringFromUnknown(value.trajectoryId),
        summary: stringFromUnknown(value.summary) || cascadeId,
        stepCount: numberFromUnknown(value.stepCount),
        status: stringFromUnknown(value.status),
        lastModifiedTime: stringFromUnknown(value.lastModifiedTime),
        requestedModel,
        generatorModel,
        workspaceUris,
      });
    }

    trajectories.sort((left, right) => right.lastModifiedTime.localeCompare(left.lastModifiedTime));
    return trajectories;
  }

  private selectActiveTrajectory(trajectories: readonly TrajectorySummary[]): TrajectorySummary | undefined {
    const workspaceUri = this.getWorkspaceUri();
    const normalizedWorkspaceUri = workspaceUri ? normalizeUri(workspaceUri) : '';
    const qualified = trajectories.filter((trajectory) => {
      if (!workspaceUri) {
        return trajectory.workspaceUris.length === 0;
      }
      return trajectory.workspaceUris.some((uri) => normalizeUri(uri) === normalizedWorkspaceUri);
    });

    if (qualified.length === 0) {
      this.trackedCascadeId = undefined;
      return undefined;
    }

    const running = qualified.filter((trajectory) => trajectory.status === 'CASCADE_RUN_STATUS_RUNNING');
    if (running.length > 0) {
      return running.find((trajectory) => trajectory.cascadeId === this.trackedCascadeId) ?? running[0];
    }

    if (this.firstPollCompleted) {
      const changed = qualified.filter((trajectory) => {
        const previous = this.previousStepCounts.get(trajectory.cascadeId);
        return previous !== undefined && previous !== trajectory.stepCount;
      });
      if (changed.length > 0) {
        return changed.find((trajectory) => trajectory.cascadeId === this.trackedCascadeId) ?? changed[0];
      }

      const added = qualified.filter((trajectory) => !this.previousTrajectoryIds.has(trajectory.cascadeId));
      if (added.length > 0) {
        return added[0];
      }
    }

    if (this.trackedCascadeId) {
      const tracked = qualified.find((trajectory) => trajectory.cascadeId === this.trackedCascadeId);
      if (tracked) {
        return tracked;
      }
    }

    return qualified[0];
  }

  private async getTrajectoryUsage(
    connection: LanguageServerConnection,
    trajectory: TrajectorySummary,
  ): Promise<ComputedUsage> {
    const batchSize = 50;
    const maxConcurrentBatches = 5;
    const maxSteps = Math.max(trajectory.stepCount, 0);
    const batchRanges: Array<{ start: number; end: number }> = [];
    for (let start = 0; start < maxSteps; start += batchSize) {
      batchRanges.push({ start, end: Math.min(start + batchSize, maxSteps) });
    }

    const allSteps: Array<Record<string, unknown>> = [];
    for (let groupStart = 0; groupStart < batchRanges.length; groupStart += maxConcurrentBatches) {
      const group = batchRanges.slice(groupStart, groupStart + maxConcurrentBatches);
      const results = await Promise.allSettled(
        group.map((range) => this.rpcCall(connection, 'GetCascadeTrajectorySteps', {
          cascadeId: trajectory.cascadeId,
          startIndex: range.start,
          endIndex: range.end,
        })),
      );

      for (const result of results) {
        if (result.status !== 'fulfilled') {
          continue;
        }

        const steps = readPath(result.value.body, 'steps');
        if (Array.isArray(steps)) {
          for (const step of steps) {
            if (step && typeof step === 'object') {
              allSteps.push(step as Record<string, unknown>);
            }
          }
        }
      }
    }

    return computeUsageFromSteps(allSteps, trajectory.requestedModel || trajectory.generatorModel);
  }

  private async rpcCall(
    connection: LanguageServerConnection,
    method: string,
    body: Record<string, unknown>,
  ): Promise<ApiResponse> {
    const endpoint = `/exa.language_server_pb.LanguageServerService/${method}`;
    const response = await this.postJson(connection.candidate, endpoint, body, connection.useTls);
    if (!response) {
      throw new Error(`RPC ${method} failed`);
    }
    return response;
  }

  private async postJson(
    target: LanguageServerCandidate,
    endpoint: string,
    body: unknown,
    useTls: boolean,
  ): Promise<ApiResponse | undefined> {
    const payload = JSON.stringify(body ?? {});
    const timeoutMs = this.getConfig().requestTimeoutMs;
    const urlPath = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;

    return new Promise<ApiResponse | undefined>((resolve) => {
      const transport = useTls ? https : http;
      const request = transport.request(
        {
          host: '127.0.0.1',
          port: target.port,
          path: urlPath,
          method: 'POST',
          timeout: timeoutMs,
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload).toString(),
            'accept': 'application/json, text/plain, */*',
            'connect-protocol-version': '1',
            'x-codeium-csrf-token': target.csrfToken ?? '',
            'x-csrf-token': target.csrfToken ?? '',
            'csrf-token': target.csrfToken ?? '',
            'x-xsrf-token': target.csrfToken ?? '',
          },
          rejectUnauthorized: false,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk) => {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });
          response.on('end', () => {
            const rawText = Buffer.concat(chunks).toString('utf8').trim();
            const parsedBody = safeJsonParse(rawText);
            const statusCode = response.statusCode ?? 0;

            if (statusCode >= 200 && statusCode < 300) {
              resolve({ statusCode, body: parsedBody, rawText });
              return;
            }

            this.log(`Endpoint ${urlPath} on port ${target.port} via ${useTls ? 'https' : 'http'} returned HTTP ${statusCode}.`);
            resolve(undefined);
          });
        },
      );

      request.on('timeout', () => {
        request.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
      });
      request.on('error', (error) => {
        this.log(`Request to ${urlPath} on port ${target.port} via ${useTls ? 'https' : 'http'} failed: ${formatError(error)}`);
        resolve(undefined);
      });

      request.write(payload);
      request.end();
    });
  }

  private renderSnapshot(snapshot: UsageSnapshot): void {
    this.statusBar.text = `AG ${formatCompactNumber(snapshot.usedTokens)}/${formatCompactNumber(snapshot.maxTokens)} ${snapshot.percentUsed.toFixed(1)}%`;
    this.statusBar.tooltip = this.buildTooltip(snapshot);
    this.statusBar.command = 'antigravityContextMonitor.showHistory';
    this.refreshStatusBar.text = '$(refresh)';
    this.refreshStatusBar.tooltip = `Refresh and re-detect current model / 刷新并重新检测当前模型\nCurrent / 当前: ${snapshot.modelDisplayName}`;
    this.statusBar.show();
    this.refreshStatusBar.show();
  }

  private renderUnavailable(reason: string): void {
    this.statusBar.text = 'AG context: unavailable / 不可用';
    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.appendMarkdown('**Antigravity Context Monitor / 上下文监控**\n\n');
    tooltip.appendMarkdown(`- Status / 状态: ${escapeMarkdown(reason || 'No active session found / 未找到活跃会话')}\n`);
    tooltip.appendMarkdown('- Click to inspect the latest polling history / 点击查看最近轮询历史\n');
    tooltip.appendMarkdown('- Use the refresh button to re-detect the model / 使用刷新按钮重新检测模型\n');
    this.statusBar.tooltip = tooltip;
    this.statusBar.command = 'antigravityContextMonitor.showHistory';
    this.refreshStatusBar.text = '$(refresh)';
    this.refreshStatusBar.tooltip = 'Refresh and re-detect current model / 刷新并重新检测当前模型';
    this.statusBar.show();
    this.refreshStatusBar.show();
  }

  private buildTooltip(snapshot: UsageSnapshot): vscode.MarkdownString {
    const tooltip = new vscode.MarkdownString(undefined, true);
    tooltip.isTrusted = false;
    tooltip.appendMarkdown('**Antigravity Context Usage / 上下文使用情况**\n\n');
    tooltip.appendMarkdown(`- Title / 标题: ${escapeMarkdown(snapshot.title)}\n`);
    tooltip.appendMarkdown(`- Model / 模型: ${escapeMarkdown(snapshot.modelDisplayName)}\n`);
    tooltip.appendMarkdown(`- Used / 已用: ${formatNumber(snapshot.usedTokens)} / ${formatNumber(snapshot.maxTokens)} tokens\n`);
    tooltip.appendMarkdown(`- Remaining / 剩余: ${formatNumber(snapshot.remainingTokens)} tokens\n`);
    tooltip.appendMarkdown(`- Source / 来源: ${formatSnapshotSource(snapshot.source)}\n`);
    tooltip.appendMarkdown(`- Steps / 步数: ${snapshot.stepCount}\n`);
    tooltip.appendMarkdown(`- Status / 状态: ${escapeMarkdown(snapshot.status)}\n`);
    tooltip.appendMarkdown(`- Endpoint / 接口: ${escapeMarkdown(snapshot.endpoint)} on port ${snapshot.port}\n`);
    tooltip.appendMarkdown(`- PID / 进程: ${snapshot.pid}${snapshot.csrfTokenPresent ? ' with csrf token / 带 csrf token' : ' without csrf token / 无 csrf token'}\n`);
    tooltip.appendMarkdown(`- Session / 会话: ${escapeMarkdown(snapshot.sessionId)}\n`);
    tooltip.appendMarkdown(`- Updated / 更新时间: ${new Date(snapshot.timestamp).toLocaleTimeString()}\n`);
    tooltip.appendMarkdown('- Refresh / 刷新: click the `$(refresh)` button to re-detect the model / 点击 `$(refresh)` 按钮可重新检测模型\n');
    return tooltip;
  }

  private async showHistory(): Promise<void> {
    if (this.history.length === 0) {
      await vscode.window.showInformationMessage('Antigravity context history is empty / 暂无上下文历史记录');
      return;
    }

    const items = this.history.map((snapshot) => ({
      label: `${new Date(snapshot.timestamp).toLocaleTimeString()} · ${formatCompactNumber(snapshot.usedTokens)}/${formatCompactNumber(snapshot.maxTokens)}`,
      description: `${snapshot.modelDisplayName} · ${snapshot.percentUsed.toFixed(1)}% · ${snapshot.source}`,
      detail: `${snapshot.title} · ${snapshot.endpoint} · port ${snapshot.port}`,
    }));

    await vscode.window.showQuickPick(items, {
      placeHolder: 'Recent Antigravity context snapshots / 最近的上下文快照',
      matchOnDescription: true,
      matchOnDetail: true,
    });
  }

  private recordSnapshot(snapshot: UsageSnapshot): void {
    const latest = this.history[0];
    if (
      latest
      && latest.sessionId === snapshot.sessionId
      && latest.usedTokens === snapshot.usedTokens
      && latest.stepCount === snapshot.stepCount
      && latest.status === snapshot.status
    ) {
      this.history[0] = snapshot;
      return;
    }

    this.history.unshift(snapshot);
    const historySize = this.getConfig().historySize;
    if (this.history.length > historySize) {
      this.history.length = historySize;
    }
  }

  private updateBaselines(trajectories: readonly TrajectorySummary[]): void {
    this.previousStepCounts.clear();
    this.previousTrajectoryIds.clear();
    for (const trajectory of trajectories) {
      this.previousStepCounts.set(trajectory.cascadeId, trajectory.stepCount);
      this.previousTrajectoryIds.add(trajectory.cascadeId);
    }
    this.firstPollCompleted = true;
  }

  private shouldImplicitlyRefresh(forceRediscover: boolean, trajectory: TrajectorySummary): boolean {
    if (forceRediscover || !this.firstPollCompleted) {
      return false;
    }

    const previousStepCount = this.previousStepCounts.get(trajectory.cascadeId);
    const currentSnapshot = this.history[0]?.sessionId === trajectory.cascadeId ? this.history[0] : undefined;
    const modelHint = trajectory.requestedModel || trajectory.generatorModel;
    const stepChanged = previousStepCount !== undefined && previousStepCount !== trajectory.stepCount;
    const newTrajectory = !this.previousTrajectoryIds.has(trajectory.cascadeId);
    const running = trajectory.status === 'CASCADE_RUN_STATUS_RUNNING';
    const modelHintChanged = Boolean(
      modelHint
      && currentSnapshot?.model
      && normalizeModelKey(modelHint) !== normalizeModelKey(currentSnapshot.model),
    );

    if (!(stepChanged || newTrajectory || running || modelHintChanged)) {
      return false;
    }

    const refreshKey = [
      trajectory.cascadeId,
      trajectory.stepCount,
      trajectory.status,
      normalizeModelKey(modelHint),
      normalizeModelKey(currentSnapshot?.model ?? ''),
    ].join('|');

    if (refreshKey === this.lastImplicitRefreshKey) {
      return false;
    }

    this.lastImplicitRefreshKey = refreshKey;
    return true;
  }

  private getWorkspaceFingerprint(): string {
    const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
    const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath ?? '';
    return `${workspaceFolders.map((folder) => folder.uri.fsPath.toLowerCase()).sort().join('|')}::${activeFile.toLowerCase()}`;
  }

  private getWorkspaceUri(): string | undefined {
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder?.uri.toString();
  }

  private getConfig(): ExtensionConfig {
    const config = vscode.workspace.getConfiguration('antigravityContextMonitor');
    return {
      pollIntervalSeconds: config.get<number>('pollIntervalSeconds', 5),
      requestTimeoutMs: config.get<number>('requestTimeoutMs', 3500),
      historySize: config.get<number>('historySize', 20),
      defaultContextLimit: config.get<number>('defaultContextLimit', 200000),
      modelContextOverrides: config.get<Record<string, number>>('modelContextOverrides', {}),
      enableVerboseLogs: config.get<boolean>('enableVerboseLogs', false),
    };
  }

  private log(message: string): void {
    if (this.getConfig().enableVerboseLogs) {
      this.output.appendLine(`[monitor] ${message}`);
    }
  }
}

function computeUsageFromSteps(steps: Array<Record<string, unknown>>, initialModel: string): ComputedUsage {
  const systemPromptOverhead = 10000;
  const userInputFallback = 500;
  const plannerResponseFallback = 800;
  let model = initialModel;
  let totalToolCallOutputTokens = 0;
  let estimationOverhead = 0;
  let outputTokensSinceCheckpoint = 0;
  let lastCheckpointInputTokens: number | undefined;
  let lastCheckpointOutputTokens = 0;

  for (const step of steps) {
    const stepType = stringFromUnknown(step.type);
    const metadata = readPath(step, 'metadata');

    if (stepType === 'CORTEX_STEP_TYPE_USER_INPUT') {
      const userInput = readPath(step, 'userInput');
      const text = stringFromUnknown(readPath(userInput, 'userResponse'));
      estimationOverhead += userInput && typeof userInput === 'object'
        ? estimateTokensFromText(text)
        : userInputFallback;
    }

    if (stepType === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE') {
      const plannerResponse = readPath(step, 'plannerResponse');
      const responseText = stringFromUnknown(readPath(plannerResponse, 'response'));
      const thinkingText = stringFromUnknown(readPath(plannerResponse, 'thinking'));
      let toolCallsText = '';
      const toolCalls = readPath(plannerResponse, 'toolCalls');
      if (Array.isArray(toolCalls)) {
        for (const toolCall of toolCalls) {
          toolCallsText += stringFromUnknown(readPath(toolCall, 'argumentsJson'));
        }
      }

      estimationOverhead += plannerResponse && typeof plannerResponse === 'object'
        ? estimateTokensFromText(responseText + thinkingText + toolCallsText)
        : plannerResponseFallback;
    }

    const toolCallOutputTokens = numberFromUnknown(readPath(metadata, 'toolCallOutputTokens'));
    totalToolCallOutputTokens += toolCallOutputTokens;
    outputTokensSinceCheckpoint += toolCallOutputTokens;

    const generatorModel = stringFromUnknown(readPath(metadata, 'generatorModel'));
    if (generatorModel) {
      model = generatorModel;
    }

    const requestedModel = stringFromUnknown(readPath(metadata, 'requestedModel.model'));
    if (requestedModel) {
      model = requestedModel;
    }

    if (stepType === 'CORTEX_STEP_TYPE_CHECKPOINT') {
      const modelUsage = readPath(metadata, 'modelUsage');
      const inputTokens = numberFromUnknown(readPath(modelUsage, 'inputTokens'));
      const outputTokens = numberFromUnknown(readPath(modelUsage, 'outputTokens'));
      const usageModel = stringFromUnknown(readPath(modelUsage, 'model'));

      if (usageModel) {
        model = usageModel;
      }

      if (inputTokens > 0 || outputTokens > 0) {
        lastCheckpointInputTokens = inputTokens;
        lastCheckpointOutputTokens = outputTokens;
        estimationOverhead = 0;
        outputTokensSinceCheckpoint = 0;
      }
    }
  }

  if (lastCheckpointInputTokens !== undefined) {
    const estimatedDeltaSinceCheckpoint = outputTokensSinceCheckpoint + estimationOverhead;
    return {
      contextUsed: lastCheckpointInputTokens + lastCheckpointOutputTokens + estimatedDeltaSinceCheckpoint,
      totalOutputTokens: lastCheckpointOutputTokens,
      estimatedDeltaSinceCheckpoint,
      model,
      hasCheckpoint: true,
    };
  }

  const estimatedTotal = systemPromptOverhead + totalToolCallOutputTokens + estimationOverhead;
  return {
    contextUsed: estimatedTotal,
    totalOutputTokens: 0,
    estimatedDeltaSinceCheckpoint: estimatedTotal,
    model,
    hasCheckpoint: false,
  };
}

function estimateTokensFromText(text: string): number {
  if (!text) {
    return 0;
  }

  let asciiChars = 0;
  let nonAsciiChars = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) < 128) {
      asciiChars += 1;
    } else {
      nonAsciiChars += 1;
    }
  }

  return Math.ceil((asciiChars / 4) + (nonAsciiChars / 1.5));
}

function inferContextLimit(model: string, config: ExtensionConfig): number {
  const normalizedModel = normalizeModelKey(model);
  if (!normalizedModel) {
    return config.defaultContextLimit;
  }

  for (const [name, value] of Object.entries(config.modelContextOverrides)) {
    if (!Number.isFinite(value) || value <= 0) {
      continue;
    }

    const normalizedName = normalizeModelKey(name);
    if (normalizedName === normalizedModel || normalizedModel.includes(normalizedName) || normalizedName.includes(normalizedModel)) {
      return value;
    }
  }

  if (normalizedModel.includes('m37') || normalizedModel.includes('m36') || normalizedModel.includes('m18') || normalizedModel.includes('gemini')) {
    return 1000000;
  }
  if (normalizedModel.includes('m35') || normalizedModel.includes('m26') || normalizedModel.includes('claude')) {
    return 200000;
  }
  if (normalizedModel.includes('gpt_oss') || normalizedModel.includes('gpt-oss') || normalizedModel.includes('gpt-4.1') || normalizedModel.includes('gpt-4o')) {
    return 128000;
  }
  if (normalizedModel.includes('gpt-5')) {
    return 256000;
  }
  if (normalizedModel.startsWith('o1') || normalizedModel.startsWith('o3')) {
    return 200000;
  }

  return config.defaultContextLimit;
}

function normalizeUri(uri: string): string {
  let normalized = uri;
  normalized = normalized.replace(/^file:\/\//, 'file:///');
  try {
    normalized = decodeURIComponent(normalized);
  } catch {
    // Ignore malformed encodings and use the raw URI.
  }
  return normalized.replace(/\/+$/, '').toLowerCase();
}

function readPath(payload: unknown, path: string): unknown {
  if (!path) {
    return payload;
  }
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }

  let current: unknown = payload;
  for (const segment of path.split('.')) {
    if (!current || typeof current !== 'object' || !(segment in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function firstString(payload: unknown, paths: string[]): string | undefined {
  for (const path of paths) {
    const value = readPath(payload, path);
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function numberFromUnknown(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 0;
}

function stringFromUnknown(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function safeJsonParse(rawText: string): unknown {
  if (!rawText) {
    return undefined;
  }

  try {
    return JSON.parse(rawText);
  } catch {
    return undefined;
  }
}

function normalizeModelKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function formatSnapshotSource(source: SnapshotSource): string {
  switch (source) {
    case 'api':
      return 'api / 接口';
    case 'estimate':
      return 'estimate / 估算';
    case 'mixed':
      return 'mixed / 混合';
    default:
      return source;
  }
}

function getCandidateModelKeys(payload: unknown): string[] {
  const keys = new Set<string>();
  for (const value of [
    readPath(payload, 'modelOrAlias.model'),
    readPath(payload, 'modelOrAlias.alias'),
    readPath(payload, 'model'),
    readPath(payload, 'alias'),
  ]) {
    if (typeof value === 'string' && value.trim()) {
      keys.add(value.trim());
    }
  }
  return [...keys];
}

function resolveModelDisplayName(model: string, names: ReadonlyMap<string, string>): string {
  const direct = names.get(model);
  if (direct) {
    return direct;
  }

  const normalizedModel = normalizeModelKey(model);
  if (!normalizedModel) {
    return model;
  }

  for (const [name, label] of names.entries()) {
    const normalizedName = normalizeModelKey(name);
    if (normalizedName === normalizedModel || normalizedModel.includes(normalizedName) || normalizedName.includes(normalizedModel)) {
      return label;
    }
  }

  return model;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}

function formatCompactNumber(value: number): string {
  if (value >= 1000000) {
    return `${roundToSingleDecimal(value / 1000000)}M`;
  }
  if (value >= 1000) {
    return `${roundToSingleDecimal(value / 1000)}k`;
  }
  return formatNumber(value);
}

function roundToSingleDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}\[\]()#+\-.!]/g, '\\$&');
}
