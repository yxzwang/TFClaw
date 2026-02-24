import { spawn } from "node:child_process";
import os from "node:os";
import process from "node:process";
import { URL } from "node:url";
import {
  type AgentDescriptor,
  type CaptureSource,
  type ClientCommand,
  type RelayMessage,
  jsonStringify,
  safeJsonParse,
} from "@tfclaw/protocol";
import screenshot from "screenshot-desktop";
import { v4 as uuidv4 } from "uuid";
import WebSocket from "ws";

interface TerminalSession {
  terminalId: string;
  title: string;
  cwd?: string;
  foregroundCommand?: string;
  tmuxWindowId: string;
  tmuxPaneId: string;
  outputBuffer: string;
  lastCapture: string;
  lastCommandSyncAt: number;
  updatedAt: string;
  isActive: boolean;
}

interface ListedWindow {
  sourceId: string;
  label: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  spawnError?: Error;
}

interface CommandOptions {
  input?: string;
  windowsHide?: boolean;
}

interface SyncOptions {
  emitDelta?: boolean;
}

type InputAction = { kind: "literal"; text: string } | { kind: "key"; key: string };

type TmuxStreamMode = "auto" | "on" | "off";
type TmuxProgressCallback = (content: string) => Promise<void>;

interface TmuxControlState {
  enabled: boolean;
  target: string;
  socket: string;
  captureLines: number;
  waitMs: number;
  streamMode: TmuxStreamMode;
  paneIndexMap: Record<string, string>;
}

interface TmuxPaneRow {
  target: string;
  window: string;
  command: string;
  activity: string;
}

function sanitizeTmuxName(name: string): string {
  return name
    .trim()
    .replace(/[^\w-]/g, "_")
    .replace(/_{2,}/g, "_")
    .slice(0, 64);
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (typeof value !== "string") {
    return defaultValue;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no") {
    return false;
  }
  return defaultValue;
}

const TOKEN = process.env.TFCLAW_TOKEN;
const RELAY_URL = process.env.TFCLAW_RELAY_URL ?? "ws://127.0.0.1:8787";
const AGENT_ID = process.env.TFCLAW_AGENT_ID ?? `${os.hostname()}-${process.pid}`;
const START_TERMINALS = Number.parseInt(process.env.TFCLAW_START_TERMINALS ?? "1", 10);
const DEFAULT_CWD = process.env.TFCLAW_DEFAULT_CWD ?? process.cwd();
const MAX_LOCAL_BUFFER = Number.parseInt(process.env.TFCLAW_MAX_LOCAL_BUFFER ?? "12000", 10);
const TMUX_COMMAND =
  process.env.TFCLAW_TMUX_COMMAND ?? process.env.TFCLAW_TMUX_BINARY ?? (process.platform === "win32" ? "wsl.exe" : "tmux");
const TMUX_BASE_ARGS = (process.env.TFCLAW_TMUX_BASE_ARGS ?? (process.platform === "win32" ? "-e tmux" : ""))
  .split(/\s+/)
  .filter(Boolean);
const TMUX_USING_WSL = process.platform === "win32" && /(?:^|[\\/])wsl(?:\.exe)?$/i.test(TMUX_COMMAND);
const TMUX_SESSION =
  sanitizeTmuxName(
    process.env.TFCLAW_TMUX_SESSION ?? `tfclaw-${(TOKEN ?? "token").slice(0, 8)}-${os.hostname()}`,
  ) || "tfclaw";
const TMUX_CAPTURE_LINES = Number.parseInt(process.env.TFCLAW_TMUX_CAPTURE_LINES ?? "300", 10);
const TMUX_POLL_MS = Number.parseInt(process.env.TFCLAW_TMUX_POLL_MS ?? "250", 10);
const TMUX_FOREGROUND_COMMAND_POLL_MS = Number.parseInt(process.env.TFCLAW_TMUX_FOREGROUND_COMMAND_POLL_MS ?? "800", 10);
const TMUX_MAX_DELTA_CHARS = Number.parseInt(process.env.TFCLAW_TMUX_MAX_DELTA_CHARS ?? "4000", 10);
const TMUX_SUBMIT_DELAY_MS = Number.parseInt(process.env.TFCLAW_TMUX_SUBMIT_DELAY_MS ?? "60", 10);
const TMUX_STREAM_POLL_MS = Number.parseInt(process.env.TFCLAW_TMUX_STREAM_POLL_MS ?? "350", 10);
const TMUX_STREAM_IDLE_MS = Number.parseInt(process.env.TFCLAW_TMUX_STREAM_IDLE_MS ?? "3000", 10);
const TMUX_STREAM_INITIAL_SILENCE_MS = Number.parseInt(process.env.TFCLAW_TMUX_STREAM_INITIAL_SILENCE_MS ?? "12000", 10);
const TMUX_STREAM_WINDOW_MS = Number.parseInt(process.env.TFCLAW_TMUX_STREAM_WINDOW_MS ?? "86400000", 10);
const TMUX_BOOTSTRAP_WINDOW = sanitizeTmuxName(process.env.TFCLAW_TMUX_BOOTSTRAP_WINDOW ?? "__tfclaw_bootstrap__");
const TMUX_RESET_ON_BOOT = parseBoolean(process.env.TFCLAW_TMUX_RESET_ON_BOOT, true);
const TMUX_PERSIST_SESSION_ON_SHUTDOWN = parseBoolean(process.env.TFCLAW_TMUX_PERSIST_SESSION_ON_SHUTDOWN, false);

if (!TOKEN) {
  console.error("Missing TFCLAW_TOKEN. Example: TFCLAW_TOKEN=demo-token npm run dev --workspace @tfclaw/terminal-agent");
  process.exit(1);
}

let ws: WebSocket | undefined;
const terminals = new Map<string, TerminalSession>();
let reconnectAttempts = 0;
let closing = false;
let syncLoopBusy = false;
let syncTimer: NodeJS.Timeout | undefined;
const captureErrorAt = new Map<string, number>();
const tmuxControlStateBySession = new Map<string, TmuxControlState>();

const TMUX_STREAM_COMMANDS = new Set([
  "bun",
  "deno",
  "node",
  "npm",
  "npx",
  "nuxt",
  "pnpm",
  "tsx",
  "vite",
  "yarn",
]);

const TMUX_SHORT_SUBCOMMANDS = new Set([
  "status",
  "sessions",
  "ls",
  "panes",
  "targets",
  "new",
  "target",
  "close",
  "kill",
  "socket",
  "lines",
  "wait",
  "stream",
  "capture",
  "key",
  "keys",
  "sendkey",
  "sendkeys",
  "send-keys",
  "send",
  "help",
  "?",
]);

