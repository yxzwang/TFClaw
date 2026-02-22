#!/usr/bin/env node
/* eslint-disable no-console */
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
const terminalId = args["terminal-id"] || "";
const title = args.title || terminalId;

if (!terminalId) {
  console.error("missing --terminal-id");
  process.exit(1);
}

const relayUrl = `${relayBase.replace(/\/+$/, "")}/?role=client&token=${encodeURIComponent(token)}`;
const ws = new WebSocket(relayUrl);
let announced = false;
let snapshotRequested = false;
let initialRendered = false;
let lastSnapshotUpdatedAt = "";
const snapshotRequestId = `viewer-snapshot-${Date.now()}-${Math.floor(Math.random() * 100000)}`;

function printHeader() {
  if (announced) {
    return;
  }
  announced = true;
  console.log(`TFClaw viewer connected: ${relayUrl}`);
  console.log(`Watching terminal: ${title} (${terminalId})`);
  console.log("Press Ctrl+C to close this viewer.");
  console.log("----------------------------------------");
}

function printSnapshotText(text, updatedAt, sourceLabel) {
  if (!text || text.length === 0) {
    return;
  }
  const atInfo = updatedAt ? ` at ${updatedAt}` : "";
  console.log(`[viewer] ${sourceLabel}${atInfo}`);
  process.stdout.write(text);
  if (!text.endsWith("\n")) {
    process.stdout.write("\n");
  }
}

ws.on("open", () => {
  ws.send(
    JSON.stringify({
      type: "client.hello",
      payload: { clientType: "viewer" },
    }),
  );
});

ws.on("message", (raw) => {
  let msg;
  try {
    msg = JSON.parse(String(raw));
  } catch {
    return;
  }

  if (msg.type === "relay.state") {
    const terminals = Array.isArray(msg.payload?.terminals) ? msg.payload.terminals : [];
    const target = terminals.find((t) => t.terminalId === terminalId);
    if (!target) {
      console.log(`[viewer] terminal not found: ${terminalId}`);
      return;
    }
    printHeader();
    if (!snapshotRequested) {
      snapshotRequested = true;
      ws.send(
        JSON.stringify({
          type: "client.command",
          requestId: snapshotRequestId,
          payload: {
            command: "terminal.snapshot",
            terminalId,
          },
        }),
      );
    }

    const snapshots = Array.isArray(msg.payload?.snapshots) ? msg.payload.snapshots : [];
    const snap = snapshots.find((s) => s.terminalId === terminalId);
    if (snap && typeof snap.output === "string") {
      const at = String(snap.updatedAt || "");
      if (!initialRendered || at !== lastSnapshotUpdatedAt) {
        lastSnapshotUpdatedAt = at;
        initialRendered = true;
        printSnapshotText(snap.output, at, "initial snapshot");
      }
    }

    if (!target.isActive) {
      console.log("[viewer] terminal is currently closed.");
    }
    return;
  }

  if (msg.type === "agent.terminal_output") {
    if (msg.payload?.terminalId !== terminalId) {
      return;
    }
    printHeader();
    const chunk = String(msg.payload?.chunk || "");
    if (chunk.length > 0) {
      initialRendered = true;
      process.stdout.write(chunk);
    }
    return;
  }

  if (msg.type === "relay.ack") {
    if (msg.payload?.ok === false) {
      const req = msg.payload?.requestId ? ` requestId=${msg.payload.requestId}` : "";
      console.log(`[viewer ack-error]${req} ${msg.payload?.message || ""}`);
    }
    return;
  }

  if (msg.type === "agent.error") {
    const req = msg.payload?.requestId ? ` requestId=${msg.payload.requestId}` : "";
    console.log(`[agent-error] ${msg.payload?.code || "UNKNOWN"}${req}: ${msg.payload?.message || ""}`);
  }
});

ws.on("close", () => {
  console.log("\n[viewer disconnected]");
  process.exit(0);
});

ws.on("error", (err) => {
  console.error("[viewer ws-error]", err.message);
});

process.on("SIGINT", () => {
  ws.close();
});

setTimeout(() => {
  if (!initialRendered) {
    printHeader();
    console.log("[viewer] connected, waiting for terminal output...");
  }
}, 1500);
