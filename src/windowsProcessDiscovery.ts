import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface DiscoveryConfig {
  enableVerboseLogs: boolean;
}

interface WinProcessInfo {
  ProcessId?: number;
  ParentProcessId?: number;
  Name?: string;
  ExecutablePath?: string;
  CommandLine?: string;
}

interface NetConnectionInfo {
  LocalAddress?: string;
  LocalPort?: number;
}

interface ParsedHints {
  ports: number[];
  csrfToken?: string;
  notes: string[];
}

export interface LanguageServerCandidate {
  pid: number;
  parentPid?: number;
  processName: string;
  executablePath?: string;
  commandLine?: string;
  parentCommandLine?: string;
  port: number;
  csrfToken?: string;
  score: number;
  notes: string[];
}

export class WindowsProcessDiscovery {
  private readonly powershellExe = 'powershell.exe';

  constructor(
    private readonly output: vscode.OutputChannel,
    private readonly getConfig: () => DiscoveryConfig,
  ) {}

  async discoverCandidates(workspaceFolders: readonly vscode.WorkspaceFolder[]): Promise<LanguageServerCandidate[]> {
    const processes = await this.listCandidateProcesses();
    if (processes.length === 0) {
      this.log('No matching Antigravity processes found.');
      return [];
    }

    const processById = new Map<number, WinProcessInfo>();
    for (const processInfo of processes) {
      if (typeof processInfo.ProcessId === 'number') {
        processById.set(processInfo.ProcessId, processInfo);
      }
    }

    const workspaceHints = workspaceFolders
      .map((folder) => normalizeForMatch(folder.uri.fsPath))
      .filter(Boolean);

    const portLookups = await Promise.all(
      processes.map(async (processInfo) => {
        const pid = processInfo.ProcessId;
        if (typeof pid !== 'number') {
          return [] as number[];
        }

        const parsed = this.parseHints(processInfo.CommandLine ?? '');
        if (parsed.ports.length > 0) {
          return parsed.ports;
        }

        return this.getListeningPorts(pid);
      }),
    );

    const candidates: LanguageServerCandidate[] = [];
    for (let index = 0; index < processes.length; index += 1) {
      const processInfo = processes[index];
      const pid = processInfo.ProcessId;
      if (typeof pid !== 'number') {
        continue;
      }

      const processName = processInfo.Name ?? 'unknown';
      const parent = typeof processInfo.ParentProcessId === 'number' ? processById.get(processInfo.ParentProcessId) : undefined;
      const commandLine = processInfo.CommandLine ?? '';
      const hints = this.parseHints(commandLine);
      const ports = uniqueNumbers([...(portLookups[index] ?? []), ...hints.ports]).filter(isValidPort);

      if (ports.length === 0) {
        this.log(`Skipping PID ${pid} because no candidate port was found.`);
        continue;
      }

      const score = this.scoreProcess(processInfo, parent, workspaceHints, hints, ports);
      const notes = [...hints.notes];
      if (parent?.CommandLine) {
        notes.push('parent command line available');
      }

      for (const port of ports) {
        candidates.push({
          pid,
          parentPid: processInfo.ParentProcessId,
          processName,
          executablePath: processInfo.ExecutablePath,
          commandLine: processInfo.CommandLine,
          parentCommandLine: parent?.CommandLine,
          port,
          csrfToken: hints.csrfToken,
          score: score + scorePort(port),
          notes: uniqueStrings([...notes, `port:${port}`]),
        });
      }
    }

    const deduped = new Map<string, LanguageServerCandidate>();
    for (const candidate of candidates.sort((left, right) => right.score - left.score)) {
      const key = `${candidate.pid}:${candidate.port}:${candidate.csrfToken ?? ''}`;
      if (!deduped.has(key)) {
        deduped.set(key, candidate);
      }
    }

    const ordered = [...deduped.values()].sort((left, right) => right.score - left.score);
    this.log(`Discovered ${ordered.length} candidate Antigravity endpoints.`);
    return ordered;
  }

  private async listCandidateProcesses(): Promise<WinProcessInfo[]> {
    const script = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      "$items = Get-CimInstance Win32_Process | Where-Object {",
      "  $_.Name -match 'Antigravity|language_server_windows_x64' -or ($_.CommandLine -and $_.CommandLine -match 'Antigravity|language_server_windows_x64')",
      "} | Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine",
      "if ($items) { $items | ConvertTo-Json -Compress -Depth 3 } else { '[]' }",
    ].join('; ');