const LIST_WINDOWS_PS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
public static class TfclawWinApi {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern IntPtr GetShellWindow();
}
"@
$results = New-Object System.Collections.Generic.List[object]
$shell = [TfclawWinApi]::GetShellWindow()
$callback = [TfclawWinApi+EnumWindowsProc]{
  param([IntPtr]$hWnd, [IntPtr]$lParam)
  if ($hWnd -eq $shell) { return $true }
  if (-not [TfclawWinApi]::IsWindowVisible($hWnd)) { return $true }
  $length = [TfclawWinApi]::GetWindowTextLength($hWnd)
  if ($length -le 0) { return $true }
  $builder = New-Object System.Text.StringBuilder ($length + 1)
  [void][TfclawWinApi]::GetWindowText($hWnd, $builder, $builder.Capacity)
  $title = $builder.ToString().Trim()
  if ([string]::IsNullOrWhiteSpace($title)) { return $true }
  $rect = New-Object RECT
  [void][TfclawWinApi]::GetWindowRect($hWnd, [ref]$rect)
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  if ($width -lt 80 -or $height -lt 60) { return $true }
  $results.Add([PSCustomObject]@{
    sourceId = ('0x{0:X}' -f $hWnd.ToInt64())
    label = $title
    x = $rect.Left
    y = $rect.Top
    width = $width
    height = $height
  })
  return $true
}
[void][TfclawWinApi]::EnumWindows($callback, [IntPtr]::Zero)
$json = $results | Sort-Object label | ConvertTo-Json -Compress -Depth 4
$bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
[Convert]::ToBase64String($bytes)
`;

function captureWindowScript(sourceIdBase64: string): string {
  return String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
public static class TfclawWinApi {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
}
"@
$TfclawSourceId = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${sourceIdBase64}'))
$hex = $TfclawSourceId -replace '^0x', ''
$hWnd = [IntPtr]::new([Convert]::ToInt64($hex, 16))
if ($hWnd -eq [IntPtr]::Zero) { throw 'invalid window handle' }
$rect = New-Object RECT
if (-not [TfclawWinApi]::GetWindowRect($hWnd, [ref]$rect)) {
  throw ('cannot read window rect: ' + $TfclawSourceId)
}
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
if ($width -le 0 -or $height -le 0) {
  throw 'invalid window rect'
}
$bitmap = New-Object System.Drawing.Bitmap $width, $height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bitmap.Size, [System.Drawing.CopyPixelOperation]::SourceCopy)
$stream = New-Object System.IO.MemoryStream
$bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
$base64 = [Convert]::ToBase64String($stream.ToArray())
$graphics.Dispose()
$bitmap.Dispose()
$stream.Dispose()
Write-Output $base64
`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function platformName(): AgentDescriptor["platform"] {
  switch (process.platform) {
    case "win32":
      return "windows";
    case "darwin":
      return "macos";
    case "linux":
      return "linux";
    default:
      return "unknown";
  }
}

function toRelayWsUrl(base: string): string {
  const parsed = new URL(base);
  parsed.searchParams.set("role", "agent");
  parsed.searchParams.set("token", TOKEN!);
  return parsed.toString();
}

function trimTail(text: string, maxChars: number): string {
  return text.length > maxChars ? text.slice(-maxChars) : text;
}

function send(message: RelayMessage): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(jsonStringify(message));
  }
}

function sendError(code: string, message: string, requestId?: string): void {
  send({
    type: "agent.error",
    payload: {
      code,
      message,
      requestId,
    },
  });
}

function publishRegister(): void {
  send({
    type: "agent.register",
    payload: {
      agentId: AGENT_ID,
      platform: platformName(),
      hostname: os.hostname(),
      connectedAt: nowIso(),
    },
  });
}

function publishTerminalList(): void {
  const activeTerminals = Array.from(terminals.values()).filter((terminal) => terminal.isActive);
  send({
    type: "agent.terminal_list",
    payload: {
      terminals: activeTerminals.map((terminal) => ({
        terminalId: terminal.terminalId,
        title: terminal.title,
        cwd: terminal.cwd,
        foregroundCommand: terminal.foregroundCommand,
        isActive: terminal.isActive,
        updatedAt: terminal.updatedAt,
      })),
    },
  });
}

function emitTerminalChunk(terminal: TerminalSession, chunk: string): void {
  if (!chunk) {
    return;
  }
  terminal.updatedAt = nowIso();
  send({
    type: "agent.terminal_output",
    payload: {
      terminalId: terminal.terminalId,
      chunk,
      at: terminal.updatedAt,
    },
  });
}

function setTerminalSnapshot(terminal: TerminalSession, text: string): void {
  terminal.outputBuffer = trimTail(text, MAX_LOCAL_BUFFER);
  terminal.updatedAt = nowIso();
}

function appendTerminalNotice(terminal: TerminalSession, text: string): void {
  setTerminalSnapshot(terminal, `${terminal.outputBuffer}${text}`);
  emitTerminalChunk(terminal, text);
}

function commandDetail(result: CommandResult, command: string, args: string[]): string {
  const joined = [command, ...args].join(" ");
  if (result.spawnError) {
    return `${joined}: ${result.spawnError.message}`;
  }
  const stderr = result.stderr.trim();
  const stdout = result.stdout.trim();
  if (stderr) {
    return `${joined}: ${stderr}`;
  }
  if (stdout) {
    return `${joined}: ${stdout}`;
  }
  return `${joined}: exit code ${result.code}`;
}

function tmuxArgs(args: string[]): string[] {
  return [...TMUX_BASE_ARGS, ...args];
}

function normalizeTmuxCwd(cwd?: string): string | undefined {
  if (!cwd) {
    return undefined;
  }
  if (!TMUX_USING_WSL) {
    return cwd;
  }

  const windowsPath = /^([A-Za-z]):[\\/](.*)$/.exec(cwd);
  if (windowsPath) {
    const drive = windowsPath[1].toLowerCase();
    const rest = windowsPath[2].replace(/\\/g, "/");
    return `/mnt/${drive}/${rest}`;
  }

  if (cwd.includes("\\")) {
    return undefined;
  }
  return cwd;
}

function runCommand(command: string, args: string[], options: CommandOptions = {}): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      windowsHide: options.windowsHide ?? true,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });

    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({
        code: -1,
        stdout,
        stderr,
        spawnError: error,
      });
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({
        code: typeof code === "number" ? code : -1,
        stdout,
        stderr,
      });
    });

    if (typeof options.input === "string") {
      child.stdin?.write(options.input);
      child.stdin?.end();
    }
  });
}

async function runTmuxRaw(args: string[], options: CommandOptions = {}): Promise<CommandResult> {
  return runCommand(TMUX_COMMAND, tmuxArgs(args), {
    ...options,
    windowsHide: true,
  });
}

function tmuxArgsWithSocket(args: string[], socketPath?: string): string[] {
  const socket = (socketPath ?? "").trim();
  if (!socket) {
    return tmuxArgs(args);
  }
  return [...TMUX_BASE_ARGS, "-S", socket, ...args];
}

async function runTmuxRawWithSocket(
  args: string[],
  socketPath?: string,
  options: CommandOptions = {},
): Promise<CommandResult> {
  return runCommand(TMUX_COMMAND, tmuxArgsWithSocket(args, socketPath), {
    ...options,
    windowsHide: true,
  });
}

async function runTmuxOrThrow(
  args: string[],
  options: {
    trimOutput?: boolean;
    input?: string;
  } = {},
): Promise<string> {
  const result = await runTmuxRaw(args, { input: options.input });
  if (result.spawnError || result.code !== 0) {
    throw new Error(commandDetail(result, TMUX_COMMAND, tmuxArgs(args)));
  }
  return options.trimOutput === false ? result.stdout : result.stdout.trim();
}

async function runTmuxWithOptionalCwd(args: string[], cwd?: string, trimOutput = true): Promise<string> {
  if (!cwd) {
    return runTmuxOrThrow(args, { trimOutput });
  }

  const withCwd = [...args, "-c", cwd];
  const withCwdResult = await runTmuxRaw(withCwd);
  if (!withCwdResult.spawnError && withCwdResult.code === 0) {
    return trimOutput ? withCwdResult.stdout.trim() : withCwdResult.stdout;
  }

  const withCwdDetail = commandDetail(withCwdResult, TMUX_COMMAND, tmuxArgs(withCwd)).toLowerCase();
  if (withCwdDetail.includes("unknown option") && withCwdDetail.includes("-c")) {
    return runTmuxOrThrow(args, { trimOutput });
  }

  throw new Error(commandDetail(withCwdResult, TMUX_COMMAND, tmuxArgs(withCwd)));
}

async function ensureTmuxAvailable(): Promise<void> {
  await runTmuxOrThrow(["-V"]);
}

async function tmuxHasSession(): Promise<boolean> {
  const result = await runTmuxRaw(["has-session", "-t", TMUX_SESSION]);
  if (result.spawnError) {
    throw new Error(commandDetail(result, TMUX_COMMAND, tmuxArgs(["has-session", "-t", TMUX_SESSION])));
  }
  return result.code === 0;
}

