import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import * as Lark from "@larksuiteoapi/node-sdk";
import {
  type CaptureSource,
  type ClientCommand,
  type RelayMessage,
  type ScreenCapture,
  type TerminalSnapshot,
  type TerminalSummary,
  jsonStringify,
  safeJsonParse,
} from "@tfclaw/protocol";
import WebSocket from "ws";

interface RelayCache {
  terminals: Map<string, TerminalSummary>;
  snapshots: Map<string, TerminalSnapshot>;
}

interface PendingCapture {
  resolve: (capture: ScreenCapture) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface PendingCaptureSourceList {
  resolve: (sources: CaptureSource[]) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface ChatCaptureSelection {
  options: CaptureSource[];
  terminalId?: string;
  createdAt: number;
}

const FEISHU_APP_ID = process.env.FEISHU_APP_ID;
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET;
const TFCLAW_TOKEN = process.env.TFCLAW_TOKEN;
const RELAY_URL = process.env.TFCLAW_RELAY_URL ?? "ws://127.0.0.1:8787";
const ALLOW_FROM = (process.env.FEISHU_ALLOW_FROM ?? "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

if (!FEISHU_APP_ID || !FEISHU_APP_SECRET || !TFCLAW_TOKEN) {
  console.error("Missing env. FEISHU_APP_ID, FEISHU_APP_SECRET and TFCLAW_TOKEN are required.");
  process.exit(1);
}

function randomId(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

class RelayBridge {
  private ws: WebSocket | undefined;
  private closed = false;
  private reconnectAttempts = 0;
  private pendingCaptures = new Map<string, PendingCapture>();
  private pendingCaptureSourceLists = new Map<string, PendingCaptureSourceList>();

  readonly cache: RelayCache = {
    terminals: new Map<string, TerminalSummary>(),
    snapshots: new Map<string, TerminalSnapshot>(),
  };

  connect(): void {
    const url = new URL(RELAY_URL);
    url.searchParams.set("role", "client");
    url.searchParams.set("token", TFCLAW_TOKEN!);

    this.ws = new WebSocket(url.toString());

    this.ws.on("open", () => {
      this.reconnectAttempts = 0;
      this.send({
        type: "client.hello",
        payload: {
          clientType: "feishu",
        },
      });
      console.log(`Relay connected: ${url}`);
    });

    this.ws.on("message", (raw) => {
      this.handleRelayMessage(raw.toString());
    });

    this.ws.on("close", () => {
      if (this.closed) {
        return;
      }
      this.rejectAllPending(new Error("relay disconnected"));
      this.reconnectAttempts += 1;
      const retryDelay = Math.min(10000, this.reconnectAttempts * 500);
      console.log(`Relay disconnected. Reconnect in ${retryDelay}ms`);
      setTimeout(() => this.connect(), retryDelay);
    });

    this.ws.on("error", (err) => {
      console.error("Relay error", err.message);
    });
  }

  close(): void {
    this.closed = true;
    this.rejectAllPending(new Error("relay closed"));
    this.ws?.close();
  }

  send(message: RelayMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(jsonStringify(message));
    }
  }

  command(payload: ClientCommand["payload"]): string {
    const requestId = randomId();
    this.send({
      type: "client.command",
      requestId,
      payload,
    });
    return requestId;
  }

  waitForCapture(requestId: string, timeoutMs = 20000): Promise<ScreenCapture> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCaptures.delete(requestId);
        reject(new Error("capture timeout"));
      }, timeoutMs);

      this.pendingCaptures.set(requestId, {
        resolve,
        reject,
        timer,
      });
    });
  }

  waitForCaptureSources(requestId: string, timeoutMs = 15000): Promise<CaptureSource[]> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCaptureSourceLists.delete(requestId);
        reject(new Error("capture source list timeout"));
      }, timeoutMs);

      this.pendingCaptureSourceLists.set(requestId, {
        resolve,
        reject,
        timer,
      });
    });
  }

  private handleRelayMessage(raw: string): void {
    const parsed = safeJsonParse(raw);
    if (!parsed) {
      return;
    }

    if (parsed.type === "relay.state") {
      this.cache.terminals.clear();
      for (const terminal of parsed.payload.terminals) {
        this.cache.terminals.set(terminal.terminalId, terminal);
      }

      for (const snapshot of parsed.payload.snapshots) {
        this.cache.snapshots.set(snapshot.terminalId, snapshot);
      }
      return;
    }

    if (parsed.type === "agent.terminal_output") {
      const existing = this.cache.snapshots.get(parsed.payload.terminalId);
      const merged = `${existing?.output ?? ""}${parsed.payload.chunk}`;
      this.cache.snapshots.set(parsed.payload.terminalId, {
        terminalId: parsed.payload.terminalId,
        output: merged.length > 12000 ? merged.slice(-12000) : merged,
        updatedAt: parsed.payload.at,
      });
      return;
    }

    if (parsed.type === "agent.capture_sources") {
      if (parsed.payload.requestId) {
        const pending = this.pendingCaptureSourceLists.get(parsed.payload.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingCaptureSourceLists.delete(parsed.payload.requestId);
          pending.resolve(parsed.payload.sources);
        }
      }
      return;
    }

    if (parsed.type === "agent.screen_capture") {
      if (parsed.payload.requestId) {
        const pending = this.pendingCaptures.get(parsed.payload.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingCaptures.delete(parsed.payload.requestId);
          pending.resolve(parsed.payload);
        }
      }
      return;
    }

    if (parsed.type === "agent.error" && parsed.payload.requestId) {
      const pendingCapture = this.pendingCaptures.get(parsed.payload.requestId);
      if (pendingCapture) {
        clearTimeout(pendingCapture.timer);
        this.pendingCaptures.delete(parsed.payload.requestId);
        pendingCapture.reject(new Error(`${parsed.payload.code}: ${parsed.payload.message}`));
        return;
      }

      const pendingSources = this.pendingCaptureSourceLists.get(parsed.payload.requestId);
      if (pendingSources) {
        clearTimeout(pendingSources.timer);
        this.pendingCaptureSourceLists.delete(parsed.payload.requestId);
        pendingSources.reject(new Error(`${parsed.payload.code}: ${parsed.payload.message}`));
      }
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [requestId, pending] of this.pendingCaptures.entries()) {
      clearTimeout(pending.timer);
      this.pendingCaptures.delete(requestId);
      pending.reject(error);
    }

    for (const [requestId, pending] of this.pendingCaptureSourceLists.entries()) {
      clearTimeout(pending.timer);
      this.pendingCaptureSourceLists.delete(requestId);
      pending.reject(error);
    }
  }
}

