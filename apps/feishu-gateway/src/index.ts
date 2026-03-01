import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

type ChannelName = "whatsapp" | "telegram" | "discord" | "feishu" | "mochat" | "dingtalk" | "email" | "slack" | "qq";

interface BaseChannelConfig {
  enabled: boolean;
  allowFrom: string[];
}

interface WhatsAppChannelConfig extends BaseChannelConfig {
  bridgeUrl: string;
  bridgeToken: string;
}

interface TelegramChannelConfig extends BaseChannelConfig {
  token: string;
  proxy: string;
  replyToMessage: boolean;
}

interface DiscordChannelConfig extends BaseChannelConfig {
  token: string;
  gatewayUrl: string;
  intents: number;
}

interface FeishuChannelConfig extends BaseChannelConfig {
  appId: string;
  appSecret: string;
  encryptKey: string;
  verificationToken: string;
  disableProxy: boolean;
  noProxyHosts: string[];
}

interface MochatChannelConfig extends BaseChannelConfig {
  baseUrl: string;
  clawToken: string;
}

interface DingTalkChannelConfig extends BaseChannelConfig {
  clientId: string;
  clientSecret: string;
}

interface EmailChannelConfig extends BaseChannelConfig {
  imapHost: string;
  imapUsername: string;
  imapPassword: string;
  smtpHost: string;
  smtpUsername: string;
  smtpPassword: string;
}

interface SlackChannelConfig extends BaseChannelConfig {
  botToken: string;
  appToken: string;
  groupPolicy: string;
}

interface QQChannelConfig extends BaseChannelConfig {
  appId: string;
  secret: string;
}

interface ChannelsConfig {
  whatsapp: WhatsAppChannelConfig;
  telegram: TelegramChannelConfig;
  discord: DiscordChannelConfig;
  feishu: FeishuChannelConfig;
  mochat: MochatChannelConfig;
  dingtalk: DingTalkChannelConfig;
  email: EmailChannelConfig;
  slack: SlackChannelConfig;
  qq: QQChannelConfig;
}

interface RelayConfig {
  token: string;
  url: string;
}

interface GatewayConfig {
  relay: RelayConfig;
  channels: ChannelsConfig;
}

interface LoadedGatewayConfig {
  configPath: string;
  fromFile: boolean;
  config: GatewayConfig;
}

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

interface PendingCommandResult {
  resolve: (output: string) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  onProgress?: (output: string, source?: string) => void | Promise<void>;
}

interface EarlyCommandProgress {
  output: string;
  progressSource?: string;
  at: number;
}

interface ChatCaptureSelection {
  options: CaptureSource[];
  terminalId?: string;
  createdAt: number;
}

type ChatInteractionMode = "tfclaw" | "terminal";

interface RenderedTerminalOutput {
  text: string;
  dynamicFrames: string[];
}

interface MessageResponder {
  replyText(chatId: string, text: string): Promise<void>;
  replyImage(chatId: string, imageBase64: string): Promise<void>;
  replyTextWithMeta?(chatId: string, text: string): Promise<{ messageId?: string }>;
  deleteMessage?(messageId: string): Promise<void>;
}

interface InboundTextContext {
  channel: ChannelName;
  chatId: string;
  senderId?: string;
  text: string;
  allowFrom: string[];
  responder: MessageResponder;
}

interface TerminalProgressSession {
  selectionKey: string;
  chatId: string;
  terminalId: string;
  responder: MessageResponder;
  timer: NodeJS.Timeout;
  lastSnapshot: string;
  lastChangedAt: number;
  startedAt: number;
  busy: boolean;
  lastProgressMessageId?: string;
}

interface CommandProgressSession {
  requestId: string;
  selectionKey: string;
  chatId: string;
  responder: MessageResponder;
  queue: Promise<void>;
  lastProgressMessageId?: string;
  lastProgressBody?: string;
  streamMode?: "auto" | "on" | "off";
  streamOffIntroSent?: boolean;
}

interface ChatApp {
  readonly name: ChannelName;
  readonly enabled: boolean;
  connect(): Promise<void>;
  close(): Promise<void>;
}

function randomId(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

const REALTIME_FOREGROUND_COMMANDS = new Set([
  "node",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "bun",
  "deno",
  "tsx",
  "ts-node",
]);

function toObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function toString(value: unknown, fallback = ""): string {
  if (typeof value === "string") {
    return value;
  }
  return fallback;
}

function toNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

const COMMAND_RESULT_TIMEOUT_MS = Math.max(
  1000,
  Math.min(24 * 60 * 60 * 1000, toNumber(process.env.TFCLAW_COMMAND_RESULT_TIMEOUT_MS, 24 * 60 * 60 * 1000)),
);
const FEISHU_ACK_REACTION = toString(process.env.TFCLAW_FEISHU_ACK_REACTION, "OnIt").trim() || "OnIt";
const FEISHU_ACK_REACTION_ENABLED = toBoolean(process.env.TFCLAW_FEISHU_ACK_REACTION_ENABLED, true);

function toBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
      return true;
    }
    if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
      return false;
    }
  }
  return fallback;
}

function parseCsv(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function toStringArray(value: unknown, fallback: string[] = []): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item).trim())
      .filter(Boolean);
  }
  if (typeof value === "string") {
    return parseCsv(value);
  }
  return fallback;
}

function mergeNoProxyHosts(hosts: string[]): void {
  const existing = `${process.env.NO_PROXY ?? process.env.no_proxy ?? ""}`
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const merged = Array.from(new Set([...existing, ...hosts.map((item) => item.trim()).filter(Boolean)]));
  const value = merged.join(",");
  process.env.NO_PROXY = value;
  process.env.no_proxy = value;
}

function isAnsiCsiFinal(ch: string | undefined): boolean {
  if (!ch) {
    return false;
  }
  const code = ch.charCodeAt(0);
  return code >= 0x40 && code <= 0x7e;
}