async function killTmuxSessionSilently(): Promise<void> {
  const result = await runTmuxRaw(["kill-session", "-t", TMUX_SESSION]);
  if (result.spawnError) {
    const detail = commandDetail(result, TMUX_COMMAND, tmuxArgs(["kill-session", "-t", TMUX_SESSION]));
    console.error(`tmux cleanup warning: ${detail}`);
  }
}

async function ensureTmuxSession(): Promise<void> {
  const hasSession = await tmuxHasSession();
  if (hasSession) {
    return;
  }

  await runTmuxWithOptionalCwd(
    ["new-session", "-d", "-s", TMUX_SESSION, "-n", TMUX_BOOTSTRAP_WINDOW],
    normalizeTmuxCwd(DEFAULT_CWD),
  );
}

function computeTmuxDelta(previous: string, next: string): string {
  if (next === previous) {
    return "";
  }

  if (previous.length === 0) {
    return trimTail(next, TMUX_MAX_DELTA_CHARS);
  }

  let prefixLen = 0;
  const maxPrefix = Math.min(previous.length, next.length);
  while (prefixLen < maxPrefix && previous.charCodeAt(prefixLen) === next.charCodeAt(prefixLen)) {
    prefixLen += 1;
  }

  if (prefixLen === previous.length) {
    return trimTail(next.slice(prefixLen), TMUX_MAX_DELTA_CHARS);
  }

  const redrawTail = trimTail(next, TMUX_MAX_DELTA_CHARS);
  return `\n[tmux redraw]\n${redrawTail}\n`;
}

async function capturePaneText(terminal: TerminalSession): Promise<string | null> {
  const args = [
    "capture-pane",
    "-p",
    "-e",
    "-t",
    terminal.tmuxPaneId,
    "-S",
    `-${Math.max(1, TMUX_CAPTURE_LINES)}`,
  ];
  const result = await runTmuxRaw(args);

  if (result.spawnError) {
    throw new Error(commandDetail(result, TMUX_COMMAND, tmuxArgs(args)));
  }
  if (result.code !== 0) {
    const detail = `${result.stderr}\n${result.stdout}`.toLowerCase();
    if (detail.includes("can't find pane") || detail.includes("can't find window")) {
      return null;
    }
    throw new Error(commandDetail(result, TMUX_COMMAND, tmuxArgs(args)));
  }

  return result.stdout;
}

async function capturePaneForegroundCommand(terminal: TerminalSession): Promise<string | undefined | null> {
  const args = ["display-message", "-p", "-t", terminal.tmuxPaneId, "#{pane_current_command}"];
  const result = await runTmuxRaw(args);

  if (result.spawnError) {
    throw new Error(commandDetail(result, TMUX_COMMAND, tmuxArgs(args)));
  }
  if (result.code !== 0) {
    const detail = `${result.stderr}\n${result.stdout}`.toLowerCase();
    if (detail.includes("can't find pane") || detail.includes("can't find window")) {
      return null;
    }
    throw new Error(commandDetail(result, TMUX_COMMAND, tmuxArgs(args)));
  }

  const next = result.stdout.trim();
  return next.length > 0 ? next : undefined;
}

function markTerminalClosed(terminalId: string, reason: string): void {
  const terminal = terminals.get(terminalId);
  if (!terminal || !terminal.isActive) {
    return;
  }

  terminal.isActive = false;
  terminal.updatedAt = nowIso();
  const note = `\n[tmux pane closed: ${reason}]\n`;
  appendTerminalNotice(terminal, note);
  publishTerminalList();
}

async function syncTerminalOutput(terminal: TerminalSession, options: SyncOptions = {}): Promise<void> {
  if (!terminal.isActive) {
    return;
  }

  const capture = await capturePaneText(terminal);
  if (capture === null) {
    markTerminalClosed(terminal.terminalId, "pane not found");
    return;
  }

  let commandChanged = false;
  const now = Date.now();
  if (now - terminal.lastCommandSyncAt >= Math.max(200, TMUX_FOREGROUND_COMMAND_POLL_MS)) {
    terminal.lastCommandSyncAt = now;
    const foreground = await capturePaneForegroundCommand(terminal);
    if (foreground === null) {
      markTerminalClosed(terminal.terminalId, "pane not found");
      return;
    }
    if (foreground !== terminal.foregroundCommand) {
      terminal.foregroundCommand = foreground;
      commandChanged = true;
    }
  }

  const delta = computeTmuxDelta(terminal.lastCapture, capture);
  terminal.lastCapture = capture;
  setTerminalSnapshot(terminal, capture);

  if (commandChanged) {
    publishTerminalList();
  }

  if (options.emitDelta !== false && delta.length > 0) {
    emitTerminalChunk(terminal, delta);
  }
}

function maybeSendCaptureError(terminal: TerminalSession, message: string): void {
  const now = Date.now();
  const prev = captureErrorAt.get(terminal.terminalId) ?? 0;
  if (now - prev < 5000) {
    return;
  }
  captureErrorAt.set(terminal.terminalId, now);
  sendError("TMUX_CAPTURE_FAILED", `${terminal.terminalId}: ${message}`);
}

async function syncAllActiveTerminals(): Promise<void> {
  if (syncLoopBusy) {
    return;
  }
  syncLoopBusy = true;

  try {
    for (const terminal of terminals.values()) {
      if (!terminal.isActive) {
        continue;
      }
      try {
        await syncTerminalOutput(terminal);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        maybeSendCaptureError(terminal, msg);
      }
    }
  } finally {
    syncLoopBusy = false;
  }
}

function startSyncLoop(): void {
  if (syncTimer) {
    clearInterval(syncTimer);
  }
  syncTimer = setInterval(() => {
    void syncAllActiveTerminals();
  }, Math.max(100, TMUX_POLL_MS));
}

function stopSyncLoop(): void {
  if (!syncTimer) {
    return;
  }
  clearInterval(syncTimer);
  syncTimer = undefined;
}

function sanitizeWindowName(title: string): string {
  const sanitized = title
    .trim()
    .replace(/[^\w.-]/g, "_")
    .replace(/_{2,}/g, "_")
    .slice(0, 32);
  return sanitized || `terminal_${Date.now()}`;
}

async function createTerminal(title?: string, cwd?: string): Promise<string> {
  await ensureTmuxSession();

  const terminalId = uuidv4();
  const requestedCwd = cwd ?? DEFAULT_CWD;
  const actualCwd = normalizeTmuxCwd(requestedCwd);
  const displayTitle = title?.trim() || `terminal-${terminals.size + 1}`;
  const windowName = sanitizeWindowName(displayTitle);

  const created = await runTmuxWithOptionalCwd(
    ["new-window", "-P", "-F", "#{window_id} #{pane_id}", "-t", TMUX_SESSION, "-n", windowName],
    actualCwd,
  );
  const parts = created.split(/\s+/).filter(Boolean);
  const windowId = parts[0];
  const paneId = parts[1];

  if (!windowId || !paneId) {
    throw new Error(`unexpected tmux new-window output: ${JSON.stringify(created)}`);
  }

  const terminal: TerminalSession = {
    terminalId,
    title: displayTitle,
    cwd: requestedCwd,
    foregroundCommand: undefined,
    tmuxWindowId: windowId,
    tmuxPaneId: paneId,
    outputBuffer: "",
    lastCapture: "",
    lastCommandSyncAt: 0,
    updatedAt: nowIso(),
    isActive: true,
  };

  terminals.set(terminalId, terminal);
  appendTerminalNotice(terminal, `[created ${displayTitle}]\n`);
  await syncTerminalOutput(terminal, { emitDelta: false });
  publishTerminalList();
  return terminalId;
}

async function closeTerminal(terminalId: string): Promise<boolean> {
  const terminal = terminals.get(terminalId);
  if (!terminal) {
    return false;
  }

  terminal.isActive = false;
  terminal.updatedAt = nowIso();
  const result = await runTmuxRaw(["kill-window", "-t", terminal.tmuxWindowId]);
  if (result.spawnError) {
    throw new Error(commandDetail(result, TMUX_COMMAND, tmuxArgs(["kill-window", "-t", terminal.tmuxWindowId])));
  }
  if (result.code !== 0) {
    const detail = `${result.stderr}\n${result.stdout}`.toLowerCase();
    if (!detail.includes("can't find window")) {
      throw new Error(commandDetail(result, TMUX_COMMAND, tmuxArgs(["kill-window", "-t", terminal.tmuxWindowId])));
    }
  }

  publishTerminalList();
  return true;
}