const relay = new RelayBridge();
relay.connect();

const larkClient = new Lark.Client({
  appId: FEISHU_APP_ID,
  appSecret: FEISHU_APP_SECRET,
});

const chatTerminalSelection = new Map<string, string>();
const chatCaptureSelections = new Map<string, ChatCaptureSelection>();

function resolveTerminal(input: string): TerminalSummary | undefined {
  const normalized = input.trim();
  if (!normalized) {
    return undefined;
  }

  if (relay.cache.terminals.has(normalized)) {
    return relay.cache.terminals.get(normalized);
  }

  for (const terminal of relay.cache.terminals.values()) {
    if (terminal.title === normalized) {
      return terminal;
    }
  }

  const numeric = Number.parseInt(normalized, 10);
  if (Number.isInteger(numeric) && numeric > 0) {
    const list = Array.from(relay.cache.terminals.values());
    return list[numeric - 1];
  }

  return undefined;
}

function tailOutput(terminalId: string, maxLen = 1200): string {
  const snapshot = relay.cache.snapshots.get(terminalId);
  if (!snapshot?.output) {
    return "(no output yet)";
  }
  return snapshot.output.length > maxLen ? snapshot.output.slice(-maxLen) : snapshot.output;
}

async function replyText(chatId: string, text: string): Promise<void> {
  await larkClient.im.v1.message.create({
    params: {
      receive_id_type: "chat_id",
    },
    data: {
      receive_id: chatId,
      msg_type: "text",
      content: JSON.stringify({ text }),
    },
  });
}

