#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const WebSocket = require("ws");

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const cur = argv[i];
    if (!cur.startsWith("--")) {
      continue;
    }
    const [key, inlineVal] = cur.slice(2).split("=", 2);
    if (typeof inlineVal === "string") {
      out[key] = inlineVal;
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = "true";
    }
  }
  return out;
}

const args = parseArgs(process.argv);
const relayBase = args.relay || process.env.TFCLAW_RELAY_URL || "ws://127.0.0.1:8787";
const token = args.token || process.env.TFCLAW_TOKEN || "demo-token";
const outputDir = path.resolve(args.out || process.env.TFCLAW_CAPTURE_OUT || "captures");
const autoTerminalMode = String(args.terminal || "").toLowerCase() === "true" || String(args.terminal || "") === "1";
const autoTerminalRawMode =
  String(args["terminal-raw"] || "").toLowerCase() === "true" || String(args["terminal-raw"] || "") === "1";

const relayUrl = `${relayBase.replace(/\/+$/, "")}/?role=client&token=${encodeURIComponent(token)}`;
const ws = new WebSocket(relayUrl);
let intentionalClose = false;
let passthroughMode = false;
let rawPassthroughMode = false;
let autoTerminalModePending = autoTerminalMode;
let autoTerminalRawModePending = autoTerminalRawMode;
let pendingEnterPassthrough = false;
let pendingEnterRawPassthrough = false;
let pendingPassthroughLines = [];
let pendingAttachNewTitle = undefined;

let agentInfo = undefined;
let terminals = [];
let snapshots = new Map();
let outputHistory = new Map();
let outputRawLog = new Map();
let outputAnsiEvents = new Map();
let outputHistoryCarry = new Map();
let outputDisplayCarry = new Map();
let dynamicNoticeAt = new Map();
let selectedTerminalId = undefined;
let captureSources = [];
let showAllTerminalOutputs = false;
const supportsAnsiColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const ANSI = {
  reset: "\x1b[0m",
  // Closer to PowerShell code-style blue (VS Code / PS extension palette).
  blue: "\x1b[38;2;86;156;214m",
};
const historyMaxLines = Number.parseInt(process.env.TFCLAW_LOCAL_HISTORY_MAX_LINES || "50000", 10);
const rawLogMaxChars = Number.parseInt(process.env.TFCLAW_LOCAL_RAW_MAX_CHARS || "4000000", 10);
const ansiEventMaxCount = Number.parseInt(process.env.TFCLAW_LOCAL_ANSI_EVENT_MAX || "40000", 10);
const dynamicNoticeIntervalMs = Number.parseInt(process.env.TFCLAW_LOCAL_DYNAMIC_NOTICE_MS || "1200", 10);

const nativeConsoleLog = console.log.bind(console);
console.log = (...args) => {
  nativeConsoleLog(...args);
  nativeConsoleLog("");
};

function blue(text) {
  if (!supportsAnsiColor) {
    return text;
  }
  return `${ANSI.blue}${text}${ANSI.reset}`;
}

function printInputSpacer() {
  if (!process.stdout.isTTY) {
    return;
  }
  process.stdout.write("\n");
}

function nowTs() {
  const d = new Date();
  return d.toISOString().replace(/[:.]/g, "-");
}

function randomId(prefix = "req") {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

function printTerminals() {
  if (!terminals.length) {
    console.log("No terminals.");
    return;
  }
  console.log("Terminals:");
  terminals.forEach((t, idx) => {
    const flag = t.terminalId === selectedTerminalId ? " *selected" : "";
    console.log(`${idx + 1}. ${blue(t.title)} [${blue(t.terminalId)}] ${t.isActive ? "active" : "closed"}${flag}`);
  });
}

function resolveTerminal(ref) {
  if (!ref) {
    return undefined;
  }
  if (/^\d+$/.test(ref)) {
    const idx = Number.parseInt(ref, 10) - 1;
    if (idx >= 0 && idx < terminals.length) {
      return terminals[idx];
    }
  }
  return terminals.find((t) => t.terminalId === ref || t.title === ref);
}

function sendCommand(payload) {
  if (ws.readyState !== WebSocket.OPEN) {
    console.log("not connected to relay yet");
    return undefined;
  }
  const requestId = randomId("cmd");
  ws.send(
    JSON.stringify({
      type: "client.command",
      requestId,
      payload,
    }),
  );
  return requestId;
}

function printHelp() {
  console.log(`Commands:
help
state
list
use <index|terminalId|title>
new [title]
close [index|terminalId|title]
send <command text>          # appends newline
raw <text>                   # send as-is
terminal | attach            # line-based passthrough mode
attach-new                   # create a fresh terminal then attach (line mode)
attach-raw                   # key-by-key raw passthrough to terminal stdin
<terminal-ref>: <message>    # send message to specific terminal
ctrlc | ctrld | enter
snapshot [index|terminalId|title]
capture-list
capture <source-index>
tail [index|terminalId|title]
history [index|terminalId|title] [line-count]
render [index|terminalId|title] [output-file]
render-live [index|terminalId|title] [output-file]
watch selected|all
exit | quit`);
}

function saveCapture(payload) {
  fs.mkdirSync(outputDir, { recursive: true });
  const suffix = payload.source === "window" ? "window" : "screen";
  const sourceIdSafe = (payload.sourceId || "default").replace(/[^\w.-]/g, "_").slice(0, 60);
  const file = path.join(outputDir, `${nowTs()}_${suffix}_${sourceIdSafe}.png`);
  fs.writeFileSync(file, Buffer.from(payload.imageBase64, "base64"));
  console.log(`[capture] saved => ${file}`);
}

function printState() {
  const agentText = agentInfo ? `${agentInfo.hostname} (${agentInfo.platform})` : "not connected";
  console.log(`Agent: ${agentText}`);
  printTerminals();
}

function stripAnsiSequences(text) {
  return text
    .replace(/\x1B\][^\x07]*(\x07|\x1B\\)/g, "")
    .replace(/\x1B[@-_][0-?]*[ -/]*[@-~]/g, "");
}