    try {
      const stdout = await this.runPowerShell(script);
      return parseJsonArray<WinProcessInfo>(stdout);
    } catch (error) {
      this.log(`Process discovery failed: ${formatError(error)}`);
      return [];
    }
  }

  private async getListeningPorts(pid: number): Promise<number[]> {
    const primary = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      `$items = Get-NetTCPConnection -OwningProcess ${pid} -State Listen | Select-Object LocalAddress, LocalPort`,
      "if ($items) { $items | ConvertTo-Json -Compress -Depth 2 } else { '[]' }",
    ].join('; ');

    try {
      const stdout = await this.runPowerShell(primary);
      const entries = parseJsonArray<NetConnectionInfo>(stdout);
      const ports = entries
        .filter((entry) => isLoopbackOrWildcard(entry.LocalAddress))
        .map((entry) => entry.LocalPort)
        .filter((port): port is number => typeof port === 'number' && isValidPort(port));

      if (ports.length > 0) {
        return uniqueNumbers(ports);
      }
    } catch (error) {
      this.log(`Get-NetTCPConnection failed for PID ${pid}: ${formatError(error)}`);
    }

    const fallback = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      "$lines = netstat -ano -p tcp | Select-String 'LISTENING'",
      `$filtered = foreach ($line in $lines) { if ($line.ToString() -match '\\s+(?<local>[^\\s]+):(\\d+)\\s+[^\\s]+\\s+LISTENING\\s+${pid}\\s*$') { [PSCustomObject]@{ Local = $matches['local']; Port = [int]$matches[2] } } }`,
      "if ($filtered) { $filtered | ConvertTo-Json -Compress -Depth 2 } else { '[]' }",
    ].join('; ');

    try {
      const stdout = await this.runPowerShell(fallback);
      const entries = parseJsonArray<{ Local?: string; Port?: number }>(stdout);
      return uniqueNumbers(
        entries
          .filter((entry) => isLoopbackOrWildcard(entry.Local))
          .map((entry) => entry.Port)
          .filter((port): port is number => typeof port === 'number' && isValidPort(port)),
      );
    } catch (error) {
      this.log(`netstat fallback failed for PID ${pid}: ${formatError(error)}`);
      return [];
    }
  }

  private parseHints(commandLine: string): ParsedHints {
    const ports = new Set<number>();
    const notes: string[] = [];

    for (const regex of [
      /--(?:grpc-)?port(?:=|\s+)(\d{2,5})/gi,
      /--(?:listen|server|http)-port(?:=|\s+)(\d{2,5})/gi,
      /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d{2,5})/gi,
      /(?:localhost|127\.0\.0\.1|\[::1\]):(\d{2,5})/gi,
    ]) {
      let match: RegExpExecArray | null;
      while ((match = regex.exec(commandLine)) !== null) {
        const parsed = Number.parseInt(match[1], 10);
        if (isValidPort(parsed)) {
          ports.add(parsed);
          notes.push(`command line port match:${parsed}`);
        }
      }
    }

    let csrfToken: string | undefined;
    for (const regex of [
      /--(?:csrf_token|csrf-token|csrfToken|xsrf-token|auth-token|session-token)(?:=|\s+)([A-Za-z0-9._\-:=]+)/i,
      /--(?:csrf-token|csrfToken|xsrf-token|auth-token|session-token)(?:=|\s+)([A-Za-z0-9._\-:=]+)/i,
      /(?:csrf_token|csrf-token|csrfToken|xsrf-token|auth-token|session-token)=([A-Za-z0-9._\-:=]+)/i,
      /(?:csrf-token|csrfToken|xsrf-token|auth-token|session-token)=([A-Za-z0-9._\-:=]+)/i,
    ]) {
      const match = regex.exec(commandLine);
      if (match?.[1]) {
        csrfToken = match[1];
        notes.push('csrf token parsed from command line');
        break;
      }
    }

    return {
      ports: [...ports],
      csrfToken,
      notes: uniqueStrings(notes),
    };
  }

  private scoreProcess(
    processInfo: WinProcessInfo,
    parent: WinProcessInfo | undefined,
    workspaceHints: string[],
    hints: ParsedHints,
    ports: number[],
  ): number {
    let score = 0;
    const name = normalizeForMatch(processInfo.Name ?? '');
    const executablePath = normalizeForMatch(processInfo.ExecutablePath ?? '');
    const commandLine = normalizeForMatch(processInfo.CommandLine ?? '');
    const parentCommandLine = normalizeForMatch(parent?.CommandLine ?? '');

    if (name.includes('language_server_windows_x64')) {
      score += 90;
    } else if (name.includes('antigravity')) {
      score += 45;
    }

    if (commandLine.includes('language_server_windows_x64')) {
      score += 40;
    }

    if (commandLine.includes('antigravity') || executablePath.includes('antigravity')) {
      score += 25;
    }

    if (hints.csrfToken) {
      score += 25;
    }

    if (hints.ports.length > 0) {
      score += 20;
    }

    if (ports.length > 0) {
      score += 10;
    }

    for (const workspaceHint of workspaceHints) {
      if (!workspaceHint) {
        continue;
      }

      if (commandLine.includes(workspaceHint)) {
        score += 120;
      }

      if (parentCommandLine.includes(workspaceHint)) {
        score += 70;
      }
    }

    return score;
  }

  private async runPowerShell(script: string): Promise<string> {
    const { stdout, stderr } = await execFileAsync(
      this.powershellExe,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { maxBuffer: 8 * 1024 * 1024, windowsHide: true },
    );

    if (stderr && this.getConfig().enableVerboseLogs) {
      this.output.appendLine(`[powershell:stderr] ${stderr.trim()}`);
    }

    return stdout.trim();
  }

  private log(message: string): void {
    if (this.getConfig().enableVerboseLogs) {
      this.output.appendLine(`[discovery] ${message}`);
    }
  }
}

function parseJsonArray<T>(raw: string): T[] {
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed as T[];
    }

    if (parsed && typeof parsed === 'object') {
      return [parsed as T];
    }
  } catch {
    return [];
  }

  return [];
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function isLoopbackOrWildcard(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === '[::1]' || normalized === '0.0.0.0' || normalized === '::' || normalized === '[::]';
}

function isValidPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

function normalizeForMatch(value: string): string {
  return value.replace(/\\+/g, '/').toLowerCase();
}

function scorePort(port: number): number {
  if (port >= 49152) {
    return 12;
  }

  if (port >= 10000) {
    return 8;
  }

  return 3;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
