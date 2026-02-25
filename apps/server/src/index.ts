import http from "node:http";
import { URL } from "node:url";
import {
  type AgentDescriptor,
  type RelayMessage,
  type RelayState,
  type TerminalSnapshot,
  type TerminalSummary,
  jsonStringify,
  safeJsonParse,
} from "@tfclaw/protocol";
import { WebSocketServer, type RawData, type WebSocket } from "ws";

type Role = "agent" | "client";

interface SocketMeta {
  role: Role;
  token: string;
  ip: string;
}

interface TokenSession {
  agent?: WebSocket;
  agentInfo?: AgentDescriptor;
  clients: Set<WebSocket>;
  terminals: Map<string, TerminalSummary>;
  snapshots: Map<string, TerminalSnapshot>;
}

const RELAY_PORT = Number.parseInt(process.env.RELAY_PORT ?? "8787", 10);
const RELAY_HOST = process.env.RELAY_HOST ?? "0.0.0.0";
const RELAY_WS_PATH = process.env.RELAY_WS_PATH ?? "/";
const MAX_SNAPSHOT_CHARS = Number.parseInt(process.env.MAX_SNAPSHOT_CHARS ?? "12000", 10);
const MAX_MESSAGE_BYTES = Number.parseInt(process.env.RELAY_MAX_MESSAGE_BYTES ?? "262144", 10);
const MAX_CONNECTIONS = Number.parseInt(process.env.RELAY_MAX_CONNECTIONS ?? "500", 10);
const MAX_CONNECTIONS_PER_IP = Number.parseInt(process.env.RELAY_MAX_CONNECTIONS_PER_IP ?? "40", 10);
const MAX_SESSIONS = Number.parseInt(process.env.RELAY_MAX_SESSIONS ?? "500", 10);
const MAX_CLIENTS_PER_SESSION = Number.parseInt(process.env.RELAY_MAX_CLIENTS_PER_SESSION ?? "80", 10);
const MESSAGE_RATE_LIMIT_WINDOW_MS = Number.parseInt(process.env.RELAY_MESSAGE_RATE_WINDOW_MS ?? "10000", 10);
const MAX_MESSAGES_PER_WINDOW = Number.parseInt(process.env.RELAY_MAX_MESSAGES_PER_WINDOW ?? "240", 10);
const UPGRADE_RATE_LIMIT_WINDOW_MS = Number.parseInt(process.env.RELAY_UPGRADE_RATE_WINDOW_MS ?? "10000", 10);
const MAX_UPGRADES_PER_WINDOW_PER_IP = Number.parseInt(process.env.RELAY_MAX_UPGRADES_PER_WINDOW_PER_IP ?? "120", 10);
const HEARTBEAT_INTERVAL_MS = Number.parseInt(process.env.RELAY_HEARTBEAT_INTERVAL_MS ?? "20000", 10);
const IDLE_TIMEOUT_MS = Number.parseInt(process.env.RELAY_IDLE_TIMEOUT_MS ?? "120000", 10);
const TOKEN_MIN_LENGTH = Number.parseInt(process.env.RELAY_TOKEN_MIN_LENGTH ?? "8", 10);
const TOKEN_MAX_LENGTH = Number.parseInt(process.env.RELAY_TOKEN_MAX_LENGTH ?? "128", 10);
const ENFORCE_STRONG_TOKEN = (process.env.RELAY_ENFORCE_STRONG_TOKEN ?? "false").toLowerCase() === "true";
const STRONG_TOKEN_PATTERN = /^[A-Za-z0-9._~\-]{16,128}$/;
const allowedOrigins = new Set(
  (process.env.RELAY_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
);
const allowedTokens = new Set(
  (process.env.RELAY_ALLOWED_TOKENS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean),
);

const sessions = new Map<string, TokenSession>();
const socketMeta = new WeakMap<WebSocket, SocketMeta>();
const socketRateWindow = new WeakMap<WebSocket, { startedAt: number; count: number }>();
const socketLastSeenAt = new WeakMap<WebSocket, number>();
const socketAlive = new WeakMap<WebSocket, boolean>();
const ipActiveConnections = new Map<string, number>();
const ipUpgradeRateWindow = new Map<string, { startedAt: number; count: number }>();

function normalizeIp(raw: string | undefined): string {
  if (!raw) {
    return "unknown";
  }
  if (raw.startsWith("::ffff:")) {
    return raw.slice("::ffff:".length);
  }
  return raw;
}

function maskToken(token: string): string {
  if (token.length <= 8) {
    return "****";
  }
  return `${token.slice(0, 4)}...${token.slice(-2)}`;
}

function updateSocketLastSeen(ws: WebSocket): void {
  socketLastSeenAt.set(ws, Date.now());
  socketAlive.set(ws, true);
}

function bumpIpActiveConnection(ip: string): number {
  const next = (ipActiveConnections.get(ip) ?? 0) + 1;
  ipActiveConnections.set(ip, next);
  return next;
}

function dropIpActiveConnection(ip: string): void {
  const next = (ipActiveConnections.get(ip) ?? 1) - 1;
  if (next <= 0) {
    ipActiveConnections.delete(ip);
    return;
  }
  ipActiveConnections.set(ip, next);
}

function isUpgradeRateLimited(ip: string): boolean {
  const now = Date.now();
  const existing = ipUpgradeRateWindow.get(ip);
  if (!existing || now - existing.startedAt >= UPGRADE_RATE_LIMIT_WINDOW_MS) {
    ipUpgradeRateWindow.set(ip, {
      startedAt: now,
      count: 1,
    });
    return false;
  }

  existing.count += 1;
  return existing.count > MAX_UPGRADES_PER_WINDOW_PER_IP;
}

function isOriginAllowed(originRaw: string | undefined): boolean {
  if (!originRaw || allowedOrigins.size === 0) {
    return true;
  }
  return allowedOrigins.has(originRaw.trim());
}

function isTokenAllowed(token: string): boolean {
  if (token.length < TOKEN_MIN_LENGTH || token.length > TOKEN_MAX_LENGTH) {
    return false;
  }
  if (ENFORCE_STRONG_TOKEN && !STRONG_TOKEN_PATTERN.test(token)) {
    return false;
  }
  if (allowedTokens.size > 0 && !allowedTokens.has(token)) {
    return false;
  }
  return true;
}

function isSocketRateLimited(ws: WebSocket): boolean {
  const now = Date.now();
  const existing = socketRateWindow.get(ws);
  if (!existing || now - existing.startedAt >= MESSAGE_RATE_LIMIT_WINDOW_MS) {
    socketRateWindow.set(ws, { startedAt: now, count: 1 });
    return false;
  }
  existing.count += 1;
  return existing.count > MAX_MESSAGES_PER_WINDOW;
}

function rawDataBytes(raw: RawData): number {
  if (typeof raw === "string") {
    return Buffer.byteLength(raw);
  }
  if (Buffer.isBuffer(raw)) {
    return raw.length;
  }
  if (Array.isArray(raw)) {
    return raw.reduce((sum, chunk) => sum + chunk.length, 0);
  }
  if (raw instanceof ArrayBuffer) {
    return raw.byteLength;
  }
  return 0;
}

function ensureSession(token: string): TokenSession {
  let session = sessions.get(token);
  if (!session) {
    session = {
      clients: new Set<WebSocket>(),
      terminals: new Map<string, TerminalSummary>(),
      snapshots: new Map<string, TerminalSnapshot>(),
    };
    sessions.set(token, session);
  }
  return session;
}

function send(ws: WebSocket, message: RelayMessage): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(jsonStringify(message));
  }
}