const SHORTCUT_KEY_MAP: Record<string, string> = {
  __CTRL_C__: "C-c",
  __CTRL_D__: "C-d",
  __CTRL_Z__: "C-z",
  __ENTER__: "Enter",
};

function parseInputActions(data: string): InputAction[] {
  const shortcutKey = SHORTCUT_KEY_MAP[data];
  if (shortcutKey) {
    return [{ kind: "key", key: shortcutKey }];
  }

  const actions: InputAction[] = [];
  let literal = "";
  const flushLiteral = () => {
    if (!literal) {
      return;
    }
    actions.push({ kind: "literal", text: literal });
    literal = "";
  };

  for (let i = 0; i < data.length; i += 1) {
    const ch = data[i];
    const code = ch.charCodeAt(0);

    if (ch === "\r") {
      flushLiteral();
      if (data[i + 1] === "\n") {
        i += 1;
      }
      actions.push({ kind: "key", key: "Enter" });
      continue;
    }

    if (ch === "\n") {
      flushLiteral();
      actions.push({ kind: "key", key: "Enter" });
      continue;
    }

    if (code === 0x03) {
      flushLiteral();
      actions.push({ kind: "key", key: "C-c" });
      continue;
    }
    if (code === 0x04) {
      flushLiteral();
      actions.push({ kind: "key", key: "C-d" });
      continue;
    }
    if (code === 0x1a) {
      flushLiteral();
      actions.push({ kind: "key", key: "C-z" });
      continue;
    }
    if (code === 0x1b) {
      flushLiteral();
      actions.push({ kind: "key", key: "Escape" });
      continue;
    }
    if (code === 0x09) {
      flushLiteral();
      actions.push({ kind: "key", key: "Tab" });
      continue;
    }

    if (code === 0x00) {
      continue;
    }

    literal += ch;
  }

  flushLiteral();
  return actions;
}

async function sendInputAction(terminal: TerminalSession, action: InputAction): Promise<void> {
  if (action.kind === "literal") {
    if (action.text.length === 0) {
      return;
    }
    await runTmuxOrThrow(["send-keys", "-t", terminal.tmuxPaneId, "-l", action.text]);
    return;
  }
  await runTmuxOrThrow(["send-keys", "-t", terminal.tmuxPaneId, action.key]);
}

async function writeInput(terminalId: string, data: string): Promise<boolean> {
  const terminal = terminals.get(terminalId);
  if (!terminal || !terminal.isActive) {
    return false;
  }

  const actions = parseInputActions(data);
  for (const action of actions) {
    await sendInputAction(terminal, action);
  }
  terminal.updatedAt = nowIso();
  return true;
}

async function runPowerShell(command: string): Promise<string> {
  if (process.platform !== "win32") {
    throw new Error("PowerShell is only available on Windows");
  }

  const result = await runCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    windowsHide: true,
  });
  if (result.spawnError || result.code !== 0) {
    throw new Error(commandDetail(result, "powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command]));
  }
  return result.stdout.trim();
}

function parseJsonArray<T>(raw: string): T[] {
  if (!raw) {
    return [];
  }

  const parsed: unknown = JSON.parse(raw);
  if (Array.isArray(parsed)) {
    return parsed as T[];
  }

  if (parsed && typeof parsed === "object") {
    return [parsed as T];
  }

  return [];
}

function decodeUtf8Base64OrRaw(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }

  try {
    const decoded = Buffer.from(trimmed, "base64").toString("utf8").trim();
    if (decoded.startsWith("{") || decoded.startsWith("[")) {
      return decoded;
    }
  } catch {
    // fallback to raw text
  }

  return trimmed;
}

async function listScreenSources(): Promise<CaptureSource[]> {
  try {
    const displays = await screenshot.listDisplays();
    if (Array.isArray(displays) && displays.length > 0) {
      return displays.map((display, idx) => {
        const readableName = display.name ? String(display.name) : `screen-${idx + 1}`;
        return {
          source: "screen" as const,
          sourceId: String(display.id),
          label: `Screen ${idx + 1}: ${readableName}`,
        };
      });
    }
  } catch {
    // fallback below
  }

  return [
    {
      source: "screen",
      sourceId: "",
      label: "Screen: default",
    },
  ];
}

async function listWindowSourcesWindows(): Promise<CaptureSource[]> {
  if (process.platform !== "win32") {
    return [];
  }

  try {
    const raw = await runPowerShell(LIST_WINDOWS_PS_SCRIPT);
    const decodedRaw = decodeUtf8Base64OrRaw(raw);
    const windows = parseJsonArray<ListedWindow>(decodedRaw)
      .map((item) => ({
        source: "window" as const,
        sourceId: String(item.sourceId ?? ""),
        label:
          item.width && item.height
            ? `Window: ${String(item.label ?? "")}` + ` (${item.width}x${item.height})`
            : `Window: ${String(item.label ?? "")}`,
      }))
      .filter((item) => item.sourceId && item.label.trim().length > 0);

    return windows;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    sendError("WINDOW_LIST_FAILED", msg);
    return [];
  }
}

async function listCaptureSources(): Promise<CaptureSource[]> {
  const screens = await listScreenSources();
  const windows = await listWindowSourcesWindows();
  return [...screens, ...windows];
}

async function captureWindowsWindow(sourceId: string): Promise<Buffer> {
  if (process.platform !== "win32") {
    throw new Error("window capture is only supported on Windows in this agent");
  }

  if (!sourceId) {
    throw new Error("missing window sourceId");
  }

  const sourceIdBase64 = Buffer.from(sourceId, "utf8").toString("base64");
  const rawBase64 = await runPowerShell(captureWindowScript(sourceIdBase64));
  if (!rawBase64) {
    throw new Error("window capture returned empty image");
  }

  return Buffer.from(rawBase64, "base64");
}