function applyBackspaceSemantics(text) {
  const out = [];
  for (const ch of text) {
    if (ch === "\b") {
      if (out.length > 0) {
        out.pop();
      }
      continue;
    }
    out.push(ch);
  }
  return out.join("");
}

function normalizeOutputChunk(chunk) {
  let text = stripAnsiSequences(chunk);
  text = applyBackspaceSemantics(text);
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
  return text;
}

function appendAnsiEvent(terminalId, chunk) {
  if (!chunk) {
    return;
  }
  const arr = outputAnsiEvents.get(terminalId) || [];
  arr.push({
    ts: Date.now(),
    data: Buffer.from(chunk, "utf8").toString("base64"),
  });
  const capped = arr.length > ansiEventMaxCount ? arr.slice(-ansiEventMaxCount) : arr;
  outputAnsiEvents.set(terminalId, capped);
}

function appendHistory(terminalId, text) {
  const rawCurrent = outputRawLog.get(terminalId) || "";
  const rawMerged = `${rawCurrent}${text}`;
  outputRawLog.set(terminalId, rawMerged.length > rawLogMaxChars ? rawMerged.slice(-rawLogMaxChars) : rawMerged);

  const current = outputHistory.get(terminalId) || [];
  const carry = outputHistoryCarry.get(terminalId) || "";
  const merged = `${carry}${text}`;
  const parts = merged.split("\n");
  const rest = parts.pop() || "";
  outputHistoryCarry.set(terminalId, rest);
  for (const part of parts) {
    const line = part.trimEnd();
    if (line.length > 0) {
      current.push(line);
    }
  }
  const capped = current.length > historyMaxLines ? current.slice(-historyMaxLines) : current;
  outputHistory.set(terminalId, capped);
}

function printHistory(terminalId, count = 80) {
  const lines = outputHistory.get(terminalId) || [];
  const carry = (outputHistoryCarry.get(terminalId) || "").trimEnd();
  const merged = carry.length > 0 ? [...lines, carry] : lines;
  if (merged.length === 0) {
    console.log("(no history yet)");
    return;
  }
  const out = merged.slice(-count);
  for (const line of out) {
    console.log(line);
  }
}

function takeDisplayLines(terminalId, text) {
  const carry = outputDisplayCarry.get(terminalId) || "";
  const merged = `${carry}${text}`;
  const parts = merged.split("\n");
  const rest = parts.pop() || "";
  outputDisplayCarry.set(terminalId, rest);
  return parts.map((line) => line.trimEnd()).filter((line) => line.length > 0);
}