async function replyImage(chatId: string, imageBase64: string): Promise<void> {
  const imageBuffer = Buffer.from(imageBase64, "base64");
  if (imageBuffer.byteLength === 0) {
    throw new Error("empty image");
  }

  if (imageBuffer.byteLength > 10 * 1024 * 1024) {
    throw new Error("image too large (>10MB)");
  }

  const uploadResult = await larkClient.im.v1.image.create({
    data: {
      image_type: "message",
      image: imageBuffer,
    },
  });

  const imageKey = uploadResult?.image_key;
  if (!imageKey) {
    throw new Error("failed to upload image");
  }

  await larkClient.im.v1.message.create({
    params: {
      receive_id_type: "chat_id",
    },
    data: {
      receive_id: chatId,
      msg_type: "image",
      content: JSON.stringify({ image_key: imageKey }),
    },
  });
}

function helpText(): string {
  return [
    "TFClaw Commands:",
    "1) /list - list terminals",
    "2) /new - create terminal",
    "3) /use <id|title|index> - select terminal",
    "4) /close <id|title|index> - close terminal",
    "5) /capture - list screens/windows and choose by number",
    "6) reply number after /capture - capture selected source",
    "7) <terminal-id>: <command> - run command in specified terminal",
    "8) <command> - run in selected terminal",
    "9) /ctrlc or /ctrld - send control key to selected terminal",
  ].join("\n");
}

function formatCaptureOptions(sources: CaptureSource[]): string {
  const lines = sources.map((source, idx) => `${idx + 1}. [${source.source}] ${source.label}`);
  return ["Select capture source and reply with number:", ...lines].join("\n");
}

async function handleCaptureSelection(chatId: string, line: string): Promise<boolean> {
  const selection = chatCaptureSelections.get(chatId);
  if (!selection) {
    return false;
  }

  const age = Date.now() - selection.createdAt;
  if (age > 2 * 60 * 1000) {
    chatCaptureSelections.delete(chatId);
    await replyText(chatId, "capture selection expired. send /capture again.");
    return true;
  }

  if (!/^\d+$/.test(line)) {
    return false;
  }

  const index = Number.parseInt(line, 10) - 1;
  if (index < 0 || index >= selection.options.length) {
    await replyText(chatId, `invalid number: ${line}. choose 1-${selection.options.length}.`);
    return true;
  }

  const chosen = selection.options[index];
  chatCaptureSelections.delete(chatId);

  const requestId = relay.command({
    command: "screen.capture",
    source: chosen.source,
    sourceId: chosen.sourceId,
    terminalId: selection.terminalId,
  });

  await replyText(chatId, `capturing [${chosen.source}] ${chosen.label} ...`);

  try {
    const capture = await relay.waitForCapture(requestId, 20000);
    await replyImage(chatId, capture.imageBase64);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await replyText(chatId, `capture failed: ${msg}`);
  }

  return true;
}

async function handleCaptureList(chatId: string): Promise<void> {
  const requestId = relay.command({
    command: "capture.list",
  });

  let sources: CaptureSource[];
  try {
    sources = await relay.waitForCaptureSources(requestId, 15000);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await replyText(chatId, `failed to list capture sources: ${msg}`);
    return;
  }

  if (sources.length === 0) {
    await replyText(chatId, "no capture sources found.");
    return;
  }

  chatCaptureSelections.set(chatId, {
    options: sources,
    terminalId: chatTerminalSelection.get(chatId),
    createdAt: Date.now(),
  });

  await replyText(chatId, formatCaptureOptions(sources));
}