function composeState(session: TokenSession): RelayState {
  return {
    type: "relay.state",
    payload: {
      agent: session.agentInfo,
      terminals: Array.from(session.terminals.values()),
      snapshots: Array.from(session.snapshots.values()),
    },
  };
}

function broadcastState(session: TokenSession): void {
  const state = composeState(session);
  for (const client of session.clients) {
    send(client, state);
  }
}

function cleanupSocket(ws: WebSocket): void {
  const meta = socketMeta.get(ws);
  if (!meta) {
    return;
  }
  socketMeta.delete(ws);
  dropIpActiveConnection(meta.ip);

  const session = sessions.get(meta.token);
  if (!session) {
    return;
  }

  if (meta.role === "agent") {
    if (session.agent === ws) {
      session.agent = undefined;
      session.agentInfo = undefined;
    }
  } else {
    session.clients.delete(ws);
  }

  if (!session.agent && session.clients.size === 0) {
    sessions.delete(meta.token);
    return;
  }

  broadcastState(session);
}

function appendSnapshot(session: TokenSession, terminalId: string, chunk: string, at: string): void {
  const existing = session.snapshots.get(terminalId);
  const merged = `${existing?.output ?? ""}${chunk}`;
  const output = merged.length > MAX_SNAPSHOT_CHARS ? merged.slice(-MAX_SNAPSHOT_CHARS) : merged;

  session.snapshots.set(terminalId, {
    terminalId,
    output,
    updatedAt: at,
  });

  const summary = session.terminals.get(terminalId);
  if (summary) {
    summary.updatedAt = at;
    summary.isActive = true;
  }
}

