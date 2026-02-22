#!/usr/bin/env node
/* eslint-disable no-console */
const path = require("node:path");
const { spawn } = require("node:child_process");
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

function psQuote(text) {
  return `'${String(text).replace(/'/g, "''")}'`;
}

const args = parseArgs(process.argv);
const relayBase = args.relay || process.env.TFCLAW_RELAY_URL || "ws://127.0.0.1:8787";
const token = args.token || process.env.TFCLAW_TOKEN || "demo-token";
const includeClosed = String(args.all || "").toLowerCase() === "true" || String(args.all || "") === "1";
const terminalFilter = String(args.terminals || "")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);

if (process.platform !== "win32") {
  console.error("open-terminal-viewers currently supports Windows only.");
  process.exit(1);
}

const relayUrl = `${relayBase.replace(/\/+$/, "")}/?role=client&token=${encodeURIComponent(token)}`;
const ws = new WebSocket(relayUrl);
let finished = false;
let exitCode = 0;

function finish(code = 0) {
  if (finished) {
    return;
  }
  finished = true;
  exitCode = code;
  process.exitCode = code;
  try {
    ws.close();
  } catch {
    // no-op
  }
  setTimeout(() => {
    process.exit(exitCode);
  }, 80);
}

function matchesFilter(terminal) {
  if (terminalFilter.length === 0) {
    return true;
  }
  const idxRef = String(terminal.index + 1);
  return terminalFilter.includes(idxRef) || terminalFilter.includes(terminal.terminalId) || terminalFilter.includes(terminal.title);
}

function openViewerWindow(terminal) {
  const viewerScript = path.resolve(__dirname, "terminal-viewer.js");
  const workdir = process.cwd();
  const viewerCommand =
    `Set-Location ${psQuote(workdir)}; ` +
    `node ${psQuote(viewerScript)} ` +
    `--relay ${psQuote(relayBase)} ` +
    `--token ${psQuote(token)} ` +
    `--terminal-id ${psQuote(terminal.terminalId)} ` +
    `--title ${psQuote(terminal.title || terminal.terminalId)}`;
  const launchCommand =
    `Start-Process -FilePath 'powershell.exe' ` +
    `-WorkingDirectory ${psQuote(workdir)} ` +
    `-WindowStyle Normal ` +
    `-ArgumentList @('-NoLogo','-NoExit','-Command',${psQuote(viewerCommand)})`;

  const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", launchCommand], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

ws.on("open", () => {
  ws.send(
    JSON.stringify({
      type: "client.hello",
      payload: { clientType: "viewer-launcher" },
    }),
  );
});

ws.on("message", (raw) => {
  if (finished) {
    return;
  }
  let msg;
  try {
    msg = JSON.parse(String(raw));
  } catch {
    return;
  }

  if (msg.type !== "relay.state") {
    return;
  }

  const terminals = Array.isArray(msg.payload?.terminals) ? msg.payload.terminals : [];
  const prepared = terminals.map((t, idx) => ({ ...t, index: idx }));
  const selected = prepared.filter((t) => (includeClosed ? true : t.isActive)).filter(matchesFilter);

  if (selected.length === 0) {
    console.log("No terminals matched. Use --all=true to include closed ones.");
    finish(0);
    return;
  }

  for (const t of selected) {
    openViewerWindow(t);
    console.log(`opened viewer: ${t.title} (${t.terminalId})`);
  }
  console.log("viewer launcher finished (windows should stay open).");
  finish(0);
});

ws.on("error", (err) => {
  console.error("[viewer-launcher ws-error]", err.message);
  finish(1);
});

setTimeout(() => {
  console.error("Timed out waiting relay.state.");
  finish(1);
}, 8000);