const ANSI_CSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_OSC_RE = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;
const ANSI_C1_CSI_RE = /\u009b[0-?]*[ -/]*[@-~]/g;
const ANSI_SGR_FRAGMENT_RE = /\[(?:\d{1,3};?){1,12}[A-Za-z]/g;
const ANSI_FRAGMENT_RE = /\[(?:\?|:|;|\d){1,20}[ -/]*[@-~]/g;

function trimRenderedLine(line: string): string {
  return line
    .replace(ANSI_CSI_RE, "")
    .replace(ANSI_OSC_RE, "")
    .replace(ANSI_C1_CSI_RE, "")
    .replace(ANSI_SGR_FRAGMENT_RE, "")
    .replace(ANSI_FRAGMENT_RE, "")
    .replace(/\u0000/g, "")
    .replace(/[\u0001-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
    .trimEnd();
}

function describeSdkError(error: unknown): string {
  const base = error instanceof Error ? error.message : String(error);
  const errorObj = toObject(error);
  const response = toObject((errorObj.response as unknown) ?? {});
  const status = toNumber(response.status, 0);
  const dataRaw = response.data;
  const dataObj = toObject(dataRaw);

  const code = toString(dataObj.code) || toString(errorObj.code);
  const msg = toString(dataObj.msg) || toString(errorObj.msg);

  const parts: string[] = [base];
  if (status > 0) {
    parts.push(`http=${status}`);
  }
  if (code) {
    parts.push(`code=${code}`);
  }
  if (msg) {
    parts.push(`msg=${msg}`);
  }

  if (!msg || !code) {
    try {
      const raw = typeof dataRaw === "string" ? dataRaw : JSON.stringify(dataRaw);
      if (raw) {
        parts.push(`data=${raw.slice(0, 400)}`);
      }
    } catch {
      // ignore stringify failures
    }
  }

  return parts.join(" | ");
}

function renderTerminalStream(raw: string): RenderedTerminalOutput {
  const source = raw.replace(/\n\[tmux redraw\]\n/g, "\n");

  const outLines: string[] = [];
  const dynamicFrames: string[] = [];
  let line: string[] = [];
  let cursor = 0;
  let i = 0;

  const pushDynamicFrame = () => {
    const frame = trimRenderedLine(line.join(""));
    if (!frame) {
      return;
    }
    if (dynamicFrames.length > 0 && dynamicFrames[dynamicFrames.length - 1] === frame) {
      return;
    }
    dynamicFrames.push(frame);
  };

  const commitLine = () => {
    const value = trimRenderedLine(line.join(""));
    if (value) {
      outLines.push(value);
    }
    line = [];
    cursor = 0;
  };

  const clearToEndOfLine = () => {
    line.length = cursor;
  };

  while (i < source.length) {
    const ch = source[i];

    if (ch === "\x1b") {
      const next = source[i + 1];
      if (next === "[") {
        let j = i + 2;
        while (j < source.length && !isAnsiCsiFinal(source[j])) {
          j += 1;
        }
        const cmd = source[j];
        if (cmd === "K") {
          clearToEndOfLine();
        }
        i = j < source.length ? j + 1 : source.length;
        continue;
      }

      if (next === "]") {
        let j = i + 2;
        while (j < source.length) {
          if (source[j] === "\x07") {
            j += 1;
            break;
          }
          if (source[j] === "\x1b" && source[j + 1] === "\\") {
            j += 2;
            break;
          }
          j += 1;
        }
        i = j;
        continue;
      }

      i += 1;
      continue;
    }

    if (ch === "\r") {
      pushDynamicFrame();
      cursor = 0;
      i += 1;
      continue;
    }

    if (ch === "\n") {
      commitLine();
      i += 1;
      continue;
    }

    if (ch === "\b") {
      if (cursor > 0) {
        cursor -= 1;
        if (cursor < line.length) {
          line.splice(cursor, 1);
        }
      }
      i += 1;
      continue;
    }

    const code = ch.charCodeAt(0);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      i += 1;
      continue;
    }

    if (cursor === line.length) {
      line.push(ch);
    } else {
      line[cursor] = ch;
    }
    cursor += 1;
    i += 1;
  }

  commitLine();

  const text = outLines.join("\n").trim();
  const frames = dynamicFrames.map((item) => trimRenderedLine(item)).filter(Boolean);
  return {
    text,
    dynamicFrames: frames,
  };
}

function loadGatewayConfig(): LoadedGatewayConfig {
  const configPath = path.resolve(process.env.TFCLAW_CONFIG_PATH ?? "config.json");
  let fromFile = false;
  let rawConfig: Record<string, unknown> = {};

  if (fs.existsSync(configPath)) {
    try {
      const rawText = fs.readFileSync(configPath, "utf8");
      rawConfig = toObject(JSON.parse(rawText));
      fromFile = true;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`failed to parse config file (${configPath}): ${msg}`);
    }
  } else {
    console.warn(`[gateway] config file not found: ${configPath}`);
    console.warn("[gateway] fallback to environment variables for compatibility.");
  }

  const rawRelay = toObject(rawConfig.relay);
  const rawChannels = toObject(rawConfig.channels);

  const rawFeishu = toObject(rawChannels.feishu);
  const feishuAppId = toString(rawFeishu.appId, process.env.FEISHU_APP_ID ?? "");
  const feishuAppSecret = toString(rawFeishu.appSecret, process.env.FEISHU_APP_SECRET ?? "");
  const feishuEnabledFallback = feishuAppId.length > 0 && feishuAppSecret.length > 0;
  const hasFeishuEnabled = Object.prototype.hasOwnProperty.call(rawFeishu, "enabled");
  const feishuEnabled = hasFeishuEnabled ? toBoolean(rawFeishu.enabled, feishuEnabledFallback) : feishuEnabledFallback;
  const feishuAllowFromFallback = parseCsv(process.env.FEISHU_ALLOW_FROM);

  const rawTelegram = toObject(rawChannels.telegram);
  const rawWhatsApp = toObject(rawChannels.whatsapp);
  const rawDiscord = toObject(rawChannels.discord);
  const rawMochat = toObject(rawChannels.mochat);
  const rawDingTalk = toObject(rawChannels.dingtalk);
  const rawEmail = toObject(rawChannels.email);
  const rawSlack = toObject(rawChannels.slack);
  const rawQq = toObject(rawChannels.qq);

  const relayToken = toString(rawRelay.token, process.env.TFCLAW_TOKEN ?? "");
  if (!relayToken) {
    throw new Error("missing relay token. set relay.token in config.json or TFCLAW_TOKEN in env.");
  }

  const config: GatewayConfig = {
    relay: {
      token: relayToken,
      url: toString(rawRelay.url, process.env.TFCLAW_RELAY_URL ?? "ws://127.0.0.1:8787"),
    },
    channels: {
      whatsapp: {
        enabled: toBoolean(rawWhatsApp.enabled, false),
        allowFrom: toStringArray(rawWhatsApp.allowFrom),
        bridgeUrl: toString(rawWhatsApp.bridgeUrl, "ws://localhost:3001"),
        bridgeToken: toString(rawWhatsApp.bridgeToken, ""),
      },
      telegram: {
        enabled: toBoolean(rawTelegram.enabled, false),
        allowFrom: toStringArray(rawTelegram.allowFrom),
        token: toString(rawTelegram.token, ""),
        proxy: toString(rawTelegram.proxy, ""),
        replyToMessage: toBoolean(rawTelegram.replyToMessage, false),
      },
      discord: {
        enabled: toBoolean(rawDiscord.enabled, false),
        allowFrom: toStringArray(rawDiscord.allowFrom),
        token: toString(rawDiscord.token, ""),
        gatewayUrl: toString(rawDiscord.gatewayUrl, "wss://gateway.discord.gg/?v=10&encoding=json"),
        intents: toNumber(rawDiscord.intents, 37377),
      },
      feishu: {
        enabled: feishuEnabled,
        allowFrom: toStringArray(rawFeishu.allowFrom, feishuAllowFromFallback),
        appId: feishuAppId,
        appSecret: feishuAppSecret,
        encryptKey: toString(rawFeishu.encryptKey, ""),
        verificationToken: toString(rawFeishu.verificationToken, ""),
        disableProxy: toBoolean(rawFeishu.disableProxy, toBoolean(process.env.TFCLAW_FEISHU_DISABLE_PROXY, true)),
        noProxyHosts: toStringArray(rawFeishu.noProxyHosts, [
          "open.feishu.cn",
          ".feishu.cn",
          "open.larksuite.com",
          ".larksuite.com",
        ]),
      },
      mochat: {
        enabled: toBoolean(rawMochat.enabled, false),
        allowFrom: toStringArray(rawMochat.allowFrom),
        baseUrl: toString(rawMochat.baseUrl, "https://mochat.io"),
        clawToken: toString(rawMochat.clawToken, ""),
      },
      dingtalk: {
        enabled: toBoolean(rawDingTalk.enabled, false),
        allowFrom: toStringArray(rawDingTalk.allowFrom),
        clientId: toString(rawDingTalk.clientId, ""),
        clientSecret: toString(rawDingTalk.clientSecret, ""),
      },
      email: {
        enabled: toBoolean(rawEmail.enabled, false),
        allowFrom: toStringArray(rawEmail.allowFrom),
        imapHost: toString(rawEmail.imapHost, ""),
        imapUsername: toString(rawEmail.imapUsername, ""),
        imapPassword: toString(rawEmail.imapPassword, ""),
        smtpHost: toString(rawEmail.smtpHost, ""),
        smtpUsername: toString(rawEmail.smtpUsername, ""),
        smtpPassword: toString(rawEmail.smtpPassword, ""),
      },
      slack: {
        enabled: toBoolean(rawSlack.enabled, false),
        allowFrom: toStringArray(rawSlack.allowFrom),
        botToken: toString(rawSlack.botToken, ""),
        appToken: toString(rawSlack.appToken, ""),
        groupPolicy: toString(rawSlack.groupPolicy, "mention"),
      },
      qq: {
        enabled: toBoolean(rawQq.enabled, false),
        allowFrom: toStringArray(rawQq.allowFrom),
        appId: toString(rawQq.appId, ""),
        secret: toString(rawQq.secret, ""),
      },
    },
  };

  return {
    config,
    configPath,
    fromFile,
  };
}

// SECTION: relay bridge
class RelayBridge {
  private ws: WebSocket | undefined;
  private closed = false;
  private reconnectAttempts = 0;
  private pendingCaptures = new Map<string, PendingCapture>();
  private pendingCaptureSourceLists = new Map<string, PendingCaptureSourceList>();
  private pendingCommandResults = new Map<string, PendingCommandResult>();
  private earlyCommandOutcomes = new Map<string, { ok: boolean; value: string; at: number }>();
  private earlyCommandProgress = new Map<string, EarlyCommandProgress[]>();
  private readonly earlyCommandOutcomeTtlMs = 60_000;

  readonly cache: RelayCache = {
    terminals: new Map<string, TerminalSummary>(),
    snapshots: new Map<string, TerminalSnapshot>(),
  };

  constructor(
    private readonly relayUrl: string,
    private readonly relayToken: string,
    private readonly clientType: "mobile" | "feishu" | "web" = "web",
  ) {}

  connect(): void {
    const url = new URL(this.relayUrl);
    url.searchParams.set("role", "client");
    url.searchParams.set("token", this.relayToken);

    this.ws = new WebSocket(url.toString());

    this.ws.on("open", () => {
      this.reconnectAttempts = 0;
      this.send({
        type: "client.hello",
        payload: {
          clientType: this.clientType,
        },
      });
      console.log(`[gateway] relay connected: ${url}`);
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
      console.warn(`[gateway] relay disconnected. reconnect in ${retryDelay}ms`);
      setTimeout(() => this.connect(), retryDelay);
    });

    this.ws.on("error", (err) => {
      console.error("[gateway] relay error:", err.message);
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

  waitForCommandResult(
    requestId: string,
    timeoutMs = COMMAND_RESULT_TIMEOUT_MS,
    onProgress?: (output: string, source?: string) => void | Promise<void>,
  ): Promise<string> {
    this.pruneEarlyCommandOutcomes();
    this.pruneEarlyCommandProgress();
    const early = this.earlyCommandOutcomes.get(requestId);
    if (early) {
      this.earlyCommandOutcomes.delete(requestId);
      this.earlyCommandProgress.delete(requestId);
      if (early.ok) {
        return Promise.resolve(early.value);
      }
      return Promise.reject(new Error(early.value));
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCommandResults.delete(requestId);
        reject(new Error("command timeout"));
      }, timeoutMs);

      this.pendingCommandResults.set(requestId, {
        resolve,
        reject,
        timer,
        onProgress,
      });

      const earlyProgressItems = this.earlyCommandProgress.get(requestId);
      if (earlyProgressItems?.length && onProgress) {
        for (const item of earlyProgressItems) {
          void Promise
            .resolve(onProgress(item.output, item.progressSource))
            .catch((error) => console.warn(`[gateway] progress callback failed: ${error instanceof Error ? error.message : String(error)}`));
        }
      }
      this.earlyCommandProgress.delete(requestId);
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

      this.cache.snapshots.clear();
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

    if (parsed.type === "agent.command_result") {
      if (parsed.payload.requestId) {
        const isProgress = Boolean(parsed.payload.progress);
        const pending = this.pendingCommandResults.get(parsed.payload.requestId);
        if (isProgress) {
          if (pending?.onProgress) {
            void Promise
              .resolve(pending.onProgress(parsed.payload.output, parsed.payload.progressSource))
              .catch((error) => console.warn(`[gateway] progress callback failed: ${error instanceof Error ? error.message : String(error)}`));
          } else if (!pending) {
            this.saveEarlyCommandProgress(parsed.payload.requestId, parsed.payload.output, parsed.payload.progressSource);
          }
        } else {
          if (pending) {
            clearTimeout(pending.timer);
            this.pendingCommandResults.delete(parsed.payload.requestId);
            pending.resolve(parsed.payload.output);
          } else {
            this.saveEarlyCommandOutcome(parsed.payload.requestId, true, parsed.payload.output);
          }
          this.earlyCommandProgress.delete(parsed.payload.requestId);
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
        return;
      }

      const pendingCommand = this.pendingCommandResults.get(parsed.payload.requestId);
      if (pendingCommand) {
        clearTimeout(pendingCommand.timer);
        this.pendingCommandResults.delete(parsed.payload.requestId);
        pendingCommand.reject(new Error(`${parsed.payload.code}: ${parsed.payload.message}`));
        return;
      }

      this.earlyCommandProgress.delete(parsed.payload.requestId);
      this.saveEarlyCommandOutcome(parsed.payload.requestId, false, `${parsed.payload.code}: ${parsed.payload.message}`);
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

    for (const [requestId, pending] of this.pendingCommandResults.entries()) {
      clearTimeout(pending.timer);
      this.pendingCommandResults.delete(requestId);
      pending.reject(error);
    }

    this.earlyCommandOutcomes.clear();
    this.earlyCommandProgress.clear();
  }

  private saveEarlyCommandOutcome(requestId: string, ok: boolean, value: string): void {
    if (!requestId) {
      return;
    }
    this.pruneEarlyCommandOutcomes();
    this.earlyCommandOutcomes.set(requestId, {
      ok,
      value,
      at: Date.now(),
    });
  }

  private saveEarlyCommandProgress(requestId: string, output: string, progressSource?: string): void {
    if (!requestId) {
      return;
    }
    this.pruneEarlyCommandProgress();
    const list = this.earlyCommandProgress.get(requestId) ?? [];
    list.push({
      output,
      progressSource,
      at: Date.now(),
    });
    if (list.length > 128) {
      list.splice(0, list.length - 128);
    }
    this.earlyCommandProgress.set(requestId, list);
  }

  private pruneEarlyCommandOutcomes(): void {
    const now = Date.now();
    for (const [requestId, outcome] of this.earlyCommandOutcomes.entries()) {
      if (now - outcome.at > this.earlyCommandOutcomeTtlMs) {
        this.earlyCommandOutcomes.delete(requestId);
      }
    }
  }

  private pruneEarlyCommandProgress(): void {
    const now = Date.now();
    for (const [requestId, list] of this.earlyCommandProgress.entries()) {
      const filtered = list.filter((item) => now - item.at <= this.earlyCommandOutcomeTtlMs);
      if (filtered.length === 0) {
        this.earlyCommandProgress.delete(requestId);
        continue;
      }
      if (filtered.length !== list.length) {
        this.earlyCommandProgress.set(requestId, filtered);
      }
    }
  }
}
// SECTION: router
class TfclawCommandRouter {
  private chatTerminalSelection = new Map<string, string>();
  private chatTmuxTarget = new Map<string, string>();
  private chatTmuxStreamMode = new Map<string, "auto" | "on" | "off">();
  private chatPassthroughEnabled = new Map<string, boolean>();
  private chatCaptureSelections = new Map<string, ChatCaptureSelection>();
  private chatModes = new Map<string, ChatInteractionMode>();
  private progressSessions = new Map<string, TerminalProgressSession>();
  private commandProgressSessions = new Map<string, CommandProgressSession>();
  private activeCommandRequestBySelection = new Map<string, string>();
  private readonly progressPollMs = 1200;
  private readonly progressRecallDelayMs = Math.max(
    80,
    Math.min(2000, toNumber(process.env.TFCLAW_PROGRESS_RECALL_DELAY_MS, 350)),
  );
  private readonly progressIdleTimeoutMs = 10 * 60 * 1000;
  private readonly progressMaxLifetimeMs = 30 * 60 * 1000;

  constructor(private readonly relay: RelayBridge) {}

  private selectionKey(channel: ChannelName, chatId: string): string {
    return `${channel}:${chatId}`;
  }

  private getMode(selectionKey: string): ChatInteractionMode {
    return this.chatModes.get(selectionKey) ?? "tfclaw";
  }

  private setMode(selectionKey: string, mode: ChatInteractionMode): void {
    if (mode === "tfclaw") {
      this.chatModes.delete(selectionKey);
      if (!this.chatPassthroughEnabled.get(selectionKey)) {
        this.chatTmuxTarget.delete(selectionKey);
      }
      this.stopProgressSession(selectionKey);
      return;
    }
    this.chatModes.set(selectionKey, mode);
  }

  private selectedTerminal(selectionKey: string, requireActive: boolean): TerminalSummary | undefined {
    const selectedId = this.chatTerminalSelection.get(selectionKey);
    if (!selectedId) {
      return undefined;
    }
    const terminal = this.relay.cache.terminals.get(selectedId);
    if (!terminal) {
      return undefined;
    }
    if (requireActive && !terminal.isActive) {
      return undefined;
    }
    return terminal;
  }

  private modeTag(selectionKey: string): string {
    const passthroughEnabled = Boolean(this.chatPassthroughEnabled.get(selectionKey));
    const tmuxTarget = this.chatTmuxTarget.get(selectionKey);
    if (passthroughEnabled) {
      return `tmux:${tmuxTarget || "target"}`;
    }

    const mode = this.getMode(selectionKey);
    if (mode === "tfclaw") {
      return "tfclaw";
    }

    if (tmuxTarget) {
      return `tmux:${tmuxTarget}`;
    }

    const selected = this.selectedTerminal(selectionKey, false);
    if (selected) {
      return `terminal:${selected.title} (${selected.terminalId})`;
    }
    const selectedId = this.chatTerminalSelection.get(selectionKey);
    return selectedId ? `terminal:${selectedId}` : "terminal";
  }

  private normalizeCommandLine(line: string): string {
    return line.trim().toLowerCase().replace(/\s+/g, " ");
  }

  private extractTmuxTarget(output: string): string | undefined {
    const source = output.trim();
    if (!source) {
      return undefined;
    }

    const header = source.match(/\[tmux ([^\]\r\n]+)\]/i);
    if (header?.[1]) {
      return header[1].trim();
    }

    const targetSet = source.match(/target set to `([^`]+)`/i);
    if (targetSet?.[1]) {
      return targetSet[1].trim();
    }

    const statusTarget = source.match(/- target:\s*([^\r\n]+)/i);
    if (statusTarget?.[1]) {
      const target = statusTarget[1].trim();
      if (target && target !== "(not set)") {
        return target;
      }
    }

    return undefined;
  }

  private extractTmuxStreamMode(output: string): "auto" | "on" | "off" | undefined {
    const source = output.trim();
    if (!source) {
      return undefined;
    }

    const statusMode = source.match(/- stream_mode:\s*(auto|on|off)\b/i);
    if (statusMode?.[1]) {
      return statusMode[1].toLowerCase() as "auto" | "on" | "off";
    }

    const setMode = source.match(/stream_mode set to\s+(auto|on|off)\b/i);
    if (setMode?.[1]) {
      return setMode[1].toLowerCase() as "auto" | "on" | "off";
    }

    return undefined;
  }

  private updateModeFromResult(selectionKey: string, rawCommand: string, output: string): void {
    const command = this.normalizeCommandLine(rawCommand);
    const target = this.extractTmuxTarget(output);
    if (target) {
      this.chatTmuxTarget.set(selectionKey, target);
    }
    const streamMode = this.extractTmuxStreamMode(output);
    if (streamMode) {
      this.chatTmuxStreamMode.set(selectionKey, streamMode);
    }

    const passthroughOnCommand =
      command === "/passthrough on" || command === "/passthrough enable" || command === "/pt on";
    const passthroughOffCommand =
      command === "/passthrough off" || command === "/passthrough disable" || command === "/pt off";

    if (passthroughOnCommand) {
      if (/passthrough enabled/i.test(output)) {
        this.chatPassthroughEnabled.set(selectionKey, true);
        this.setMode(selectionKey, "terminal");
      }
      return;
    }

    if (passthroughOffCommand) {
      if (/passthrough disabled/i.test(output)) {
        this.chatPassthroughEnabled.set(selectionKey, false);
        this.setMode(selectionKey, "tfclaw");
      }
      return;
    }

    if (/tmux status:/i.test(output)) {
      if (/- passthrough:\s*on/i.test(output)) {
        this.chatPassthroughEnabled.set(selectionKey, true);
        this.setMode(selectionKey, "terminal");
      } else if (/- passthrough:\s*off/i.test(output)) {
        this.chatPassthroughEnabled.set(selectionKey, false);
        this.setMode(selectionKey, "tfclaw");
      }
    }
  }

  private normalizeLegacyErrorMessage(output: string): string {
    const source = output.trim();
    if (!source) {
      return source;
    }
    if (/unknown tfclaw command:/i.test(source)) {
      return "Unknown command. Use `/tmux help`.";
    }
    if (/use\s+\/help,\s*or\s*\/attach/i.test(source)) {
      return source.replace(/use\s+\/help,\s*or\s*\/attach[^\r\n]*/gi, "Use `/tmux help`.");
    }
    return source;
  }

  private normalizeForegroundCommand(command: string | undefined): string {
    const trimmed = (command ?? "").trim().toLowerCase();
    if (!trimmed) {
      return "";
    }
    const base = trimmed.split(/[\\/]/).pop() ?? trimmed;
    return base.endsWith(".exe") ? base.slice(0, -4) : base;
  }

  private shouldEnableProgress(terminal: TerminalSummary | undefined): boolean {
    if (!terminal || !terminal.isActive) {
      return false;
    }
    const normalized = this.normalizeForegroundCommand(terminal.foregroundCommand);
    return normalized.length > 0 && REALTIME_FOREGROUND_COMMANDS.has(normalized);
  }

  private async replyWithMode(
    chatId: string,
    responder: MessageResponder,
    selectionKey: string,
    body: string,
  ): Promise<void> {
    await this.replyWithModeMeta(chatId, responder, selectionKey, body);
  }

  private async replyWithModeMeta(
    chatId: string,
    responder: MessageResponder,
    selectionKey: string,
    body: string,
  ): Promise<{ messageId?: string }> {
    const head = `[mode] ${this.modeTag(selectionKey)}`;
    const content = body.trim();
    const payload = content ? `${head}\n${content}` : head;
    if (typeof responder.replyTextWithMeta === "function") {
      return (await responder.replyTextWithMeta(chatId, payload)) ?? {};
    }
    await responder.replyText(chatId, payload);
    return {};
  }

  private stopProgressSession(selectionKey: string): void {
    const session = this.progressSessions.get(selectionKey);
    if (!session) {
      return;
    }
    clearInterval(session.timer);
    this.progressSessions.delete(selectionKey);
  }

  private scheduleDeleteMessage(responder: MessageResponder, messageId: string): void {
    if (!messageId || typeof responder.deleteMessage !== "function") {
      return;
    }
    setTimeout(() => {
      void responder
        .deleteMessage?.(messageId)
        .catch((error) => console.warn(`[gateway] feishu delete message failed: ${error instanceof Error ? error.message : String(error)}`));
    }, this.progressRecallDelayMs);
  }

  private async sendProgressUpdate(session: TerminalProgressSession, body: string): Promise<void> {
    const previousMessageId = session.lastProgressMessageId;
    const meta = await this.replyWithModeMeta(session.chatId, session.responder, session.selectionKey, body);
    const currentMessageId = meta.messageId;
    if (currentMessageId) {
      session.lastProgressMessageId = currentMessageId;
      if (previousMessageId && previousMessageId !== currentMessageId) {
        this.scheduleDeleteMessage(session.responder, previousMessageId);
      }
    }
  }

  private beginCommandProgressSession(
    selectionKey: string,
    requestId: string,
    chatId: string,
    responder: MessageResponder,
  ): void {
    const previousRequestId = this.activeCommandRequestBySelection.get(selectionKey);
    if (previousRequestId && previousRequestId !== requestId) {
      this.stopCommandProgressSession(previousRequestId, true);
    }

    this.activeCommandRequestBySelection.set(selectionKey, requestId);
    this.commandProgressSessions.set(requestId, {
      requestId,
      selectionKey,
      chatId,
      responder,
      queue: Promise.resolve(),
      streamMode: this.chatTmuxStreamMode.get(selectionKey),
      streamOffIntroSent: false,
    });
  }

  private stopCommandProgressSession(requestId: string, recallLastMessage: boolean): void {
    const session = this.commandProgressSessions.get(requestId);
    if (!session) {
      return;
    }
    this.commandProgressSessions.delete(requestId);

    if (this.activeCommandRequestBySelection.get(session.selectionKey) === requestId) {
      this.activeCommandRequestBySelection.delete(session.selectionKey);
    }

    if (recallLastMessage && session.lastProgressMessageId && typeof session.responder.deleteMessage === "function") {
      void session.responder
        .deleteMessage(session.lastProgressMessageId)
        .catch((error) => console.warn(`[gateway] feishu delete message failed: ${error instanceof Error ? error.message : String(error)}`));
    }
  }

  private queueCommandProgressUpdate(requestId: string, body: string): void {
    const session = this.commandProgressSessions.get(requestId);
    if (!session) {
      return;
    }
    const nextBody = body.trim();
    if (!nextBody) {
      return;
    }

    session.queue = session.queue
      .catch(() => undefined)
      .then(async () => {
        const active = this.commandProgressSessions.get(requestId);
        if (!active) {
          return;
        }
        if (this.activeCommandRequestBySelection.get(active.selectionKey) !== requestId) {
          return;
        }
        if (active.lastProgressBody === nextBody) {
          return;
        }

        if (active.streamMode === "off") {
          if (active.streamOffIntroSent) {
            return;
          }
          await this.replyWithModeMeta(active.chatId, active.responder, active.selectionKey, nextBody);
          await this.replyWithModeMeta(
            active.chatId,
            active.responder,
            active.selectionKey,
            "Tfclaw is waiting for Generating...",
          );
          active.streamOffIntroSent = true;
          active.lastProgressBody = nextBody;
          return;
        }

        const previousMessageId = active.lastProgressMessageId;
        const meta = await this.replyWithModeMeta(active.chatId, active.responder, active.selectionKey, nextBody);
        active.lastProgressBody = nextBody;
        const currentMessageId = meta.messageId;
        if (!currentMessageId) {
          return;
        }
        active.lastProgressMessageId = currentMessageId;
        if (previousMessageId && previousMessageId !== currentMessageId) {
          this.scheduleDeleteMessage(active.responder, previousMessageId);
        }
      })
      .catch((error) => console.warn(`[gateway] progress send failed: ${error instanceof Error ? error.message : String(error)}`));
  }

  private async flushCommandProgressSession(requestId: string): Promise<void> {
    const session = this.commandProgressSessions.get(requestId);
    if (!session) {
      return;
    }
    try {
      await session.queue;
    } catch {
      // no-op
    }
  }

  private async replyWithModeReplacingCommandProgress(
    requestId: string,
    chatId: string,
    responder: MessageResponder,
    selectionKey: string,
    body: string,
  ): Promise<void> {
    await this.flushCommandProgressSession(requestId);
    const progressSession = this.commandProgressSessions.get(requestId);
    const previousProgressMessageId = progressSession?.lastProgressMessageId;
    const meta = await this.replyWithModeMeta(chatId, responder, selectionKey, body);
    if (previousProgressMessageId && (!meta.messageId || meta.messageId !== previousProgressMessageId)) {
      this.scheduleDeleteMessage(progressSession?.responder ?? responder, previousProgressMessageId);
    }
  }

  private startOrRefreshProgressSession(
    selectionKey: string,
    chatId: string,
    responder: MessageResponder,
    terminalId: string,
    baselineOutput?: string,
  ): void {
    const now = Date.now();
    const initialOutput = baselineOutput ?? this.relay.cache.snapshots.get(terminalId)?.output ?? "";
    const existing = this.progressSessions.get(selectionKey);

    if (existing && existing.terminalId === terminalId) {
      existing.chatId = chatId;
      existing.responder = responder;
      existing.lastSnapshot = initialOutput;
      existing.lastChangedAt = now;
      return;
    }

    if (existing) {
      this.stopProgressSession(selectionKey);
    }

    const session: TerminalProgressSession = {
      selectionKey,
      chatId,
      terminalId,
      responder,
      timer: setInterval(() => {
        void this.pollProgressSession(selectionKey);
      }, this.progressPollMs),
      lastSnapshot: initialOutput,
      lastChangedAt: now,
      startedAt: now,
      busy: false,
    };

    this.progressSessions.set(selectionKey, session);
  }

  private async pollProgressSession(selectionKey: string): Promise<void> {
    const session = this.progressSessions.get(selectionKey);
    if (!session || session.busy) {
      return;
    }
    session.busy = true;

    try {
      const now = Date.now();
      if (this.getMode(selectionKey) !== "terminal") {
        this.stopProgressSession(selectionKey);
        return;
      }
      if (now - session.startedAt > this.progressMaxLifetimeMs || now - session.lastChangedAt > this.progressIdleTimeoutMs) {
        this.stopProgressSession(selectionKey);
        return;
      }

      const selected = this.selectedTerminal(selectionKey, true);
      if (!selected || selected.terminalId !== session.terminalId) {
        this.stopProgressSession(selectionKey);
        return;
      }

      const current = this.relay.cache.snapshots.get(session.terminalId)?.output ?? "";
      if (!this.shouldEnableProgress(selected)) {
        if (current !== session.lastSnapshot) {
          session.lastSnapshot = current;
          session.lastChangedAt = now;
        }
        return;
      }

      if (current === session.lastSnapshot) {
        return;
      }

      const delta = current.startsWith(session.lastSnapshot) ? current.slice(session.lastSnapshot.length) : current;
      session.lastSnapshot = current;
      session.lastChangedAt = now;

      const rendered = this.renderOutputForChat(delta, 1800);
      if (rendered === "(no output yet)") {
        return;
      }

      const terminalTitle = selected.title || session.terminalId;
      await this.sendProgressUpdate(session, `# ${terminalTitle} [progress]\n${rendered}`);
    } catch (error) {
      console.warn(`[gateway] progress poll failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      const latest = this.progressSessions.get(selectionKey);
      if (latest) {
        latest.busy = false;
      }
    }
  }

  private resolveTerminal(input: string): TerminalSummary | undefined {
    const normalized = input.trim();
    if (!normalized) {
      return undefined;
    }

    if (this.relay.cache.terminals.has(normalized)) {
      return this.relay.cache.terminals.get(normalized);
    }

    for (const terminal of this.relay.cache.terminals.values()) {
      if (terminal.title === normalized) {
        return terminal;
      }
    }

    const numeric = Number.parseInt(normalized, 10);
    if (Number.isInteger(numeric) && numeric > 0) {
      const list = Array.from(this.relay.cache.terminals.values());
      return list[numeric - 1];
    }

    return undefined;
  }

  private firstActiveTerminal(): TerminalSummary | undefined {
    for (const terminal of this.relay.cache.terminals.values()) {
      if (terminal.isActive) {
        return terminal;
      }
    }
    return undefined;
  }

  private snapshotToLiveFrame(raw: string): string {
    const rendered = renderTerminalStream(raw);
    if (!rendered.text) {
      return "";
    }

    const lines = rendered.text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) {
      return "";
    }

    return lines[lines.length - 1] ?? "";
  }

  private renderOutputForChat(raw: string, maxChars = 2200, extraLiveFrames: string[] = []): string {
    const rendered = renderTerminalStream(raw);
    let body = rendered.text || "(no output yet)";
    if (body.length > maxChars) {
      body = body.slice(-maxChars);
    }

    const frames: string[] = [];
    for (const frame of [...rendered.dynamicFrames, ...extraLiveFrames]) {
      const cleaned = trimRenderedLine(frame);
      if (!cleaned) {
        continue;
      }
      if (frames.length > 0 && frames[frames.length - 1] === cleaned) {
        continue;
      }
      frames.push(cleaned);
    }

    if (frames.length >= 1) {
      const sampled = frames.slice(-8).join("\n");
      const maxDynamicChars = 900;
      const dynamicText = sampled.length > maxDynamicChars ? sampled.slice(-maxDynamicChars) : sampled;
      body = `${body}\n\n[live]\n${dynamicText}`;
    }

    return body;
  }

  private async collectCommandOutput(terminalId: string): Promise<string> {
    const before = this.relay.cache.snapshots.get(terminalId)?.output ?? "";
    const startAt = Date.now();
    let lastValue = before;
    let lastChangeAt = startAt;
    const liveFrames: string[] = [];

    const pushLiveFrame = (raw: string) => {
      const frame = this.snapshotToLiveFrame(raw);
      if (!frame) {
        return;
      }
      if (liveFrames.length > 0 && liveFrames[liveFrames.length - 1] === frame) {
        return;
      }
      liveFrames.push(frame);
      if (liveFrames.length > 24) {
        liveFrames.splice(0, liveFrames.length - 24);
      }
    };

    const maxWaitMs = 12000;
    const pollMs = 250;
    const settleMs = 1200;

    pushLiveFrame(before);

    while (Date.now() - startAt < maxWaitMs) {
      await delay(pollMs);
      const current = this.relay.cache.snapshots.get(terminalId)?.output ?? "";
      if (current !== lastValue) {
        lastValue = current;
        lastChangeAt = Date.now();
        pushLiveFrame(current);
        continue;
      }
      if (Date.now() - lastChangeAt >= settleMs && Date.now() - startAt >= settleMs) {
        break;
      }
    }

    const after = this.relay.cache.snapshots.get(terminalId)?.output ?? "";
    pushLiveFrame(after);
    const delta = after.startsWith(before) ? after.slice(before.length) : after;
    const renderedDelta = renderTerminalStream(delta);
    if (renderedDelta.text || renderedDelta.dynamicFrames.length > 0) {
      return this.renderOutputForChat(delta, 2200, liveFrames);
    }
    return this.renderOutputForChat(after, 2200, liveFrames);
  }

  private tfclawHelpText(): string {
    return [
      "TFClaw mode commands:",
      "1) /list (or list) - list terminals",
      "2) /new (or new) - create terminal",
      "3) /use <id|title|index> - select terminal",
      "4) /attach [id|title|index] - enter terminal mode",
      "5) /close <id|title|index> - close terminal",
      "6) /capture - list screens/windows and choose by number",
      "7) reply number after /capture - capture selected source",
      "8) <terminal-id>: <command> - run one command in specified terminal",
      "9) /state - show current mode",
      "10) /key <enter|tab|esc|ctrl+c|ctrl+d|ctrl+z|ctrl+letter> - send one key to terminal",
      "11) in terminal mode, use .tf <command> to run tfclaw commands",
    ].join("\n");
  }

  private terminalHelpText(): string {
    return [
      "Terminal mode:",
      "1) any message -> sent to tmux terminal input",
      "2) .ctrlc / .ctrld / /key <key> -> send one key to terminal",
      "3) .exit -> back to tfclaw mode",
      "4) .tf <command> (or /tf <command>) -> run tfclaw command in terminal mode",
      "5) progress output is auto-polled only for realtime commands (node/npm/pnpm/yarn...)",
    ].join("\n");
  }

  private keyUsageText(prefix = "/key"): string {
    return `usage: ${prefix} <enter|tab|esc|ctrl+c|ctrl+d|ctrl+z|ctrl+letter>`;
  }

  private parseKeyInput(spec: string): { data: string; label: string } | undefined {
    const trimmed = spec.trim();
    if (!trimmed) {
      return undefined;
    }

    const normalized = trimmed.toLowerCase().replace(/\s+/g, "");
    if (normalized === "enter" || normalized === "return") {
      return { data: "__ENTER__", label: "enter" };
    }
    if (normalized === "tab") {
      return { data: "\t", label: "tab" };
    }
    if (normalized === "esc" || normalized === "escape") {
      return { data: "\x1b", label: "esc" };
    }
    if (normalized === "space") {
      return { data: " ", label: "space" };
    }
    if (normalized === "ctrlc" || normalized === "ctrl+c" || normalized === "ctrl-c" || normalized === "^c") {
      return { data: "__CTRL_C__", label: "ctrl+c" };
    }
    if (normalized === "ctrld" || normalized === "ctrl+d" || normalized === "ctrl-d" || normalized === "^d") {
      return { data: "__CTRL_D__", label: "ctrl+d" };
    }
    if (normalized === "ctrlz" || normalized === "ctrl+z" || normalized === "ctrl-z" || normalized === "^z") {
      return { data: "__CTRL_Z__", label: "ctrl+z" };
    }

    const ctrlMatch = normalized.match(/^(?:ctrl[+-]|\^)([a-z])$/);
    if (ctrlMatch) {
      const letter = ctrlMatch[1];
      const code = letter.charCodeAt(0) - 96;
      if (code >= 1 && code <= 26) {
        return {
          data: String.fromCharCode(code),
          label: `ctrl+${letter}`,
        };
      }
    }

    return undefined;
  }

  private async sendKeyToTerminal(
    ctx: InboundTextContext,
    selectionKey: string,
    terminal: TerminalSummary,
    keySpec: string,
    usagePrefix: string,
  ): Promise<boolean> {
    const parsed = this.parseKeyInput(keySpec);
    if (!parsed) {
      await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, this.keyUsageText(usagePrefix));
      return false;
    }

    this.relay.command({
      command: "terminal.input",
      terminalId: terminal.terminalId,
      data: parsed.data,
    });
    const rendered = await this.collectCommandOutput(terminal.terminalId);
    await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, `[key] ${parsed.label}\n# ${terminal.title}\n${rendered}`);
    const baseline = this.relay.cache.snapshots.get(terminal.terminalId)?.output ?? "";
    this.startOrRefreshProgressSession(selectionKey, ctx.chatId, ctx.responder, terminal.terminalId, baseline);
    return true;
  }

  private parseCommandLine(line: string): { cmd: string; args: string } {
    const normalized = line.startsWith("/") ? line.slice(1).trim() : line.trim();
    const firstSpace = normalized.indexOf(" ");
    if (firstSpace < 0) {
      return {
        cmd: normalized.toLowerCase(),
        args: "",
      };
    }
    return {
      cmd: normalized.slice(0, firstSpace).toLowerCase(),
      args: normalized.slice(firstSpace + 1).trim(),
    };
  }

  private async handleTfclawCommand(
    ctx: InboundTextContext,
    selectionKey: string,
    cmd: string,
    args: string,
  ): Promise<boolean> {
    if (cmd === "help") {
      await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, this.tfclawHelpText());
      return true;
    }

    if (cmd === "state") {
      const selected = this.selectedTerminal(selectionKey, false);
      const text = selected
        ? `selected terminal: ${selected.title} (${selected.terminalId})`
        : "selected terminal: (none)";
      await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, text);
      return true;
    }

    if (cmd === "list") {
      const terminals = Array.from(this.relay.cache.terminals.values());
      if (terminals.length === 0) {
        await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, "no terminals");
        return true;
      }
      const selected = this.chatTerminalSelection.get(selectionKey);
      const content = terminals
        .map((terminal, idx) => {
          const flag = selected === terminal.terminalId ? " *selected" : "";
          const foreground = this.normalizeForegroundCommand(terminal.foregroundCommand);
          const runtime = foreground ? ` cmd=${foreground}` : "";
          return `${idx + 1}. ${terminal.title} [${terminal.terminalId}] ${terminal.isActive ? "active" : "closed"}${runtime}${flag}`;
        })
        .join("\n");
      await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, content);
      return true;
    }

    if (cmd === "new") {
      this.relay.command({
        command: "terminal.create",
        title: `${ctx.channel}-${Date.now()}`,
      });
      await delay(500);
      await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, "terminal.create sent");
      return true;
    }

    if (cmd === "capture") {
      await this.handleCaptureList(ctx.channel, ctx.chatId, ctx.responder);
      return true;
    }

    if (cmd === "attach") {
      await this.enterTerminalMode(ctx, selectionKey, args || undefined);
      return true;
    }

    if (cmd === "key") {
      if (!args) {
        await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, this.keyUsageText("/key"));
        return true;
      }
      const selected = this.selectedTerminal(selectionKey, true) ?? this.firstActiveTerminal();
      if (!selected) {
        await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, "no active terminal. use /new then /attach.");
        return true;
      }
      this.chatTerminalSelection.set(selectionKey, selected.terminalId);
      await this.sendKeyToTerminal(ctx, selectionKey, selected, args, "/key");
      return true;
    }

    if (cmd === "ctrlc" || cmd === "ctrld") {
      const selected = this.selectedTerminal(selectionKey, true);
      if (!selected) {
        await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, "no selected terminal. use /list then /use <id>");
        return true;
      }
      this.relay.command({
        command: "terminal.input",
        terminalId: selected.terminalId,
        data: cmd === "ctrlc" ? "__CTRL_C__" : "__CTRL_D__",
      });
      await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, `/${cmd} sent`);
      return true;
    }

    if (cmd === "use") {
      if (!args) {
        await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, "usage: /use <id|title|index>");
        return true;
      }
      const terminal = this.resolveTerminal(args);
      if (!terminal) {
        await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, `terminal not found: ${args}`);
        return true;
      }
      this.chatTerminalSelection.set(selectionKey, terminal.terminalId);
      if (this.getMode(selectionKey) === "terminal" && terminal.isActive) {
        const baseline = this.relay.cache.snapshots.get(terminal.terminalId)?.output ?? "";
        this.startOrRefreshProgressSession(selectionKey, ctx.chatId, ctx.responder, terminal.terminalId, baseline);
      }
      await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, `selected: ${terminal.title} (${terminal.terminalId})`);
      return true;
    }

    if (cmd === "close") {
      const key = args || this.chatTerminalSelection.get(selectionKey);
      if (!key) {
        await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, "usage: /close <id|title|index>");
        return true;
      }
      const terminal = this.resolveTerminal(key);
      if (!terminal) {
        await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, `terminal not found: ${key}`);
        return true;
      }
      this.relay.command({
        command: "terminal.close",
        terminalId: terminal.terminalId,
      });
      if (this.chatTerminalSelection.get(selectionKey) === terminal.terminalId && this.getMode(selectionKey) === "terminal") {
        this.setMode(selectionKey, "tfclaw");
      }
      await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, `close requested: ${terminal.title}`);
      return true;
    }

    return false;
  }

  private formatCaptureOptions(sources: CaptureSource[]): string {
    const lines = sources.map((source, idx) => `${idx + 1}. [${source.source}] ${source.label}`);
    return ["Select capture source and reply with number:", ...lines].join("\n");
  }

  private async enterTerminalMode(
    ctx: InboundTextContext,
    selectionKey: string,
    requestedRef?: string,
  ): Promise<void> {
    let terminal: TerminalSummary | undefined;

    if (requestedRef) {
      terminal = this.resolveTerminal(requestedRef);
      if (!terminal) {
        await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, `terminal not found: ${requestedRef}`);
        return;
      }
      if (!terminal.isActive) {
        await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, `terminal is closed: ${terminal.title}`);
        return;
      }
    } else {
      terminal = this.selectedTerminal(selectionKey, true) ?? this.firstActiveTerminal();
      if (!terminal) {
        const title = `${ctx.channel}-attach-${Date.now()}`;
        this.relay.command({
          command: "terminal.create",
          title,
        });

        const startAt = Date.now();
        while (Date.now() - startAt < 5000) {
          await delay(250);
          const created = Array.from(this.relay.cache.terminals.values()).find(
            (candidate) => candidate.isActive && candidate.title === title,
          );
          if (created) {
            terminal = created;
            break;
          }
        }
      }
    }

    if (!terminal) {
      await this.replyWithMode(
        ctx.chatId,
        ctx.responder,
        selectionKey,
        "no active terminal found. use /new first, then /attach.",
      );
      return;
    }

    this.chatTerminalSelection.set(selectionKey, terminal.terminalId);
    this.setMode(selectionKey, "terminal");
    const snapshot = this.relay.cache.snapshots.get(terminal.terminalId)?.output ?? "";
    const rendered = this.renderOutputForChat(snapshot, 1200);
    await this.replyWithMode(
      ctx.chatId,
      ctx.responder,
      selectionKey,
      `entered terminal mode: ${terminal.title} (${terminal.terminalId})\nspecial: .ctrlc  .ctrld  /key enter  .exit\n\n# ${terminal.title}\n${rendered}`,
    );
    this.startOrRefreshProgressSession(selectionKey, ctx.chatId, ctx.responder, terminal.terminalId, snapshot);
  }

  private async handleTerminalModeInput(
    ctx: InboundTextContext,
    selectionKey: string,
    line: string,
    originalText: string,
  ): Promise<void> {
    const lower = line.toLowerCase();

    if (lower === ".exit" || lower === ".quit") {
      this.setMode(selectionKey, "tfclaw");
      await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, "left terminal mode. back to tfclaw.");
      return;
    }

    if (lower === ".help") {
      await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, this.terminalHelpText());
      return;
    }

    if (lower === ".ctrlc") {
      const selected = this.selectedTerminal(selectionKey, true);
      if (!selected) {
        this.setMode(selectionKey, "tfclaw");
        await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, "selected terminal missing. switched back to tfclaw.");
        return;
      }
      this.relay.command({
        command: "terminal.input",
        terminalId: selected.terminalId,
        data: "__CTRL_C__",
      });
      await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, ".ctrlc sent");
      return;
    }

    if (lower === ".ctrld") {
      const selected = this.selectedTerminal(selectionKey, true);
      if (!selected) {
        this.setMode(selectionKey, "tfclaw");
        await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, "selected terminal missing. switched back to tfclaw.");
        return;
      }
      this.relay.command({
        command: "terminal.input",
        terminalId: selected.terminalId,
        data: "__CTRL_D__",
      });
      await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, ".ctrld sent");
      return;
    }

    if (lower === "/key" || lower.startsWith("/key ") || lower === ".key" || lower.startsWith(".key ")) {
      const keySpec = line.replace(/^([/.]key)\s*/i, "").trim();
      if (!keySpec) {
        await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, this.keyUsageText("/key"));
        return;
      }
      const selected = this.selectedTerminal(selectionKey, true);
      if (!selected) {
        this.setMode(selectionKey, "tfclaw");
        await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, "selected terminal missing. switched back to tfclaw.");
        return;
      }
      await this.sendKeyToTerminal(ctx, selectionKey, selected, keySpec, "/key");
      return;
    }

    if (lower === ".tf" || lower.startsWith(".tf ") || lower === "/tf" || lower.startsWith("/tf ")) {
      const tfclawLine = line.replace(/^(\.tf|\/tf)\s*/i, "").trim();
      if (!tfclawLine) {
        await this.replyWithMode(
          ctx.chatId,
          ctx.responder,
          selectionKey,
          "usage: .tf <command>\nexample: .tf list, .tf capture, .tf use terminal-1",
        );
        return;
      }
      const { cmd, args } = this.parseCommandLine(tfclawLine);
      const handled = await this.handleTfclawCommand(ctx, selectionKey, cmd, args);
      if (handled) {
        return;
      }
      await this.replyWithMode(
        ctx.chatId,
        ctx.responder,
        selectionKey,
        `unknown tfclaw command: ${tfclawLine}\nuse .tf help`,
      );
      return;
    }

    const selected = this.selectedTerminal(selectionKey, true);
    if (!selected) {
      this.setMode(selectionKey, "tfclaw");
      await this.replyWithMode(
        ctx.chatId,
        ctx.responder,
        selectionKey,
        "selected terminal is unavailable. switched back to tfclaw mode.",
      );
      return;
    }

    const lineToSend = originalText.replace(/\r/g, "").replace(/\n/g, "");
    this.relay.command({
      command: "terminal.input",
      terminalId: selected.terminalId,
      data: `${lineToSend}\n`,
    });
    const rendered = await this.collectCommandOutput(selected.terminalId);
    await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, `# ${selected.title}\n${rendered}`);
    const baseline = this.relay.cache.snapshots.get(selected.terminalId)?.output ?? "";
    this.startOrRefreshProgressSession(selectionKey, ctx.chatId, ctx.responder, selected.terminalId, baseline);
  }

  private async handleCaptureSelection(
    channel: ChannelName,
    chatId: string,
    line: string,
    responder: MessageResponder,
  ): Promise<boolean> {
    const key = this.selectionKey(channel, chatId);
    const selection = this.chatCaptureSelections.get(key);
    if (!selection) {
      return false;
    }

    const age = Date.now() - selection.createdAt;
    if (age > 2 * 60 * 1000) {
      this.chatCaptureSelections.delete(key);
      await this.replyWithMode(chatId, responder, key, "capture selection expired. send /capture again.");
      return true;
    }

    if (!/^\d+$/.test(line)) {
      return false;
    }

    const index = Number.parseInt(line, 10) - 1;
    if (index < 0 || index >= selection.options.length) {
      await this.replyWithMode(chatId, responder, key, `invalid number: ${line}. choose 1-${selection.options.length}.`);
      return true;
    }

    const chosen = selection.options[index];
    this.chatCaptureSelections.delete(key);

    const requestId = this.relay.command({
      command: "screen.capture",
      source: chosen.source,
      sourceId: chosen.sourceId,
      terminalId: selection.terminalId,
    });

    const capturePromise = this.relay.waitForCapture(requestId, 20000);
    await this.replyWithMode(chatId, responder, key, `capturing [${chosen.source}] ${chosen.label} ...`);

    try {
      const capture = await capturePromise;
      await responder.replyImage(chatId, capture.imageBase64);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await this.replyWithMode(chatId, responder, key, `capture failed: ${msg}`);
    }

    return true;
  }

  private async handleCaptureList(channel: ChannelName, chatId: string, responder: MessageResponder): Promise<void> {
    const requestId = this.relay.command({
      command: "capture.list",
    });

    let sources: CaptureSource[];
    try {
      sources = await this.relay.waitForCaptureSources(requestId, 15000);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await this.replyWithMode(chatId, responder, this.selectionKey(channel, chatId), `failed to list capture sources: ${msg}`);
      return;
    }

    if (sources.length === 0) {
      await this.replyWithMode(chatId, responder, this.selectionKey(channel, chatId), "no capture sources found.");
      return;
    }

    const key = this.selectionKey(channel, chatId);
    this.chatCaptureSelections.set(key, {
      options: sources,
      terminalId: this.chatTerminalSelection.get(key),
      createdAt: Date.now(),
    });

    await this.replyWithMode(chatId, responder, key, this.formatCaptureOptions(sources));
  }

  async handleTextMessage(ctx: InboundTextContext): Promise<void> {
    const selectionKey = this.selectionKey(ctx.channel, ctx.chatId);
    if (ctx.allowFrom.length > 0 && (!ctx.senderId || !ctx.allowFrom.includes(ctx.senderId))) {
      await ctx.responder.replyText(ctx.chatId, "not allowed");
      return;
    }

    const text = ctx.text.replace(/\r/g, "").trim();
    if (!text) {
      return;
    }

    const captureSelectionConsumed = await this.handleCaptureSelection(
      ctx.channel,
      ctx.chatId,
      text,
      ctx.responder,
    );
    if (captureSelectionConsumed) {
      return;
    }

    const lowered = text.toLowerCase();
    if (lowered === "/capture" || lowered === "capture") {
      await this.handleCaptureList(ctx.channel, ctx.chatId, ctx.responder);
      return;
    }

    const mode = this.getMode(selectionKey);
    const passthroughEnabled = Boolean(this.chatPassthroughEnabled.get(selectionKey));
    const isSlashCommand = text.startsWith("/");
    const isDotControl = text.startsWith(".");
    const outboundText = (mode === "terminal" || passthroughEnabled) && !isSlashCommand && !isDotControl
      ? `/tmux send ${text}`
      : text;

    const requestId = this.relay.command({
      command: "tfclaw.command",
      text: outboundText,
      sessionKey: selectionKey,
    });
    this.beginCommandProgressSession(selectionKey, requestId, ctx.chatId, ctx.responder);

    try {
      const output = await this.relay.waitForCommandResult(
        requestId,
        COMMAND_RESULT_TIMEOUT_MS,
        (progressOutput, progressSource) => {
          const source = (progressSource ?? "").trim().toLowerCase();
          if (source && source !== "tmux") {
            return;
          }
          const reply = this.normalizeLegacyErrorMessage(progressOutput);
          if (!reply) {
            return;
          }
          this.queueCommandProgressUpdate(requestId, reply);
        },
      );
      this.updateModeFromResult(selectionKey, outboundText, output);
      const reply = this.normalizeLegacyErrorMessage(output);
      if (!reply) {
        await this.replyWithModeReplacingCommandProgress(requestId, ctx.chatId, ctx.responder, selectionKey, "(no output)");
        return;
      }
      await this.replyWithModeReplacingCommandProgress(requestId, ctx.chatId, ctx.responder, selectionKey, reply);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.replyWithModeReplacingCommandProgress(
        requestId,
        ctx.chatId,
        ctx.responder,
        selectionKey,
        `command failed: ${message}`,
      );
      return;
    } finally {
      this.stopCommandProgressSession(requestId, false);
    }
  }
}
// SECTION: chat apps
class FeishuChatApp implements ChatApp, MessageResponder {
  readonly name = "feishu";
  readonly enabled: boolean;
  private wsClient: Lark.WSClient | undefined;
  private larkClient: Lark.Client | undefined;
  private readonly recentInboundKeys = new Map<string, number>();
  private readonly inboundDedupTtlMs = 5 * 60 * 1000;