function handleAgentMessage(ws: WebSocket, session: TokenSession, message: RelayMessage): void {
  switch (message.type) {
    case "agent.register": {
      session.agentInfo = message.payload;
      broadcastState(session);
      return;
    }
    case "agent.terminal_list": {
      const next = new Map<string, TerminalSummary>();
      for (const terminal of message.payload.terminals) {
        next.set(terminal.terminalId, terminal);
      }
      session.terminals = next;
      broadcastState(session);
      return;
    }
    case "agent.terminal_output": {
      appendSnapshot(session, message.payload.terminalId, message.payload.chunk, message.payload.at);
      for (const client of session.clients) {
        send(client, message);
      }
      return;
    }
    case "agent.screen_capture":
    case "agent.capture_sources":
    case "agent.command_result":
    case "agent.error": {
      for (const client of session.clients) {
        send(client, message);
      }
      return;
    }
    default: {
      send(ws, {
        type: "relay.ack",
        payload: {
          ok: false,
          message: `Message type not accepted from agent: ${message.type}`,
        },
      });
    }
  }
}

function forwardCommandToAgent(session: TokenSession, ws: WebSocket, message: RelayMessage): void {
  if (message.type !== "client.command") {
    return;
  }

  if (!session.agent || session.agent.readyState !== session.agent.OPEN) {
    send(ws, {
      type: "relay.ack",
      payload: {
        requestId: message.payload.command === "terminal.input" ? undefined : message.requestId,
        ok: false,
        message: "No active terminal agent connected for this token.",
      },
    });
    return;
  }

  send(session.agent, message);
  if (message.payload.command !== "terminal.input") {
    send(ws, {
      type: "relay.ack",
      payload: {
        requestId: message.requestId,
        ok: true,
      },
    });
  }
}

function handleClientMessage(ws: WebSocket, session: TokenSession, message: RelayMessage): void {
  switch (message.type) {
    case "client.hello": {
      send(ws, {
        type: "relay.ack",
        payload: { ok: true, message: `hello ${message.payload.clientType}` },
      });
      send(ws, composeState(session));
      return;
    }
    case "client.command": {
      if (message.payload.command === "terminal.snapshot") {
        const snapshot = session.snapshots.get(message.payload.terminalId);
        send(ws, {
          type: "relay.state",
          payload: {
            agent: session.agentInfo,
            terminals: session.terminals.has(message.payload.terminalId)
              ? [session.terminals.get(message.payload.terminalId)!]
              : [],
            snapshots: snapshot ? [snapshot] : [],
          },
        });
      }
      forwardCommandToAgent(session, ws, message);
      return;
    }
    default: {
      send(ws, {
        type: "relay.ack",
        payload: {
          ok: false,
          message: `Message type not accepted from client: ${message.type}`,
        },
      });
    }
  }
}

function onMessage(ws: WebSocket, raw: RawData): void {
  const meta = socketMeta.get(ws);
  if (!meta) {
    return;
  }

  if (isSocketRateLimited(ws)) {
    send(ws, {
      type: "relay.ack",
      payload: {
        ok: false,
        message: "rate limit exceeded",
      },
    });
    ws.close(1008, "rate limit exceeded");
    return;
  }

  const messageBytes = rawDataBytes(raw);
  if (messageBytes > MAX_MESSAGE_BYTES) {
    ws.close(1009, "message too large");
    return;
  }
  updateSocketLastSeen(ws);

  const session = sessions.get(meta.token);
  if (!session) {
    ws.close(1008, "session not found");
    return;
  }

  const text = raw.toString();
  const message = safeJsonParse(text);
  if (!message) {
    send(ws, {
      type: "relay.ack",
      payload: { ok: false, message: "invalid json message" },
    });
    return;
  }

  if (meta.role === "agent") {
    handleAgentMessage(ws, session, message);
    return;
  }

  handleClientMessage(ws, session, message);
}

const server = http.createServer((req, res) => {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("cache-control", "no-store");

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        service: "tfclaw-relay",
        time: new Date().toISOString(),
        sessions: sessions.size,
        sockets: wss.clients.size,
      }),
    );
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: false, message: "not found" }));
});

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: MAX_MESSAGE_BYTES,
  perMessageDeflate: false,
});