async function handleTextMessage(chatId: string, senderOpenId: string | undefined, text: string): Promise<void> {
  if (ALLOW_FROM.length > 0 && (!senderOpenId || !ALLOW_FROM.includes(senderOpenId))) {
    await replyText(chatId, "not allowed");
    return;
  }

  const line = text.trim();
  if (!line) {
    return;
  }

  const consumedByCaptureSelection = await handleCaptureSelection(chatId, line);
  if (consumedByCaptureSelection) {
    return;
  }

  if (line === "/help") {
    await replyText(chatId, helpText());
    return;
  }

  if (line === "/list") {
    const terminals = Array.from(relay.cache.terminals.values());
    if (terminals.length === 0) {
      await replyText(chatId, "no terminals");
      return;
    }
    const selected = chatTerminalSelection.get(chatId);
    const content = terminals
      .map((t, idx) => {
        const flag = selected === t.terminalId ? " *selected" : "";
        return `${idx + 1}. ${t.title} [${t.terminalId}] ${t.isActive ? "active" : "closed"}${flag}`;
      })
      .join("\n");
    await replyText(chatId, content);
    return;
  }

  if (line === "/new") {
    relay.command({
      command: "terminal.create",
      title: `feishu-${Date.now()}`,
    });
    await delay(500);
    await replyText(chatId, "terminal.create sent");
    return;
  }

  if (line === "/capture") {
    await handleCaptureList(chatId);
    return;
  }

  if (line === "/ctrlc" || line === "/ctrld") {
    const selected = chatTerminalSelection.get(chatId);
    if (!selected) {
      await replyText(chatId, "no selected terminal. use /list then /use <id>");
      return;
    }
    relay.command({
      command: "terminal.input",
      terminalId: selected,
      data: line === "/ctrlc" ? "__CTRL_C__" : "__CTRL_D__",
    });
    await replyText(chatId, `${line} sent`);
    return;
  }

  if (line.startsWith("/use ")) {
    const key = line.slice(5).trim();
    const terminal = resolveTerminal(key);
    if (!terminal) {
      await replyText(chatId, `terminal not found: ${key}`);
      return;
    }
    chatTerminalSelection.set(chatId, terminal.terminalId);
    await replyText(chatId, `selected: ${terminal.title} (${terminal.terminalId})`);
    return;
  }

  if (line.startsWith("/close ")) {
    const key = line.slice(7).trim();
    const terminal = resolveTerminal(key);
    if (!terminal) {
      await replyText(chatId, `terminal not found: ${key}`);
      return;
    }
    relay.command({
      command: "terminal.close",
      terminalId: terminal.terminalId,
    });
    await replyText(chatId, `close requested: ${terminal.title}`);
    return;
  }

  const colonIndex = line.indexOf(":");
  if (colonIndex > 0) {
    const terminalKey = line.slice(0, colonIndex).trim();
    const command = line.slice(colonIndex + 1).trim();
    const terminal = resolveTerminal(terminalKey);

    if (!terminal) {
      await replyText(chatId, `terminal not found: ${terminalKey}`);
      return;
    }

    chatTerminalSelection.set(chatId, terminal.terminalId);
    relay.command({
      command: "terminal.input",
      terminalId: terminal.terminalId,
      data: `${command}\n`,
    });
    await delay(700);
    await replyText(chatId, `# ${terminal.title}\n${tailOutput(terminal.terminalId)}`);
    return;
  }

  const selected = chatTerminalSelection.get(chatId);
  if (!selected) {
    await replyText(chatId, "no selected terminal. use /list then /use <id>");
    return;
  }

  relay.command({
    command: "terminal.input",
    terminalId: selected,
    data: `${line}\n`,
  });
  await delay(700);
  await replyText(chatId, `# output\n${tailOutput(selected)}`);
}

const wsClient = new Lark.WSClient({
  appId: FEISHU_APP_ID,
  appSecret: FEISHU_APP_SECRET,
  loggerLevel: Lark.LoggerLevel.info,
});

wsClient.start({
  eventDispatcher: new Lark.EventDispatcher({}).register({
    "im.message.receive_v1": async (data: any) => {
      const messageType = data?.message?.message_type;
      if (messageType !== "text") {
        return;
      }

      const chatId = data?.message?.chat_id as string | undefined;
      if (!chatId) {
        return;
      }

      try {
        const rawContent = data?.message?.content as string | undefined;
        const contentObj = rawContent ? JSON.parse(rawContent) : {};
        const text = String(contentObj.text ?? "");

        const senderOpenId = data?.sender?.sender_id?.open_id as string | undefined;
        await handleTextMessage(chatId, senderOpenId, text);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        await replyText(chatId, `failed to process message: ${msg}`);
      }
    },
  }),
});

process.on("SIGINT", () => {
  relay.close();
  process.exit(0);
});

process.on("SIGTERM", () => {
  relay.close();
  process.exit(0);
});

console.log("Feishu gateway started");
