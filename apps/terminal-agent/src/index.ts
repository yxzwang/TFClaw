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
  tmuxWindowId: string;
  tmuxPaneId: string;
  outputBuffer: string;
  lastCapture: string;
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
const TMUX_MAX_DELTA_CHARS = Number.parseInt(process.env.TFCLAW_TMUX_MAX_DELTA_CHARS ?? "4000", 10);
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
$results | Sort-Object label | ConvertTo-Json -Compress -Depth 4
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

  const delta = computeTmuxDelta(terminal.lastCapture, capture);
  terminal.lastCapture = capture;
  setTerminalSnapshot(terminal, capture);

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
    tmuxWindowId: windowId,
    tmuxPaneId: paneId,
    outputBuffer: "",
    lastCapture: "",
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
    const windows = parseJsonArray<ListedWindow>(raw)
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