async function captureSource(
  source: "screen" | "window",
  sourceId: string | undefined,
  terminalId: string | undefined,
  requestId?: string,
): Promise<void> {
  try {
    let image: Buffer;

    if (source === "screen") {
      if (sourceId && sourceId.trim().length > 0) {
        image = await screenshot({ format: "png", screen: sourceId });
      } else {
        image = await screenshot({ format: "png" });
      }
    } else {
      image = await captureWindowsWindow(sourceId ?? "");
    }

    send({
      type: "agent.screen_capture",
      payload: {
        source,
        sourceId,
        terminalId,
        mimeType: "image/png",
        imageBase64: image.toString("base64"),
        capturedAt: nowIso(),
        requestId,
      },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    sendError("CAPTURE_FAILED", msg, requestId);
  }
}

async function handleCaptureList(requestId?: string): Promise<void> {
  try {
    const sources = await listCaptureSources();
    send({
      type: "agent.capture_sources",
      payload: {
        requestId,
        sources,
      },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    sendError("CAPTURE_LIST_FAILED", msg, requestId);
  }
}

async function handleTerminalSnapshot(terminalId: string): Promise<void> {
  const terminal = terminals.get(terminalId);
  if (!terminal) {
    return;
  }

  if (terminal.isActive) {
    await syncTerminalOutput(terminal, { emitDelta: false });
  }

  send({
    type: "agent.terminal_output",
    payload: {
      terminalId,
      chunk: terminal.outputBuffer,
      at: nowIso(),
    },
  });
}

function sendCommandResult(
  output: string,
  requestId?: string,
  meta?: {
    progress?: boolean;
    progressSource?: string;
  },
): void {
  send({
    type: "agent.command_result",
    payload: {
      requestId,
      output,
      progress: meta?.progress,
      progressSource: meta?.progressSource,
    },
  });
}

function normalizeControlSessionKey(input: string | undefined): string {
  const trimmed = (input ?? "").trim();
  return trimmed || "default";
}

function getTmuxControlState(sessionKeyRaw: string | undefined): TmuxControlState {
  const sessionKey = normalizeControlSessionKey(sessionKeyRaw);
  const existing = tmuxControlStateBySession.get(sessionKey);
  if (existing) {
    return existing;
  }

  const state: TmuxControlState = {
    enabled: false,
    target: "",
    socket: "",
    captureLines: 120,
    waitMs: 250,
    streamMode: "auto",
    paneIndexMap: {},
  };
  tmuxControlStateBySession.set(sessionKey, state);
  return state;
}

function updateTmuxControlState(sessionKeyRaw: string | undefined, state: TmuxControlState): void {
  const sessionKey = normalizeControlSessionKey(sessionKeyRaw);
  tmuxControlStateBySession.set(sessionKey, state);
}

function formatTmuxStatus(state: TmuxControlState): string {
  const enabled = state.enabled ? "on" : "off";
  const target = state.target || "(not set)";
  const socket = state.socket || "(default)";
  return (
    "tmux status:\n"
    + `- passthrough: ${enabled}\n`
    + `- target: ${target}\n`
    + `- socket: ${socket}\n`
    + `- capture_lines: ${state.captureLines}\n`
    + `- wait_ms: ${state.waitMs}\n`
    + `- stream_mode: ${state.streamMode}`
  );
}

function tmuxWindowFromTarget(target: string): string {
  const cleaned = target.trim();
  if (cleaned.includes(".")) {
    const [window] = cleaned.split(/\.(?=[^.]+$)/);
    return window;
  }
  return cleaned;
}

function resolveTmuxTargetToken(state: TmuxControlState, token: string): { target?: string; error?: string } {
  const value = token.trim();
  if (!value) {
    return { error: "Error: empty target." };
  }
  if (/^\d+$/.test(value)) {
    const resolved = state.paneIndexMap[value];
    if (resolved) {
      return { target: resolved };
    }
    return { error: `Error: unknown pane id \`${value}\`. Run \`/tmux panes\` to refresh ids.` };
  }
  return { target: value };
}

function normalizeTmuxStreamMode(mode: string | undefined): TmuxStreamMode {
  const value = (mode ?? "auto").trim().toLowerCase();
  if (value === "on" || value === "enable" || value === "enabled" || value === "force" || value === "true") {
    return "on";
  }
  if (value === "off" || value === "disable" || value === "disabled" || value === "false" || value === "none") {
    return "off";
  }
  return "auto";
}

function expandTmuxShortAliasCommand(rawCommand: string): string | undefined {
  const stripped = rawCommand.trim();
  const lowered = stripped.toLowerCase();
  if (!lowered.startsWith("/t") || lowered.startsWith("/tmux") || lowered.startsWith("/pt")) {
    return undefined;
  }
  if (lowered === "/t") {
    return "/tmux help";
  }

  const tokens = stripped.split(/\s+/, 2);
  const head = tokens[0];
  const sub = head.slice(2).toLowerCase();
  if (!TMUX_SHORT_SUBCOMMANDS.has(sub)) {
    return undefined;
  }

  const suffix = tokens.length > 1 ? tokens[1] : "";
  return suffix ? `/tmux ${sub} ${suffix}` : `/tmux ${sub}`;
}

function isLocalPassthroughControlCommand(stripped: string): boolean {
  const lowered = stripped.toLowerCase();
  if (expandTmuxShortAliasCommand(stripped)) {
    return true;
  }
  return lowered.startsWith("/tmux") || lowered.startsWith("/passthrough") || lowered.startsWith("/pt");
}

function isPassthroughEscape(stripped: string): boolean {
  return stripped.startsWith("//");
}

function decodePassthroughEscape(rawText: string): string {
  const leading = rawText.length - rawText.trimStart().length;
  if (rawText.slice(leading, leading + 2) === "//") {
    return `${rawText.slice(0, leading)}${rawText.slice(leading + 1)}`;
  }
  return rawText;
}

function trimCommandOutput(text: string, maxChars = 12000): string {
  return text.length > maxChars ? text.slice(-maxChars) : text;
}

function toTmuxError(result: CommandResult, args: string[], socketPath?: string): string {
  const stderr = result.stderr.trim();
  const stdout = result.stdout.trim();
  if (result.spawnError) {
    return `Error: ${result.spawnError.message}`;
  }
  if (stderr) {
    return `Error: ${stderr}`;
  }
  if (stdout) {
    return `Error: ${stdout}`;
  }
  const full = [TMUX_COMMAND, ...tmuxArgsWithSocket(args, socketPath)].join(" ");
  return `Error: ${full} exited with code ${result.code}`;
}

async function runTmuxControl(
  args: string[],
  socketPath?: string,
  options: CommandOptions = {},
): Promise<{ ok: boolean; output: string }> {
  const result = await runTmuxRawWithSocket(args, socketPath, options);
  if (result.spawnError) {
    return { ok: false, output: toTmuxError(result, args, socketPath) };
  }
  if (result.code !== 0) {
    const detail = `${result.stderr}\n${result.stdout}`.toLowerCase();
    if ((args[0] === "list-sessions" || args[0] === "list-panes") && detail.includes("no server running")) {
      return { ok: true, output: "" };
    }
    return { ok: false, output: toTmuxError(result, args, socketPath) };
  }
  return { ok: true, output: result.stdout.trimEnd() };
}

async function listTmuxSessions(socketPath?: string): Promise<string> {
  const result = await runTmuxControl(
    ["list-sessions", "-F", "#{session_name}\t#{session_attached}\t#{session_windows}"],
    socketPath,
  );
  if (!result.ok) {
    return result.output;
  }

  const rows = result.output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (rows.length === 0) {
    return "No tmux sessions found.";
  }

  const lines = ["tmux sessions:"];
  for (const row of rows) {
    const parts = row.split("\t");
    const name = parts[0] || "?";
    const attached = parts[1] === "1" ? "attached" : "detached";
    const windows = parts[2] || "?";
    lines.push(`- ${name} (${attached}, windows=${windows})`);
  }
  return lines.join("\n");
}

async function listTmuxPanesData(
  socketPath?: string,
  sessionName?: string,
): Promise<{ panes: TmuxPaneRow[]; error?: string }> {
  const args = [
    "list-panes",
    "-a",
    "-F",
    "#{session_name}:#{window_index}.#{pane_index}\t#{window_name}\t#{pane_current_command}\t#{?pane_active,active,idle}",
  ];
  if (sessionName) {
    args.push("-t", sessionName);
  }

  const result = await runTmuxControl(args, socketPath);
  if (!result.ok) {
    return { panes: [], error: result.output };
  }

  const panes = result.output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((row): TmuxPaneRow => {
      const parts = row.split("\t");
      return {
        target: parts[0] || "?",
        window: parts[1] || "?",
        command: parts[2] || "?",
        activity: parts[3] || "idle",
      };
    });
  return { panes };
}

async function closeTmuxWindow(target: string, socketPath?: string): Promise<string> {
  const windowTarget = tmuxWindowFromTarget(target);
  if (!windowTarget) {
    return "Error: empty target.";
  }
  const result = await runTmuxControl(["kill-window", "-t", windowTarget], socketPath);
  if (!result.ok) {
    return result.output;
  }
  return `Closed tmux window \`${windowTarget}\`.`;
}

async function createTmuxSessionForControl(sessionName: string, socketPath?: string): Promise<string> {
  const result = await runTmuxControl(["new-session", "-d", "-s", sessionName, "-n", "shell"], socketPath);
  if (!result.ok) {
    if (result.output.toLowerCase().includes("duplicate session")) {
      return `Session '${sessionName}' already exists.`;
    }
    return result.output;
  }
  return `Created tmux session '${sessionName}'.`;
}

async function captureTmuxTarget(target: string, lines = 120, socketPath?: string): Promise<string> {
  const clampedLines = Math.max(20, Math.min(lines, 5000));
  const result = await runTmuxControl(
    ["capture-pane", "-p", "-J", "-t", target, "-S", `-${clampedLines}`],
    socketPath,
  );
  if (!result.ok) {
    return result.output;
  }
  const out = result.output.trimEnd();
  return out || "(pane has no output)";
}

async function tmuxPaneCurrentCommand(target: string, socketPath?: string): Promise<string> {
  const result = await runTmuxControl(
    ["display-message", "-p", "-t", target, "#{pane_current_command}"],
    socketPath,
  );
  if (!result.ok) {
    return "";
  }
  return result.output.trim().toLowerCase();
}

async function shouldStreamTmuxUpdates(target: string, socketPath?: string): Promise<boolean> {
  const command = await tmuxPaneCurrentCommand(target, socketPath);
  return TMUX_STREAM_COMMANDS.has(command);
}

async function sleepMs(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function captureDelta(previous: string, current: string): string {
  if (previous === current) {
    return "";
  }

  const prevLines = previous.split("\n");
  const currLines = current.split("\n");
  let idx = 0;
  const limit = Math.min(prevLines.length, currLines.length);
  while (idx < limit && prevLines[idx] === currLines[idx]) {
    idx += 1;
  }

  if (idx < currLines.length) {
    return currLines.slice(idx).join("\n").trim();
  }

  const tail = currLines.slice(-20);
  return tail.join("\n").trim();
}

function formatTmuxUpdateMessage(target: string, content: string): string {
  const body = (content.trim() || "(pane updated)");
  return `[tmux ${target} update]\n${trimCommandOutput(body)}`;
}

async function streamCaptureUpdates(
  target: string,
  initialCapture: string,
  captureLines: number,
  socketPath: string | undefined,
  onUpdate: ((content: string) => Promise<void>) | undefined,
): Promise<string> {
  const windowMs = Math.max(0, TMUX_STREAM_WINDOW_MS);
  if (windowMs <= 0) {
    return initialCapture;
  }

  const pollMs = Math.max(50, TMUX_STREAM_POLL_MS);
  const idleMs = Math.max(pollMs, TMUX_STREAM_IDLE_MS);
  const initialSilenceMs = Math.max(pollMs, TMUX_STREAM_INITIAL_SILENCE_MS);

  let latest = initialCapture;
  const startedAt = Date.now();
  let lastChangeAt = startedAt;
  let seenChange = false;

  while (Date.now() - startedAt < windowMs) {
    await sleepMs(pollMs);
    const current = await captureTmuxTarget(target, captureLines, socketPath);
    if (current.startsWith("Error:")) {
      return current;
    }

    const now = Date.now();
    if (current !== latest) {
      const delta = captureDelta(latest, current);
      const chunk = delta || current;
      if (onUpdate) {
        try {
          await onUpdate(formatTmuxUpdateMessage(target, chunk));
        } catch {
          // Ignore progress callback failures.
        }
      }
      latest = current;
      lastChangeAt = now;
      seenChange = true;
    }

    if (seenChange) {
      if (now - lastChangeAt >= idleMs) {
        break;
      }
    } else if (now - startedAt >= initialSilenceMs) {
      break;
    }
  }

  return latest;
}

async function sendLiteralToTmux(
  target: string,
  text: string,
  socketPath?: string,
  pressEnter = true,
): Promise<string | undefined> {
  const sendResult = await runTmuxControl(["send-keys", "-t", target, "-l", "--", text], socketPath);
  if (!sendResult.ok) {
    return sendResult.output;
  }

  if (!pressEnter) {
    return undefined;
  }

  await sleepMs(Math.max(0, TMUX_SUBMIT_DELAY_MS));
  const enterResult = await runTmuxControl(["send-keys", "-t", target, "Enter"], socketPath);
  if (!enterResult.ok) {
    return enterResult.output;
  }
  return undefined;
}

function normalizeKeyToken(raw: string): string {
  const key = raw.trim();
  if (!key) {
    return "";
  }

  const lowered = key.toLowerCase();
  const aliases: Record<string, string> = {
    enter: "Enter",
    return: "Enter",
    esc: "Escape",
    escape: "Escape",
    tab: "Tab",
    space: "Space",
    backspace: "BSpace",
    delete: "Delete",
    del: "Delete",
  };
  if (aliases[lowered]) {
    return aliases[lowered];
  }

  const ctrlMatch = lowered.match(/^(?:ctrl|control|c)[+\-]([a-z])$/);
  if (ctrlMatch) {
    return `C-${ctrlMatch[1]}`;
  }
  const caretMatch = lowered.match(/^\^([a-z])$/);
  if (caretMatch) {
    return `C-${caretMatch[1]}`;
  }

  return key;
}

async function sendKeysToTmux(
  target: string,
  keys: string[],
  socketPath?: string,
): Promise<string | undefined> {
  if (keys.length === 0) {
    return "Error: empty key sequence.";
  }

  const normalized: string[] = [];
  for (const token of keys) {
    const key = normalizeKeyToken(token);
    if (!key) {
      return "Error: key sequence contains an empty token.";
    }
    normalized.push(key);
  }

  const result = await runTmuxControl(["send-keys", "-t", target, ...normalized], socketPath);
  if (!result.ok) {
    return result.output;
  }
  return undefined;
}

async function tmuxPassthrough(
  target: string,
  text: string,
  socketPath: string | undefined,
  captureLines: number,
  waitMs: number,
  streamMode: TmuxStreamMode,
  onUpdate?: TmuxProgressCallback,
): Promise<string> {
  if (!text) {
    return "Error: empty command";
  }

  const sendError = await sendLiteralToTmux(target, text, socketPath, true);
  if (sendError) {
    return sendError;
  }

  const clampedWaitMs = Math.max(0, Math.min(waitMs, 5000));
  if (clampedWaitMs > 0) {
    await sleepMs(clampedWaitMs);
  }

  let capture = await captureTmuxTarget(target, captureLines, socketPath);
  if (streamMode !== "off") {
    const streamEnabled = streamMode === "on" || await shouldStreamTmuxUpdates(target, socketPath);
    if (streamEnabled) {
      capture = await streamCaptureUpdates(target, capture, captureLines, socketPath, onUpdate);
    }
  }

  return `[tmux ${target}]\n${trimCommandOutput(capture)}`;
}

async function tmuxKeyPassthrough(
  target: string,
  keys: string[],
  socketPath: string | undefined,
  captureLines: number,
  waitMs: number,
  streamMode: TmuxStreamMode,
  onUpdate?: TmuxProgressCallback,
): Promise<string> {
  const sendError = await sendKeysToTmux(target, keys, socketPath);
  if (sendError) {
    return sendError;
  }

  const clampedWaitMs = Math.max(0, Math.min(waitMs, 5000));
  if (clampedWaitMs > 0) {
    await sleepMs(clampedWaitMs);
  }

  let capture = await captureTmuxTarget(target, captureLines, socketPath);
  if (streamMode !== "off") {
    const streamEnabled = streamMode === "on" || await shouldStreamTmuxUpdates(target, socketPath);
    if (streamEnabled) {
      capture = await streamCaptureUpdates(target, capture, captureLines, socketPath, onUpdate);
    }
  }

  return `[tmux ${target}]\n${trimCommandOutput(capture)}`;
}

async function handlePassthroughCommand(sessionKey: string, rawCommand: string): Promise<string> {
  const state = getTmuxControlState(sessionKey);
  const tokens = rawCommand.trim().split(/\s+/);
  const action = (tokens[1] || "status").toLowerCase();

  if (action === "status" || action === "show") {
    return formatTmuxStatus(state);
  }

  if (action === "on" || action === "enable") {
    if (!state.target) {
      state.target = "tfclaw:0.0";
    }
    state.enabled = true;
    updateTmuxControlState(sessionKey, state);
    const socketPath = state.socket || undefined;
    const target = state.target.trim();
    const capture = await captureTmuxTarget(target, state.captureLines, socketPath);
    return (
      "Passthrough enabled.\n"
      + `Commands will be sent literally to tmux target \`${target}\`.\n`
      + "Use `/tmux panes` to inspect panes or `/tmux target <session:window.pane|id>` to switch.\n"
      + "In passthrough mode, slash commands are also forwarded by default.\n"
      + "TFClaw control commands stay local (for example `/tmux ...`, `/passthrough ...`, `/pt ...`).\n"
      + "Prefix `//` to force-send local-looking slash commands to tmux.\n\n"
      + `[tmux ${target}]\n${capture}`
    );
  }

  if (action === "off" || action === "disable") {
    state.enabled = false;
    updateTmuxControlState(sessionKey, state);
    return "Passthrough disabled.";
  }

  return (
    "Usage:\n"
    + "- /passthrough on\n"
    + "- /passthrough off\n"
    + "- /passthrough status\n"
    + "- /pt on|off|status"
  );
}

async function handleTmuxCommand(
  sessionKey: string,
  rawCommand: string,
  onProgress?: TmuxProgressCallback,
): Promise<string> {
  const state = getTmuxControlState(sessionKey);
  const stripped = rawCommand.trim();
  const tokens = stripped.split(/\s+/);
  if (tokens.length === 1 || (tokens[1] && (tokens[1].toLowerCase() === "help" || tokens[1] === "?"))) {
    return (
      "tmux commands:\n"
      + "- /tmux status\n"
      + "- /tmux sessions\n"
      + "- /tmux panes [session]\n"
      + "- /tmux new [session]\n"
      + "- /tmux target <session:window.pane|id>\n"
      + "- /tmux close <id|session:window.pane>\n"
      + "- /tmux socket <path|default>\n"
      + "- /tmux lines <20-5000>\n"
      + "- /tmux wait <0-5000>\n"
      + "- /tmux stream <auto|on|off>\n"
      + "- /tmux capture [lines]\n"
      + "- /tmux key <key...>\n"
      + "- /tmux send <literal command>\n"
      + "- /passthrough on|off|status\n"
      + "- /pt on|off|status\n"
      + "- /t<subcommand> aliases for /tmux (e.g. /tkey, /ttarget, /tcapture)"
    );
  }

  const sub = tokens[1].toLowerCase();
  const socketPath = state.socket || undefined;

  if (sub === "status") {
    return formatTmuxStatus(state);
  }

  if (sub === "sessions" || sub === "ls") {
    return listTmuxSessions(socketPath);
  }

  if (sub === "panes" || sub === "targets") {
    const sessionName = tokens[2];
    const listed = await listTmuxPanesData(socketPath, sessionName);
    if (listed.error) {
      return listed.error;
    }
    if (listed.panes.length === 0) {
      state.paneIndexMap = {};
      updateTmuxControlState(sessionKey, state);
      return "No tmux panes found.";
    }

    const lines = ["tmux panes:"];
    const nextMap: Record<string, string> = {};
    listed.panes.forEach((pane, index) => {
      const key = String(index + 1);
      nextMap[key] = pane.target;
      lines.push(`- [${key}] ${pane.target} | window=${pane.window} | cmd=${pane.command} | ${pane.activity}`);
    });
    state.paneIndexMap = nextMap;
    updateTmuxControlState(sessionKey, state);
    lines.push("Use `/tmux target <id>` or `/tmux close <id>`.");
    return lines.join("\n");
  }

  if (sub === "new") {
    const sessionName = tokens[2] || "tfclaw";
    const created = await createTmuxSessionForControl(sessionName, socketPath);
    if (created.startsWith("Error:")) {
      return created;
    }
    state.target = `${sessionName}:0.0`;
    updateTmuxControlState(sessionKey, state);
    return `${created}\nTarget set to \`${state.target}\`.`;
  }

  if (sub === "target") {
    if (tokens.length < 3) {
      return "Usage: /tmux target <session:window.pane|id>";
    }
    const resolved = resolveTmuxTargetToken(state, tokens[2]);
    if (resolved.error) {
      return resolved.error;
    }
    state.target = resolved.target!;
    updateTmuxControlState(sessionKey, state);
    const target = state.target.trim();
    const capture = await captureTmuxTarget(target, state.captureLines, socketPath);
    return `Target set to \`${target}\`.\n\n[tmux ${target}]\n${capture}`;
  }

  if (sub === "close" || sub === "kill") {
    if (tokens.length < 3) {
      return "Usage: /tmux close <id|session:window.pane>";
    }
    const resolved = resolveTmuxTargetToken(state, tokens[2]);
    if (resolved.error) {
      return resolved.error;
    }
    const target = resolved.target!;
    let result = await closeTmuxWindow(target, socketPath);
    if (result.startsWith("Error:")) {
      return result;
    }

    const closedWindow = tmuxWindowFromTarget(target);
    const currentTarget = state.target.trim();
    if (currentTarget && tmuxWindowFromTarget(currentTarget) === closedWindow) {
      state.target = "";
      result += "\nCurrent target cleared because it was in the closed window.";
    }

    const nextPaneMap: Record<string, string> = {};
    for (const [key, value] of Object.entries(state.paneIndexMap)) {
      if (tmuxWindowFromTarget(value) !== closedWindow) {
        nextPaneMap[key] = value;
      }
    }
    state.paneIndexMap = nextPaneMap;
    updateTmuxControlState(sessionKey, state);
    return result;
  }

  if (sub === "socket") {
    if (tokens.length < 3) {
      return `Current socket: \`${state.socket || "(default)"}\``;
    }
    const value = tokens[2].trim().toLowerCase();
    state.socket = (value === "default" || value === "none" || value === "off") ? "" : tokens[2].trim();
    updateTmuxControlState(sessionKey, state);
    return `Socket set to \`${state.socket || "(default)"}\`.`;
  }

  if (sub === "lines") {
    if (tokens.length < 3) {
      return `Current capture_lines: ${state.captureLines}`;
    }
    const parsed = Number.parseInt(tokens[2], 10);
    if (!Number.isFinite(parsed)) {
      return "Error: lines must be an integer.";
    }
    state.captureLines = Math.max(20, Math.min(parsed, 5000));
    updateTmuxControlState(sessionKey, state);
    return `capture_lines set to ${state.captureLines}.`;
  }

  if (sub === "wait") {
    if (tokens.length < 3) {
      return `Current wait_ms: ${state.waitMs}`;
    }
    const parsed = Number.parseInt(tokens[2], 10);
    if (!Number.isFinite(parsed)) {
      return "Error: wait must be an integer milliseconds value.";
    }
    state.waitMs = Math.max(0, Math.min(parsed, 5000));
    updateTmuxControlState(sessionKey, state);
    return `wait_ms set to ${state.waitMs}.`;
  }

  if (sub === "stream") {
    if (tokens.length < 3) {
      return `Current stream_mode: ${state.streamMode} (auto|on|off)`;
    }
    const modeRaw = tokens[2].trim().toLowerCase();
    const aliases: Record<string, TmuxStreamMode> = {
      auto: "auto",
      default: "auto",
      on: "on",
      enable: "on",
      enabled: "on",
      force: "on",
      off: "off",
      disable: "off",
      disabled: "off",
    };
    if (!aliases[modeRaw]) {
      return "Usage: /tmux stream <auto|on|off>";
    }
    state.streamMode = aliases[modeRaw];
    updateTmuxControlState(sessionKey, state);
    return `stream_mode set to ${state.streamMode}.`;
  }

  if (sub === "capture") {
    const target = state.target.trim();
    if (!target) {
      return "Error: target not set. Use `/tmux target <session:window.pane|id>` first.";
    }
    let lines = state.captureLines;
    if (tokens.length > 2) {
      const parsed = Number.parseInt(tokens[2], 10);
      if (!Number.isFinite(parsed)) {
        return "Error: capture lines must be an integer.";
      }
      lines = Math.max(20, Math.min(parsed, 5000));
    }
    const content = await captureTmuxTarget(target, lines, socketPath);
    return `[tmux ${target}]\n${content}`;
  }

  if (sub === "key" || sub === "keys" || sub === "sendkey" || sub === "sendkeys" || sub === "send-keys") {
    if (tokens.length < 3) {
      return (
        "Usage: /tmux key <key...>\n"
        + "Examples:\n"
        + "- /tmux key C-c\n"
        + "- /tmux key Enter\n"
        + "- /tmux key Ctrl+C"
      );
    }
    const target = state.target.trim();
    if (!target) {
      return "Error: target not set. Use `/tmux target <session:window.pane|id>` first.";
    }
    return tmuxKeyPassthrough(
      target,
      tokens.slice(2),
      socketPath,
      state.captureLines,
      state.waitMs,
      state.streamMode,
      onProgress,
    );
  }

  if (sub === "send") {
    if (!stripped.toLowerCase().startsWith("/tmux send ")) {
      return "Usage: /tmux send <literal command>";
    }
    const payload = stripped.slice("/tmux send ".length);
    const target = state.target.trim();
    if (!target) {
      return "Error: target not set. Use `/tmux target <session:window.pane|id>` first.";
    }
    if (!payload) {
      return "Error: empty command.";
    }
    return tmuxPassthrough(
      target,
      payload,
      socketPath,
      state.captureLines,
      state.waitMs,
      state.streamMode,
      onProgress,
    );
  }

  return "Unknown /tmux command. Use `/tmux help`.";
}

async function handleTfclawTextCommand(
  rawText: string,
  sessionKeyRaw?: string,
  onProgress?: TmuxProgressCallback,
): Promise<string> {
  const sessionKey = normalizeControlSessionKey(sessionKeyRaw);
  const stripped = rawText.trim();
  const lowered = stripped.toLowerCase();
  const tmuxAlias = expandTmuxShortAliasCommand(rawText);
  const tmuxCommand = tmuxAlias || rawText;
  const tmuxLowered = tmuxCommand.trim().toLowerCase();
  const tmuxState = getTmuxControlState(sessionKey);

  const passthroughEnabled = tmuxState.enabled;
  const passthroughEscape = isPassthroughEscape(stripped);
  const localPassthroughCommand = isLocalPassthroughControlCommand(stripped);

  if (passthroughEnabled && stripped && (passthroughEscape || !localPassthroughCommand)) {
    const target = tmuxState.target.trim();
    if (!target) {
      return "Error: passthrough is on but no target is configured. Use `/tmux target <session:window.pane|id>`.";
    }
    const passthroughText = passthroughEscape ? decodePassthroughEscape(rawText) : rawText;
    return tmuxPassthrough(
      target,
      passthroughText,
      tmuxState.socket || undefined,
      tmuxState.captureLines,
      tmuxState.waitMs,
      normalizeTmuxStreamMode(tmuxState.streamMode),
      onProgress,
    );
  }

  if (tmuxLowered.startsWith("/tmux")) {
    return handleTmuxCommand(sessionKey, tmuxCommand, onProgress);
  }

  if (lowered.startsWith("/passthrough") || lowered.startsWith("/pt")) {
    let passthroughCommand = rawText;
    if (lowered.startsWith("/pt")) {
      if (stripped === "/pt") {
        passthroughCommand = "/passthrough";
      } else {
        passthroughCommand = `/passthrough ${stripped.slice(3).trim()}`;
      }
    }
    return handlePassthroughCommand(sessionKey, passthroughCommand);
  }

  if (lowered === "/new") {
    tmuxControlStateBySession.delete(sessionKey);
    return "New session started.";
  }

  if (lowered === "/help") {
    return (
      "tfclaw commands:\n"
      + "/new - Start a new command session\n"
      + "/help - Show available commands\n"
      + "/tmux help - tmux control commands\n"
      + "/tmux key C-c - send shortcut keys to tmux pane\n"
      + "/tkey ... /ttarget ... - shorthand aliases for /tmux subcommands\n"
      + "/passthrough on|off|status - literal tmux passthrough mode\n"
      + "/pt on|off|status - shorthand alias for /passthrough"
    );
  }

  return "Unknown command. Use `/help` or `/tmux help`.";
}

async function handleCommand(command: ClientCommand): Promise<void> {
  const payload = command.payload;

  try {
    switch (payload.command) {
      case "terminal.create": {
        await createTerminal(payload.title, payload.cwd);
        return;
      }
      case "terminal.close": {
        const ok = await closeTerminal(payload.terminalId);
        if (!ok) {
          sendError("TERMINAL_NOT_FOUND", `terminal not found: ${payload.terminalId}`, command.requestId);
        }
        return;
      }
      case "terminal.input": {
        const ok = await writeInput(payload.terminalId, payload.data);
        if (!ok) {
          sendError("TERMINAL_NOT_FOUND", `cannot write to terminal: ${payload.terminalId}`, command.requestId);
        }
        return;
      }
      case "terminal.snapshot": {
        await handleTerminalSnapshot(payload.terminalId);
        return;
      }
      case "capture.list": {
        await handleCaptureList(command.requestId);
        return;
      }
      case "screen.capture": {
        await captureSource(payload.source, payload.sourceId, payload.terminalId, command.requestId);
        return;
      }
      case "tfclaw.command": {
        const onProgress: TmuxProgressCallback = async (content: string) => {
          sendCommandResult(content, command.requestId, {
            progress: true,
            progressSource: "tmux",
          });
        };
        const output = await handleTfclawTextCommand(payload.text, payload.sessionKey, onProgress);
        sendCommandResult(output, command.requestId);
        return;
      }
      default: {
        console.error("Unknown command payload:", payload);
      }
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    const code = payload.command.startsWith("terminal.") ? "TMUX_COMMAND_FAILED" : "AGENT_COMMAND_FAILED";
    sendError(code, msg, command.requestId);
  }
}

function handleIncoming(raw: WebSocket.RawData): void {
  const text = raw.toString();
  const message = safeJsonParse(text);
  if (!message) {
    return;
  }

  if (message.type === "client.command") {
    void handleCommand(message);
  }
}

function connect(): void {
  const url = toRelayWsUrl(RELAY_URL);
  ws = new WebSocket(url);

  ws.on("open", () => {
    reconnectAttempts = 0;
    console.log(`Connected to relay: ${url}`);
    publishRegister();

    void (async () => {
      if (terminals.size === 0) {
        for (let i = 0; i < START_TERMINALS; i += 1) {
          try {
            await createTerminal(`terminal-${i + 1}`);
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            sendError("TMUX_CREATE_FAILED", msg);
          }
        }
      } else {
        publishTerminalList();
      }
      await syncAllActiveTerminals();
    })();
  });

  ws.on("message", (raw) => handleIncoming(raw));

  ws.on("close", () => {
    if (closing) {
      return;
    }
    reconnectAttempts += 1;
    const delay = Math.min(10000, 500 * reconnectAttempts);
    console.log(`Relay disconnected. Reconnecting in ${delay}ms...`);
    setTimeout(connect, delay);
  });

  ws.on("error", (err) => {
    console.error("Relay error:", err.message);
  });
}

async function shutdown(): Promise<void> {
  closing = true;
  stopSyncLoop();
  ws?.close();
  ws = undefined;
  terminals.clear();

  if (!TMUX_PERSIST_SESSION_ON_SHUTDOWN) {
    await killTmuxSessionSilently();
  }
}

async function bootstrap(): Promise<void> {
  try {
    await ensureTmuxAvailable();

    if (TMUX_RESET_ON_BOOT) {
      await killTmuxSessionSilently();
    }
    await ensureTmuxSession();

    startSyncLoop();
    connect();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`terminal-agent startup failed: ${msg}`);
    process.exit(1);
  }
}

process.on("SIGINT", () => {
  void shutdown().finally(() => {
    process.exit(0);
  });
});

process.on("SIGTERM", () => {
  void shutdown().finally(() => {
    process.exit(0);
  });
});

void bootstrap();