wss.on("connection", (ws, req) => {
  const meta = socketMeta.get(ws);
  if (!meta) {
    ws.close(1008, "missing metadata");
    return;
  }

  const ipCount = bumpIpActiveConnection(meta.ip);
  if (ipCount > MAX_CONNECTIONS_PER_IP || wss.clients.size > MAX_CONNECTIONS) {
    dropIpActiveConnection(meta.ip);
    ws.close(1008, "connection limit exceeded");
    return;
  }

  const session = ensureSession(meta.token);

  if (meta.role === "agent") {
    if (session.agent && session.agent !== ws && session.agent.readyState === session.agent.OPEN) {
      session.agent.close(4000, "Replaced by a newer agent connection");
    }
    session.agent = ws;
  } else {
    if (session.clients.size >= MAX_CLIENTS_PER_SESSION) {
      dropIpActiveConnection(meta.ip);
      ws.close(1008, "too many clients for token");
      return;
    }
    session.clients.add(ws);
    send(ws, composeState(session));
  }

  socketRateWindow.set(ws, {
    startedAt: Date.now(),
    count: 0,
  });
  updateSocketLastSeen(ws);
  ws.on("message", (raw) => onMessage(ws, raw));
  ws.on("pong", () => updateSocketLastSeen(ws));
  ws.on("close", () => cleanupSocket(ws));
  ws.on("error", () => cleanupSocket(ws));

  const peer = req.socket.remoteAddress ?? "unknown";
  console.log(
    `[connected] role=${meta.role} token=${maskToken(meta.token)} peer=${normalizeIp(peer)} clients=${wss.clients.size}`,
  );
});

server.on("upgrade", (req, socket, head) => {
  try {
    const parsed = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const ip = normalizeIp(req.socket.remoteAddress);
    if (isUpgradeRateLimited(ip)) {
      socket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n");
      socket.destroy();
      return;
    }

    if (wss.clients.size >= MAX_CONNECTIONS) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      socket.destroy();
      return;
    }

    if (parsed.pathname !== RELAY_WS_PATH) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    const origin = req.headers.origin?.toString();
    if (!isOriginAllowed(origin)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    const roleRaw = parsed.searchParams.get("role");
    const token = parsed.searchParams.get("token") ?? req.headers["x-auth-token"]?.toString();

    if ((roleRaw !== "agent" && roleRaw !== "client") || !token || !isTokenAllowed(token)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    if (!sessions.has(token) && sessions.size >= MAX_SESSIONS) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      socketMeta.set(ws, {
        role: roleRaw,
        token,
        ip,
      });
      wss.emit("connection", ws, req);
    });
  } catch {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
  }
});

const heartbeatTimer = setInterval(() => {
  const now = Date.now();
  for (const ws of wss.clients) {
    const lastSeen = socketLastSeenAt.get(ws) ?? now;
    if (now - lastSeen > IDLE_TIMEOUT_MS) {
      ws.terminate();
      continue;
    }

    const alive = socketAlive.get(ws) ?? true;
    if (!alive) {
      ws.terminate();
      continue;
    }

    socketAlive.set(ws, false);
    try {
      ws.ping();
    } catch {
      ws.terminate();
    }
  }
}, Math.max(5000, HEARTBEAT_INTERVAL_MS));
heartbeatTimer.unref();

server.listen(RELAY_PORT, RELAY_HOST, () => {
  console.log(`TFClaw relay server listening on ${RELAY_HOST}:${RELAY_PORT}${RELAY_WS_PATH}`);
  console.log(
    `[security] maxConnections=${MAX_CONNECTIONS} maxConnectionsPerIp=${MAX_CONNECTIONS_PER_IP} maxClientsPerSession=${MAX_CLIENTS_PER_SESSION}`,
  );
  console.log(
    `[security] maxPayloadBytes=${MAX_MESSAGE_BYTES} rateLimit=${MAX_MESSAGES_PER_WINDOW}/${MESSAGE_RATE_LIMIT_WINDOW_MS}ms upgradeLimit=${MAX_UPGRADES_PER_WINDOW_PER_IP}/${UPGRADE_RATE_LIMIT_WINDOW_MS}ms`,
  );
  if (allowedOrigins.size > 0) {
    console.log(`[security] allowedOrigins=${Array.from(allowedOrigins).join(",")}`);
  }
  if (allowedTokens.size > 0) {
    console.log(`[security] allowedTokens=${allowedTokens.size}`);
  }
});