function looksDynamicScreenChunk(rawChunk) {
  if (!rawChunk || !rawChunk.includes("\x1b[")) {
    return false;
  }
  const hasCursorOrScreenCtrl =
    /\x1b\[[0-9;?]*[ABCDHJKfX]/.test(rawChunk) || /\x1b\[\?[0-9;]*[hl]/.test(rawChunk);
  return hasCursorOrScreenCtrl && rawChunk.length >= 80;
}

function shouldPrintDynamicNotice(terminalId) {
  const now = Date.now();
  const prev = dynamicNoticeAt.get(terminalId) || 0;
  if (now - prev < dynamicNoticeIntervalMs) {
    return false;
  }
  dynamicNoticeAt.set(terminalId, now);
  return true;
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function platformLineEnding() {
  return agentInfo?.platform === "windows" ? "\r" : "\n";
}

function sendTerminalLine(terminalId, line) {
  sendCommand({
    command: "terminal.input",
    terminalId,
    data: `${line}${platformLineEnding()}`,
  });
}

function resolveRenderTargetAndFile(restText) {
  const trimmed = restText.trim();
  if (!trimmed) {
    return { ref: "", file: "" };
  }
  const parts = trimmed.split(" ").filter(Boolean);
  if (parts.length === 1) {
    const maybeTerminal = resolveTerminal(parts[0]);
    if (maybeTerminal) {
      return { ref: parts[0], file: "" };
    }
    return { ref: "", file: parts[0] };
  }
  const maybeTerminal = resolveTerminal(parts[0]);
  if (maybeTerminal) {
    return { ref: parts[0], file: parts.slice(1).join(" ") };
  }
  return { ref: "", file: trimmed };
}

function renderTerminalOutput(terminalId, terminalTitle, outPathInput) {
  const raw = outputRawLog.get(terminalId) || snapshots.get(terminalId) || "";
  if (!raw) {
    console.log("(no output yet)");
    return;
  }

  fs.mkdirSync(outputDir, { recursive: true });
  const safeTitle = (terminalTitle || terminalId).replace(/[^\w.-]/g, "_").slice(0, 60);
  const defaultFile = path.join(outputDir, `${nowTs()}_terminal_${safeTitle}.html`);
  const outPath = outPathInput ? path.resolve(outPathInput) : defaultFile;
  const ext = path.extname(outPath).toLowerCase();

  if (ext === ".txt") {
    fs.writeFileSync(outPath, raw, "utf8");
    console.log(`[render] saved text => ${outPath}`);
    return;
  }

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>TFClaw Terminal Render</title>
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; padding: 20px; background: #0b1117; color: #d8f7cf; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; }
    .meta { margin-bottom: 12px; color: #96bba2; font-size: 13px; }
    .terminal { white-space: pre-wrap; line-height: 1.35; background: #111921; border: 1px solid #244034; border-radius: 8px; padding: 14px; }
  </style>
</head>
<body>
  <div class="meta">Terminal: ${escapeHtml(terminalTitle || terminalId)} (${escapeHtml(terminalId)})</div>
  <div class="meta">Rendered at: ${escapeHtml(new Date().toISOString())}</div>
  <div class="terminal">${escapeHtml(raw)}</div>
</body>
</html>`;

  fs.writeFileSync(outPath, html, "utf8");
  console.log(`[render] saved html => ${outPath}`);
}

function renderTerminalReplayHtml(terminalId, terminalTitle, outPathInput) {
  const streamEvents = outputAnsiEvents.get(terminalId) || [];
  const snapshotRaw = outputRawLog.get(terminalId) || snapshots.get(terminalId) || "";
  const fromSnapshotOnly = streamEvents.length === 0 && snapshotRaw.length > 0;
  if (streamEvents.length === 0 && !snapshotRaw) {
    console.log("(no output yet)");
    return;
  }

  fs.mkdirSync(outputDir, { recursive: true });
  const safeTitle = (terminalTitle || terminalId).replace(/[^\w.-]/g, "_").slice(0, 60);
  const defaultFile = path.join(outputDir, `${nowTs()}_terminal_${safeTitle}_replay.html`);
  const outPath = outPathInput ? path.resolve(outPathInput) : defaultFile;

  const replayEvents =
    streamEvents.length > 0
      ? (() => {
          const baseTs = streamEvents[0].ts;
          return streamEvents.map((e) => ({
            dt: Math.max(0, e.ts - baseTs),
            data: e.data,
          }));
        })()
      : [
          {
            dt: 0,
            data: Buffer.from(snapshotRaw, "utf8").toString("base64"),
          },
        ];

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>TFClaw Terminal Replay</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.5.0/css/xterm.min.css" />
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; padding: 14px; background: #0a1016; color: #d2f3de; font-family: ui-sans-serif, system-ui, sans-serif; }
    .meta { margin-bottom: 8px; color: #9dbca9; font-size: 12px; }
    .controls { margin: 8px 0 12px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    button, select { background: #1a2935; color: #d8f2ff; border: 1px solid #32556d; border-radius: 6px; padding: 6px 10px; cursor: pointer; }
    .hint { color: #8aa2b3; font-size: 12px; }
    #terminal { height: 70vh; border: 1px solid #2f475b; border-radius: 8px; overflow: hidden; display: none; }
    #fallback { height: 70vh; margin: 0; border: 1px solid #2f475b; border-radius: 8px; overflow: auto; padding: 12px; white-space: pre-wrap; line-height: 1.35; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; background: #0f1720; color: #d8f7cf; display: none; }
    .warning { color: #ffcc80; font-size: 12px; margin-bottom: 8px; display: none; }
  </style>
</head>
<body>
  <div class="meta">Terminal: ${escapeHtml(terminalTitle || terminalId)} (${escapeHtml(terminalId)})</div>
  <div class="meta">Generated: ${escapeHtml(new Date().toISOString())}</div>
  <div id="warning" class="warning"></div>
  <div class="controls">
    <button id="play">Play</button>
    <button id="pause">Pause</button>
    <button id="reset">Reset</button>
    <label>Speed
      <select id="speed">
        <option value="0.25">0.25x</option>
        <option value="0.5">0.5x</option>
        <option value="1" selected>1x</option>
        <option value="2">2x</option>
        <option value="4">4x</option>
      </select>
    </label>
    <span class="hint">Dynamic output (spinner/progress/working...) is replayed from raw ANSI stream.</span>
  </div>
  <div id="terminal"></div>
  <pre id="fallback"></pre>
  <script src="https://cdn.jsdelivr.net/npm/xterm@5.5.0/lib/xterm.min.js"></script>
  <script>
    const events = ${JSON.stringify(replayEvents)};
    const warningEl = document.getElementById("warning");
    const termEl = document.getElementById("terminal");
    const fallbackEl = document.getElementById("fallback");
    let term = null;
    let fallbackMode = false;

    function showWarning(text) {
      warningEl.textContent = text;
      warningEl.style.display = "block";
    }

    let speed = 1;
    let idx = 0;
    let running = false;
    let timer = null;
    let startedAt = 0;
    let pausedAt = 0;

    function b64ToString(b64) {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new TextDecoder("utf-8").decode(bytes);
    }

    function stripAnsi(text) {
      return text
        .replace(/\u001B\][^\u0007]*(\u0007|\u001B\\\\)/g, "")
        .replace(/\u001B[@-_][0-?]*[ -/]*[@-~]/g, "");
    }

    function fallbackWrite(text) {
      fallbackEl.textContent += stripAnsi(text);
      fallbackEl.scrollTop = fallbackEl.scrollHeight;
    }

    function clearTimer() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    }

    function renderUntil(nowMs) {
      while (idx < events.length) {
        const due = events[idx].dt / speed;
        if (due > nowMs) break;
        const chunk = b64ToString(events[idx].data);
        if (fallbackMode) {
          fallbackWrite(chunk);
        } else {
          term.write(chunk);
        }
        idx += 1;
      }
    }

    function scheduleNext() {
      clearTimer();
      if (!running) return;
      if (idx >= events.length) {
        running = false;
        return;
      }
      const elapsed = Date.now() - startedAt;
      renderUntil(elapsed);
      if (idx >= events.length) {
        running = false;
        return;
      }
      const nextDue = events[idx].dt / speed;
      const wait = Math.max(0, Math.min(200, nextDue - (Date.now() - startedAt)));
      timer = setTimeout(scheduleNext, wait);
    }

    function play() {
      if (running) return;
      running = true;
      if (pausedAt > 0) {
        startedAt = Date.now() - pausedAt;
        pausedAt = 0;
      } else if (idx === 0) {
        startedAt = Date.now();
      } else {
        const lastDt = events[idx - 1].dt / speed;
        startedAt = Date.now() - lastDt;
      }
      scheduleNext();
    }

    function pause() {
      if (!running) return;
      running = false;
      pausedAt = Date.now() - startedAt;
      clearTimer();
    }

    function reset() {
      pause();
      idx = 0;
      pausedAt = 0;
      if (fallbackMode) {
        fallbackEl.textContent = "";
      } else {
        term.reset();
        term.clear();
      }
    }

    document.getElementById("play").addEventListener("click", play);
    document.getElementById("pause").addEventListener("click", pause);
    document.getElementById("reset").addEventListener("click", reset);
    document.getElementById("speed").addEventListener("change", (e) => {
      const next = Number(e.target.value || "1");
      if (!Number.isFinite(next) || next <= 0) return;
      const wasRunning = running;
      pause();
      speed = next;
      if (wasRunning) play();
    });

    if (window.Terminal) {
      termEl.style.display = "block";
      term = new window.Terminal({
        convertEol: false,
        disableStdin: true,
        cursorBlink: false,
        scrollback: 5000,
        theme: {
          background: "#0f1720",
          foreground: "#d8f7cf"
        }
      });
      term.open(termEl);
    } else {
      fallbackMode = true;
      fallbackEl.style.display = "block";
      showWarning("xterm failed to load from CDN. Using fallback text replay.");
    }

    play();
  </script>
</body>
</html>`;

  fs.writeFileSync(outPath, html, "utf8");
  console.log(`[render-live] saved replay html => ${outPath}`);
  if (fromSnapshotOnly) {
    console.log("[render-live] ansi stream unavailable, fallback used snapshot text only.");
  }
}

function currentSelectedTerminal() {
  return terminals.find((t) => t.terminalId === selectedTerminalId);
}

function updatePrompt() {
  if (!rl) {
    return;
  }
  if (!passthroughMode) {
    rl.setPrompt(`${blue("tfclaw")}> `);
    return;
  }
  if (rawPassthroughMode) {
    rl.setPrompt("");
    return;
  }
  const t = currentSelectedTerminal();
  const marker = t ? blue(t.title) : blue("no-terminal");
  rl.setPrompt(`${blue("terminal")}:${marker}> `);
}

function enterPassthroughMode() {
  if (!selectedTerminalId) {
    if (terminals.length > 0) {
      selectedTerminalId = terminals[0].terminalId;
    } else {
      const req = sendCommand({
        command: "terminal.create",
        title: `local-attach-${Date.now()}`,
      });
      if (!req) {
        console.log("no selected terminal, and cannot create one yet");
        return;
      }
      pendingEnterPassthrough = true;
      console.log("no terminal available. creating one, will enter terminal mode automatically...");
      return;
    }
  }
  pendingEnterPassthrough = false;
  passthroughMode = true;
  updatePrompt();
  console.log("entered terminal mode. type commands directly.");
  console.log("terminal mode special commands: .ctrlc  .ctrld  .exit");
}

function leavePassthroughMode() {
  passthroughMode = false;
  updatePrompt();
  console.log("left terminal mode.");
}

function attachNewLineMode() {
  const title = `attach-new-${Date.now()}`;
  const req = sendCommand({
    command: "terminal.create",
    title,
  });
  if (!req) {
    console.log("failed to request new terminal");
    return;
  }
  pendingAttachNewTitle = title;
  pendingEnterPassthrough = true;
  console.log(`creating fresh terminal "${title}" and attaching when ready...`);
}

function sendInputChunkToTerminal(terminalId, chunkText) {
  if (!terminalId || !chunkText) {
    return;
  }
  ws.send(
    JSON.stringify({
      type: "client.command",
      payload: {
        command: "terminal.input",
        terminalId,
        data: chunkText,
      },
    }),
  );
}

function onRawStdinData(buf) {
  if (!rawPassthroughMode || !selectedTerminalId) {
    return;
  }
  let start = 0;
  for (let i = 0; i < buf.length; i += 1) {
    const code = buf[i];
    if (code === 0x1d) {
      if (i > start) {
        const chunk = buf.subarray(start, i).toString("utf8");
        sendInputChunkToTerminal(selectedTerminalId, chunk);
      }
      leaveRawPassthroughMode();
      rl.prompt();
      start = i + 1;
    }
  }
  if (start < buf.length) {
    const chunk = buf.subarray(start).toString("utf8");
    sendInputChunkToTerminal(selectedTerminalId, chunk);
  }
}

function enterRawPassthroughMode() {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    console.log("raw terminal mode is not available in this shell; fallback to attach-line mode.");
    enterPassthroughMode();
    return;
  }
  if (!selectedTerminalId) {
    if (terminals.length > 0) {
      selectedTerminalId = terminals[0].terminalId;
    } else {
      const req = sendCommand({
        command: "terminal.create",
        title: `local-attach-${Date.now()}`,
      });
      if (!req) {
        console.log("no selected terminal, and cannot create one yet");
        return;
      }
      pendingEnterRawPassthrough = true;
      console.log("no terminal available. creating one, will enter raw terminal mode automatically...");
      return;
    }
  }
  pendingEnterRawPassthrough = false;
  passthroughMode = true;
  rawPassthroughMode = true;
  rl.pause();
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", onRawStdinData);
  updatePrompt();
  const t = currentSelectedTerminal();
  console.log(`entered raw terminal mode: ${t ? t.title : selectedTerminalId}`);
  console.log("all keys are sent to the terminal program directly.");
  console.log("press Ctrl+] to exit raw mode.");
}

function leaveRawPassthroughMode() {
  if (!rawPassthroughMode) {
    return;
  }
  rawPassthroughMode = false;
  passthroughMode = false;
  process.stdin.off("data", onRawStdinData);
  if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
    process.stdin.setRawMode(false);
  }
  rl.resume();
  updatePrompt();
  console.log("left raw terminal mode.");
}

function flushPendingPassthroughLines() {
  if (!selectedTerminalId || pendingPassthroughLines.length === 0) {
    return;
  }
  for (const line of pendingPassthroughLines) {
    if (line.length === 0) {
      sendCommand({
        command: "terminal.input",
        terminalId: selectedTerminalId,
        data: "__ENTER__",
      });
    } else {
      sendTerminalLine(selectedTerminalId, line);
    }
  }
  pendingPassthroughLines = [];
}

ws.on("open", () => {
  console.log(`[connected] ${relayUrl}`);
  ws.send(
    JSON.stringify({
      type: "client.hello",
      payload: { clientType: "web" },
    }),
  );
  printHelp();
  updatePrompt();
  if (!rawPassthroughMode) {
    rl.prompt();
  }
});

ws.on("message", (raw) => {
  let msg;
  try {
    msg = JSON.parse(String(raw));
  } catch {
    console.log("[relay] invalid json");
    rl.prompt();
    return;
  }

  switch (msg.type) {
    case "relay.state": {
      const prevSelectedTerminalId = selectedTerminalId;
      agentInfo = msg.payload.agent;
      terminals = Array.isArray(msg.payload.terminals) ? msg.payload.terminals : [];
      const ss = Array.isArray(msg.payload.snapshots) ? msg.payload.snapshots : [];
      ss.forEach((s) => snapshots.set(s.terminalId, s.output));
      const selectedStillExists =
        !!selectedTerminalId && terminals.some((t) => t.terminalId === selectedTerminalId && t.isActive);
      if (!selectedStillExists) {
        const next = terminals.find((t) => t.isActive) ?? terminals[0];
        selectedTerminalId = next?.terminalId;
      }
      if (pendingAttachNewTitle) {
        const created = terminals.find((t) => t.title === pendingAttachNewTitle);
        if (created) {
          selectedTerminalId = created.terminalId;
          pendingAttachNewTitle = undefined;
        }
      }
      const waitingForAttachNew = !!pendingAttachNewTitle;
      if (
        !waitingForAttachNew &&
        (autoTerminalModePending || autoTerminalRawModePending || pendingEnterPassthrough || pendingEnterRawPassthrough) &&
        selectedTerminalId
      ) {
        const enterRaw = autoTerminalRawModePending || pendingEnterRawPassthrough;
        autoTerminalModePending = false;
        autoTerminalRawModePending = false;
        pendingEnterPassthrough = false;
        pendingEnterRawPassthrough = false;
        if (enterRaw) {
          enterRawPassthroughMode();
        } else {
          enterPassthroughMode();
          flushPendingPassthroughLines();
        }
      }
      if (prevSelectedTerminalId !== selectedTerminalId) {
        updatePrompt();
      }
      break;
    }
    case "relay.ack": {
      if (!msg.payload.requestId && msg.payload.ok) {
        break;
      }
      const text = msg.payload.ok ? "ok" : "error";
      const req = msg.payload.requestId ? ` requestId=${msg.payload.requestId}` : "";
      const detail = msg.payload.message ? ` message=${msg.payload.message}` : "";
      console.log(`[ack] ${text}${req}${detail}`);
      break;
    }
    case "agent.terminal_output": {
      const rawChunk = String(msg.payload.chunk || "");
      appendAnsiEvent(msg.payload.terminalId, rawChunk);
      const normalized = normalizeOutputChunk(rawChunk);
      if (normalized) {
        const prev = snapshots.get(msg.payload.terminalId) || "";
        const merged = `${prev}${normalized}`;
        snapshots.set(msg.payload.terminalId, merged.length > 16000 ? merged.slice(-16000) : merged);
        appendHistory(msg.payload.terminalId, normalized);
      }
      if (!showAllTerminalOutputs) {
        if (!selectedTerminalId) {
          selectedTerminalId = msg.payload.terminalId;
        }
        if (msg.payload.terminalId !== selectedTerminalId) {
          break;
        }
      }
      const outTag = blue("out");
      const selectedPrefix =
        msg.payload.terminalId === selectedTerminalId
          ? `[${outTag}]`
          : `[${outTag} ${blue(msg.payload.terminalId)}]`;
      if (looksDynamicScreenChunk(rawChunk)) {
        if (shouldPrintDynamicNotice(msg.payload.terminalId)) {
          console.log(`${selectedPrefix} [dynamic frame] output condensed; use "render-live" for full ANSI replay.`);
        }
        break;
      }
      if (!normalized) {
        break;
      }
      const lines = takeDisplayLines(msg.payload.terminalId, normalized);
      for (const line of lines) {
        console.log(`${selectedPrefix} ${line}`);
      }
      break;
    }
    case "agent.capture_sources": {
      captureSources = Array.isArray(msg.payload.sources) ? msg.payload.sources : [];
      if (!captureSources.length) {
        console.log("[capture] no sources");
        break;
      }
      console.log("Capture sources:");
      captureSources.forEach((s, i) => {
        console.log(`${i + 1}. [${s.source}] ${s.label}  sourceId=${s.sourceId}`);
      });
      break;
    }
    case "agent.screen_capture": {
      saveCapture(msg.payload);
      break;
    }
    case "agent.error": {
      const req = msg.payload.requestId ? ` requestId=${msg.payload.requestId}` : "";
      console.log(`[agent-error] ${msg.payload.code}${req}: ${msg.payload.message}`);
      break;
    }
    default: {
      break;
    }
  }

  if (!rawPassthroughMode) {
    rl.prompt();
  }
});

ws.on("close", () => {
  if (rawPassthroughMode) {
    leaveRawPassthroughMode();
  }
  console.log("[disconnected]");
  process.exit(0);
});

ws.on("error", (err) => {
  if (intentionalClose && /before the connection was established/i.test(err.message)) {
    return;
  }
  console.error("[ws-error]", err.message);
});

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "tfclaw> ",
});

rl.on("line", (line) => {
  printInputSpacer();
  const trimmed = line.trim();
  if (rawPassthroughMode) {
    return;
  }
  if ((pendingEnterPassthrough || pendingEnterRawPassthrough) && !passthroughMode) {
    if (trimmed === ".cancel") {
      pendingEnterPassthrough = false;
      pendingEnterRawPassthrough = false;
      pendingPassthroughLines = [];
      console.log("attach canceled.");
      rl.prompt();
      return;
    }
    if (pendingEnterRawPassthrough) {
      console.log("terminal is preparing for raw mode. wait or type .cancel.");
      rl.prompt();
      return;
    }
    pendingPassthroughLines.push(line);
    console.log("terminal is preparing. queued input (type .cancel to cancel attach).");
    rl.prompt();
    return;
  }
  if (passthroughMode) {
    if (trimmed === ".exit" || trimmed === ".quit") {
      leavePassthroughMode();
      rl.prompt();
      return;
    }
    if (trimmed === ".ctrlc") {
      if (selectedTerminalId) {
        sendCommand({
          command: "terminal.input",
          terminalId: selectedTerminalId,
          data: "__CTRL_C__",
        });
      } else {
        console.log("no selected terminal");
      }
      rl.prompt();
      return;
    }
    if (trimmed === ".ctrld") {
      if (selectedTerminalId) {
        sendCommand({
          command: "terminal.input",
          terminalId: selectedTerminalId,
          data: "__CTRL_D__",
        });
      } else {
        console.log("no selected terminal");
      }
      rl.prompt();
      return;
    }
    if (trimmed === ".help") {
      console.log("terminal mode: enter text to send command; empty line sends Enter.");
      console.log("special: .ctrlc  .ctrld  .exit");
      rl.prompt();
      return;
    }
    if (!selectedTerminalId) {
      console.log("no selected terminal");
      rl.prompt();
      return;
    }
    if (line.length === 0) {
      sendCommand({
        command: "terminal.input",
        terminalId: selectedTerminalId,
        data: "__ENTER__",
      });
      rl.prompt();
      return;
    }
    sendCommand({
      command: "terminal.input",
      terminalId: selectedTerminalId,
      data: `${line}${platformLineEnding()}`,
    });
    rl.prompt();
    return;
  }

  if (!trimmed) {
    rl.prompt();
    return;
  }

  const [cmd, ...rest] = trimmed.split(" ");
  const restText = rest.join(" ");
  const colonIndex = line.indexOf(":");
  if (colonIndex > 0) {
    const ref = line.slice(0, colonIndex).trim();
    const message = line.slice(colonIndex + 1);
    const target = resolveTerminal(ref);
    const refLooksLikeTerminalId = /^[0-9a-fA-F-]{8,}$/.test(ref);
    if (target || refLooksLikeTerminalId) {
      const terminalId = target ? target.terminalId : ref;
      selectedTerminalId = terminalId;
      sendTerminalLine(terminalId, message.trimStart());
      updatePrompt();
      rl.prompt();
      return;
    }
  }

  switch (cmd.toLowerCase()) {
    case "help": {
      printHelp();
      break;
    }
    case "state": {
      printState();
      break;
    }
    case "list": {
      printTerminals();
      break;
    }
    case "use": {
      const ref = restText.trim();
      const t = resolveTerminal(ref);
      if (!t) {
        console.log(`terminal not found: ${ref}`);
        break;
      }
      selectedTerminalId = t.terminalId;
      console.log(`selected ${t.title} (${t.terminalId})`);
      updatePrompt();
      break;
    }
    case "terminal":
    case "attach": {
      enterPassthroughMode();
      break;
    }
    case "attach-new": {
      attachNewLineMode();
      break;
    }
    case "attach-raw": {
      enterRawPassthroughMode();
      break;
    }
    case "watch": {
      const mode = restText.trim().toLowerCase();
      if (mode === "all") {
        showAllTerminalOutputs = true;
        console.log("watch mode: all terminal outputs");
        break;
      }
      if (mode === "selected" || mode.length === 0) {
        showAllTerminalOutputs = false;
        const current = currentSelectedTerminal();
        if (current) {
          console.log(`watch mode: selected (${current.title} / ${current.terminalId})`);
        } else {
          console.log("watch mode: selected");
        }
        break;
      }
      console.log("usage: watch selected|all");
      break;
    }
    case "new": {
      sendCommand({
        command: "terminal.create",
        title: restText.trim() || `local-${Date.now()}`,
      });
      break;
    }
    case "close": {
      const ref = restText.trim();
      const t = ref ? resolveTerminal(ref) : terminals.find((x) => x.terminalId === selectedTerminalId);
      if (!t) {
        console.log("no terminal to close");
        break;
      }
      sendCommand({ command: "terminal.close", terminalId: t.terminalId });
      break;
    }
    case "send": {
      if (!selectedTerminalId) {
        console.log("no selected terminal");
        break;
      }
      if (!restText) {
        console.log("usage: send <command text>");
        break;
      }
      sendCommand({
        command: "terminal.input",
        terminalId: selectedTerminalId,
        data: `${restText}${platformLineEnding()}`,
      });
      break;
    }
    case "raw": {
      if (!selectedTerminalId) {
        console.log("no selected terminal");
        break;
      }
      if (!restText) {
        console.log("usage: raw <text>");
        break;
      }
      sendCommand({
        command: "terminal.input",
        terminalId: selectedTerminalId,
        data: restText,
      });
      break;
    }
    case "ctrlc": {
      if (!selectedTerminalId) {
        console.log("no selected terminal");
        break;
      }
      sendCommand({
        command: "terminal.input",
        terminalId: selectedTerminalId,
        data: "__CTRL_C__",
      });
      break;
    }
    case "ctrld": {
      if (!selectedTerminalId) {
        console.log("no selected terminal");
        break;
      }
      sendCommand({
        command: "terminal.input",
        terminalId: selectedTerminalId,
        data: "__CTRL_D__",
      });
      break;
    }
    case "enter": {
      if (!selectedTerminalId) {
        console.log("no selected terminal");
        break;
      }
      sendCommand({
        command: "terminal.input",
        terminalId: selectedTerminalId,
        data: "__ENTER__",
      });
      break;
    }
    case "snapshot": {
      const ref = restText.trim();
      const t = ref ? resolveTerminal(ref) : terminals.find((x) => x.terminalId === selectedTerminalId);
      if (!t) {
        console.log("terminal not found");
        break;
      }
      sendCommand({ command: "terminal.snapshot", terminalId: t.terminalId });
      break;
    }
    case "capture-list": {
      sendCommand({ command: "capture.list" });
      break;
    }
    case "capture": {
      if (!/^\d+$/.test(restText.trim())) {
        console.log("usage: capture <source-index>  (run capture-list first)");
        break;
      }
      const idx = Number.parseInt(restText.trim(), 10) - 1;
      if (idx < 0 || idx >= captureSources.length) {
        console.log(`invalid source-index: ${restText.trim()}`);
        break;
      }
      const src = captureSources[idx];
      sendCommand({
        command: "screen.capture",
        source: src.source,
        sourceId: src.sourceId,
        terminalId: selectedTerminalId,
      });
      break;
    }
    case "tail": {
      const ref = restText.trim();
      const t = ref ? resolveTerminal(ref) : terminals.find((x) => x.terminalId === selectedTerminalId);
      if (!t) {
        console.log("terminal not found");
        break;
      }
      const text = snapshots.get(t.terminalId) || "";
      console.log(text ? text.slice(-2000) : "(no output yet)");
      break;
    }
    case "history": {
      const parts = restText.trim().split(" ").filter(Boolean);
      let ref = "";
      let count = 80;
      if (parts.length >= 1) {
        if (/^\d+$/.test(parts[0])) {
          const maybeCount = Number.parseInt(parts[0], 10);
          const maybeTerminal = resolveTerminal(parts[0]);
          if (maybeTerminal) {
            ref = parts[0];
            if (parts[1] && /^\d+$/.test(parts[1])) {
              count = Number.parseInt(parts[1], 10);
            }
          } else {
            count = maybeCount;
          }
        } else {
          ref = parts[0];
          if (parts[1] && /^\d+$/.test(parts[1])) {
            count = Number.parseInt(parts[1], 10);
          }
        }
      }
      const t = ref ? resolveTerminal(ref) : terminals.find((x) => x.terminalId === selectedTerminalId);
      if (!t) {
        console.log("terminal not found");
        break;
      }
      printHistory(t.terminalId, Math.max(1, Math.min(1000, count)));
      break;
    }
    case "render": {
      const { ref, file } = resolveRenderTargetAndFile(restText);
      const t = ref ? resolveTerminal(ref) : terminals.find((x) => x.terminalId === selectedTerminalId);
      if (!t) {
        console.log("terminal not found");
        break;
      }
      renderTerminalOutput(t.terminalId, t.title, file);
      break;
    }
    case "render-live":
    case "render-replay": {
      const { ref, file } = resolveRenderTargetAndFile(restText);
      const t = ref ? resolveTerminal(ref) : terminals.find((x) => x.terminalId === selectedTerminalId);
      if (!t) {
        console.log("terminal not found");
        break;
      }
      renderTerminalReplayHtml(t.terminalId, t.title, file);
      break;
    }
    case "exit":
    case "quit": {
      intentionalClose = true;
      ws.close();
      break;
    }
    default: {
      console.log(`unknown command: ${cmd}`);
      printHelp();
      break;
    }
  }

  rl.prompt();
});

rl.on("SIGINT", () => {
  if (rawPassthroughMode) {
    leaveRawPassthroughMode();
    rl.prompt();
    return;
  }
  if (passthroughMode) {
    leavePassthroughMode();
    rl.prompt();
    return;
  }
  intentionalClose = true;
  ws.close();
});