  constructor(
    private readonly config: FeishuChannelConfig,
    private readonly router: TfclawCommandRouter,
  ) {
    this.enabled = config.enabled;
  }

  async connect(): Promise<void> {
    if (!this.enabled) {
      return;
    }
    if (!this.config.appId || !this.config.appSecret) {
      console.error("[gateway] feishu enabled but appId/appSecret missing.");
      return;
    }

    if (this.config.disableProxy) {
      mergeNoProxyHosts(this.config.noProxyHosts);
      console.log(`[gateway] feishu no_proxy applied: ${(process.env.NO_PROXY ?? "").trim()}`);
    }

    this.larkClient = new Lark.Client({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
    });

    this.wsClient = new Lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      loggerLevel: Lark.LoggerLevel.info,
    });

    this.wsClient.start({
      eventDispatcher: new Lark.EventDispatcher({
        encryptKey: this.config.encryptKey,
        verificationToken: this.config.verificationToken,
      }).register({
        "im.message.receive_v1": async (data: unknown) => {
          await this.handleTextEvent(data);
        },
      }),
    });

    console.log("[gateway] feishu connected via Long Connection");
  }

  async close(): Promise<void> {
    const wsAny = this.wsClient as { stop?: () => void; close?: () => void } | undefined;
    try {
      wsAny?.stop?.();
    } catch {
      // no-op
    }
    try {
      wsAny?.close?.();
    } catch {
      // no-op
    }
    this.wsClient = undefined;
  }

  private isDuplicateInbound(key: string): boolean {
    const now = Date.now();
    for (const [storedKey, seenAt] of this.recentInboundKeys.entries()) {
      if (now - seenAt > this.inboundDedupTtlMs) {
        this.recentInboundKeys.delete(storedKey);
      }
    }
    if (this.recentInboundKeys.has(key)) {
      return true;
    }
    this.recentInboundKeys.set(key, now);
    return false;
  }

  private async sendTextMessage(chatId: string, text: string): Promise<{ messageId?: string }> {
    if (!this.larkClient) {
      throw new Error("feishu client not initialized");
    }

    const result = await this.larkClient.im.v1.message.create({
      params: {
        receive_id_type: "chat_id",
      },
      data: {
        receive_id: chatId,
        msg_type: "text",
        content: JSON.stringify({ text }),
      },
    });

    const resultObj = toObject(result);
    const dataObj = toObject(resultObj.data);
    return {
      messageId: toString(dataObj.message_id) || toString(resultObj.message_id),
    };
  }

  async replyText(chatId: string, text: string): Promise<void> {
    await this.sendTextMessage(chatId, text);
  }

  async replyTextWithMeta(chatId: string, text: string): Promise<{ messageId?: string }> {
    return this.sendTextMessage(chatId, text);
  }

  async deleteMessage(messageId: string): Promise<void> {
    if (!this.larkClient) {
      throw new Error("feishu client not initialized");
    }
    try {
      await this.larkClient.im.v1.message.delete({
        path: {
          message_id: messageId,
        },
      });
    } catch (error) {
      throw new Error(`feishu message delete failed: ${describeSdkError(error)} | message_id=${messageId}`);
    }
  }

  private async addReaction(messageId: string, emojiType = FEISHU_ACK_REACTION): Promise<void> {
    if (!this.larkClient || !messageId) {
      return;
    }
    await this.larkClient.im.v1.messageReaction.create({
      path: {
        message_id: messageId,
      },
      data: {
        reaction_type: {
          emoji_type: emojiType,
        },
      },
    });
  }

  async replyImage(chatId: string, imageBase64: string): Promise<void> {
    if (!this.larkClient) {
      throw new Error("feishu client not initialized");
    }

    const imageBuffer = Buffer.from(imageBase64, "base64");
    if (imageBuffer.byteLength === 0) {
      throw new Error("empty image");
    }
    if (imageBuffer.byteLength > 10 * 1024 * 1024) {
      throw new Error("image too large (>10MB)");
    }

    const tmpPath = path.join(
      os.tmpdir(),
      `tfclaw-feishu-${Date.now()}-${Math.random().toString(16).slice(2)}.png`,
    );
    fs.writeFileSync(tmpPath, imageBuffer);

    let uploadResult: unknown;
    let imageStream: fs.ReadStream | undefined;
    try {
      imageStream = fs.createReadStream(tmpPath);
      uploadResult = await this.larkClient.im.v1.image.create({
        data: {
          image_type: "message",
          image: imageStream,
        },
      });
    } catch (error) {
      throw new Error(`feishu image upload failed: ${describeSdkError(error)}`);
    } finally {
      try {
        imageStream?.destroy();
      } catch {
        // no-op
      }
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // no-op
      }
    }

    const uploadObj = toObject(uploadResult);
    const uploadData = toObject(uploadObj.data);
    const imageKey = toString(uploadObj.image_key) || toString(uploadData.image_key);
    if (!imageKey) {
      const code = toString(uploadObj.code);
      const msg = toString(uploadObj.msg);
      throw new Error(`failed to upload image${code || msg ? `: code=${code || "unknown"} msg=${msg || "unknown"}` : ""}`);
    }

    try {
      await this.larkClient.im.v1.message.create({
        params: {
          receive_id_type: "chat_id",
        },
        data: {
          receive_id: chatId,
          msg_type: "image",
          content: JSON.stringify({ image_key: imageKey }),
        },
      });
    } catch (error) {
      throw new Error(`feishu image message send failed: ${describeSdkError(error)} | image_key=${imageKey}`);
    }
  }

  private async handleTextEvent(data: unknown): Promise<void> {
    const root = toObject(data);
    const message = toObject(root.message);
    const messageType = toString(message.message_type);
    if (messageType !== "text") {
      return;
    }

    const eventHeader = toObject(root.header);
    const messageId = toString(message.message_id);
    const eventId = toString(eventHeader.event_id);
    const dedupKey = messageId || eventId;
    if (dedupKey && this.isDuplicateInbound(dedupKey)) {
      console.log(`[gateway] feishu duplicate message ignored: ${dedupKey}`);
      return;
    }

    const chatId = toString(message.chat_id);
    if (!chatId) {
      return;
    }

    const rawContent = toString(message.content);
    let text = "";
    if (rawContent) {
      try {
        const contentObj = toObject(JSON.parse(rawContent));
        text = toString(contentObj.text);
      } catch {
        text = rawContent;
      }
    }

    const sender = toObject(toObject(root.sender).sender_id);
    const senderOpenId = toString(sender.open_id);

    if (messageId && FEISHU_ACK_REACTION_ENABLED) {
      void this.addReaction(messageId).catch((error) => {
        const msg = error instanceof Error ? error.message : String(error);
        console.warn(`[gateway] feishu add reaction failed: ${msg}`);
      });
    }

    try {
      await this.router.handleTextMessage({
        channel: "feishu",
        chatId,
        senderId: senderOpenId || undefined,
        text,
        allowFrom: this.config.allowFrom,
        responder: this,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await this.replyText(chatId, `failed to process message: ${msg}`);
    }
  }
}

class WhatsAppChatApp implements ChatApp {
  readonly name = "whatsapp";
  readonly enabled: boolean;

  constructor(private readonly config: WhatsAppChannelConfig) {
    this.enabled = config.enabled;
  }

  async connect(): Promise<void> {
    if (!this.enabled) {
      return;
    }
    console.warn("[gateway] whatsapp connect() scaffold is ready (nanobot style), implementation pending.");
  }

  async close(): Promise<void> {}
}

class TelegramChatApp implements ChatApp {
  readonly name = "telegram";
  readonly enabled: boolean;

  constructor(private readonly config: TelegramChannelConfig) {
    this.enabled = config.enabled;
  }

  async connect(): Promise<void> {
    if (!this.enabled) {
      return;
    }
    console.warn("[gateway] telegram connect() scaffold is ready (nanobot style), implementation pending.");
  }

  async close(): Promise<void> {}
}

class DiscordChatApp implements ChatApp {
  readonly name = "discord";
  readonly enabled: boolean;

  constructor(private readonly config: DiscordChannelConfig) {
    this.enabled = config.enabled;
  }

  async connect(): Promise<void> {
    if (!this.enabled) {
      return;
    }
    console.warn("[gateway] discord connect() scaffold is ready (nanobot style), implementation pending.");
  }

  async close(): Promise<void> {}
}

class MochatChatApp implements ChatApp {
  readonly name = "mochat";
  readonly enabled: boolean;

  constructor(private readonly config: MochatChannelConfig) {
    this.enabled = config.enabled;
  }

  async connect(): Promise<void> {
    if (!this.enabled) {
      return;
    }
    console.warn("[gateway] mochat connect() scaffold is ready (nanobot style), implementation pending.");
  }

  async close(): Promise<void> {}
}

class DingTalkChatApp implements ChatApp {
  readonly name = "dingtalk";
  readonly enabled: boolean;

  constructor(private readonly config: DingTalkChannelConfig) {
    this.enabled = config.enabled;
  }

  async connect(): Promise<void> {
    if (!this.enabled) {
      return;
    }
    console.warn("[gateway] dingtalk connect() scaffold is ready (nanobot style), implementation pending.");
  }

  async close(): Promise<void> {}
}

class EmailChatApp implements ChatApp {
  readonly name = "email";
  readonly enabled: boolean;

  constructor(private readonly config: EmailChannelConfig) {
    this.enabled = config.enabled;
  }

  async connect(): Promise<void> {
    if (!this.enabled) {
      return;
    }
    console.warn("[gateway] email connect() scaffold is ready (nanobot style), implementation pending.");
  }

  async close(): Promise<void> {}
}

class SlackChatApp implements ChatApp {
  readonly name = "slack";
  readonly enabled: boolean;

  constructor(private readonly config: SlackChannelConfig) {
    this.enabled = config.enabled;
  }

  async connect(): Promise<void> {
    if (!this.enabled) {
      return;
    }
    console.warn("[gateway] slack connect() scaffold is ready (nanobot style), implementation pending.");
  }

  async close(): Promise<void> {}
}

class QqChatApp implements ChatApp {
  readonly name = "qq";
  readonly enabled: boolean;

  constructor(private readonly config: QQChannelConfig) {
    this.enabled = config.enabled;
  }

  async connect(): Promise<void> {
    if (!this.enabled) {
      return;
    }
    console.warn("[gateway] qq connect() scaffold is ready (nanobot style), implementation pending.");
  }

  async close(): Promise<void> {}
}

class ChatAppManager {
  private readonly apps: ChatApp[];

  constructor(config: GatewayConfig, router: TfclawCommandRouter) {
    this.apps = [
      new WhatsAppChatApp(config.channels.whatsapp),
      new TelegramChatApp(config.channels.telegram),
      new DiscordChatApp(config.channels.discord),
      new FeishuChatApp(config.channels.feishu, router),
      new MochatChatApp(config.channels.mochat),
      new DingTalkChatApp(config.channels.dingtalk),
      new EmailChatApp(config.channels.email),
      new SlackChatApp(config.channels.slack),
      new QqChatApp(config.channels.qq),
    ];
  }

  get enabledChannels(): string[] {
    return this.apps.filter((app) => app.enabled).map((app) => app.name);
  }

  async startAll(): Promise<void> {
    for (const app of this.apps) {
      if (!app.enabled) {
        continue;
      }
      try {
        await app.connect();
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[gateway] failed to connect ${app.name}: ${msg}`);
      }
    }
  }

  async stopAll(): Promise<void> {
    for (const app of this.apps) {
      if (!app.enabled) {
        continue;
      }
      try {
        await app.close();
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[gateway] failed to close ${app.name}: ${msg}`);
      }
    }
  }
}
// SECTION: bootstrap
async function bootstrap(): Promise<void> {
  let loaded: LoadedGatewayConfig;
  try {
    loaded = loadGatewayConfig();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`[gateway] startup failed: ${msg}`);
    process.exit(1);
    return;
  }

  const relay = new RelayBridge(loaded.config.relay.url, loaded.config.relay.token, "feishu");
  const router = new TfclawCommandRouter(relay);
  const chatApps = new ChatAppManager(loaded.config, router);

  relay.connect();
  await chatApps.startAll();

  const enabledChannels = chatApps.enabledChannels;
  console.log("[gateway] TFClaw gateway started");
  console.log(`[gateway] config: ${loaded.configPath}${loaded.fromFile ? "" : " (env fallback)"}`);
  console.log(`[gateway] enabled channels: ${enabledChannels.length > 0 ? enabledChannels.join(", ") : "(none)"}`);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`[gateway] received ${signal}, shutting down...`);
    await chatApps.stopAll();
    relay.close();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

void bootstrap();
