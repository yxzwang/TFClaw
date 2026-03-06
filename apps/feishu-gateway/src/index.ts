import fs from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";
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

interface NexChatBotConfig {
  enabled: boolean;
  baseUrl: string;
  runPath: string;
  apiKey: string;
  timeoutMs: number;
}

interface OpenClawBridgeConfig {
  enabled: boolean;
  openclawRoot: string;
  stateDir: string;
  sharedSkillsDir: string;
  userHomeRoot: string;
  userPrefix: string;
  tmuxSessionPrefix: string;
  gatewayHost: string;
  gatewayPortBase: number;
  gatewayPortMax: number;
  startupTimeoutMs: number;
  requestTimeoutMs: number;
  sessionKey: string;
  nodePath: string;
  configTemplatePath: string;
  autoBuildDist: boolean;
  allowAutoCreateUser: boolean;
  feishuAppId: string;
  feishuAppSecret: string;
  feishuVerificationToken: string;
  feishuWebhookPortOffset: number;
}

interface GatewayConfig {
  relay: RelayConfig;
  nexchatbot: NexChatBotConfig;
  openclawBridge: OpenClawBridgeConfig;
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
  replyFile?(
    chatId: string,
    fileBase64: string,
    fileName: string,
    mimeType?: string,
  ): Promise<void>;
  replyTextWithMeta?(chatId: string, text: string): Promise<{ messageId?: string }>;
  deleteMessage?(messageId: string): Promise<void>;
}

interface BridgeInboundAttachment {
  messageType: string;
  fileName: string;
  mimeType: string;
  contentBase64: string;
  sourceFileKey?: string;
}

interface OpenClawBridgeMediaItem {
  kind: "image" | "file";
  fileName: string;
  mimeType: string;
  contentBase64: string;
  source: string;
}

interface OpenClawBridgeResponse {
  text: string;
  media: OpenClawBridgeMediaItem[];
}

interface HistorySeedEntry {
  role: "user" | "assistant" | "system";
  content: string;
}

interface FeishuMentionEntry {
  key: string;
  name: string;
  openId: string;
  userId: string;
}

interface FeishuAtTagEntry {
  key: string;
  id: string;
  name: string;
}

interface InboundTextContext {
  channel: ChannelName;
  chatId: string;
  chatType: string;
  isMentioned: boolean;
  senderId?: string;
  senderOpenId?: string;
  senderUserId?: string;
  senderName?: string;
  mentions?: FeishuMentionEntry[];
  messageId?: string;
  eventId?: string;
  messageType: string;
  contentRaw: string;
  contentObj: Record<string, unknown>;
  attachments?: BridgeInboundAttachment[];
  text: string;
  llmText: string;
  rawEvent: Record<string, unknown>;
  allowFrom: string[];
  responder: MessageResponder;
}

interface NexChatBridgeRequest {
  source: "tfclaw_feishu_gateway";
  channel: ChannelName;
  selectionKey: string;
  chatId: string;
  senderId?: string;
  senderOpenId?: string;
  senderUserId?: string;
  messageId?: string;
  eventId?: string;
  messageType: string;
  text: string;
  contentRaw: string;
  contentObj: Record<string, unknown>;
  feishuEvent: Record<string, unknown>;
  historySeed?: HistorySeedEntry[];
}

interface OpenClawBridgeRequest {
  source: "tfclaw_feishu_gateway";
  channel: ChannelName;
  selectionKey: string;
  chatId: string;
  senderId?: string;
  senderOpenId?: string;
  senderUserId?: string;
  messageId?: string;
  eventId?: string;
  messageType: string;
  text: string;
  historySeed?: HistorySeedEntry[];
  attachments?: BridgeInboundAttachment[];
  routingUserKey?: string;
  workspaceOverrideDir?: string;
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
}

interface GroupBufferedMessage {
  senderId: string;
  text: string;
  at: number;
}

type TfclawUserRole = "super_root" | "admin" | "user";

interface TfclawAccessGroup {
  name: string;
  displayName: string;
  scopeUserKey: string;
  workspaceDir: string;
  members: string[];
  createdAt: string;
  updatedAt: string;
}

interface TfclawUserProfile {
  displayName: string;
  updatedAt: string;
}

interface TfclawAccessStateFile {
  version: 1;
  superRootUserKey?: string;
  admins: string[];
  groups: Record<string, TfclawAccessGroup>;
  aliases: Record<string, string>;
  userProfiles: Record<string, TfclawUserProfile>;
}

interface OpenClawRouteScope {
  kind: "personal" | "group";
  modeLabel: string;
  routingUserKey: string;
  workspaceOverrideDir?: string;
}

interface RouterUserScope {
  senderKey: string;
  userKey: string;
  linuxUser: string;
  actorRole: TfclawUserRole;
  tmuxSessionKey: string;
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

function resolveSenderUserKey(value: {
  senderOpenId?: string;
  senderUserId?: string;
  senderId?: string;
  routingUserKey?: string;
}): string {
  return (value.routingUserKey || value.senderOpenId || value.senderUserId || value.senderId || "").trim();
}

function sanitizeTmuxName(name: string): string {
  return name
    .trim()
    .replace(/[^\w-]/g, "_")
    .replace(/_{2,}/g, "_")
    .slice(0, 64);
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

const TMUX_SHORT_ALIAS_COMMANDS = new Set([
  "/thelp",
  "/tstatus",
  "/tsessions",
  "/tpanes",
  "/tnew",
  "/ttarget",
  "/tclose",
  "/tsocket",
  "/tlines",
  "/twait",
  "/tstream",
  "/tcapture",
  "/tkey",
  "/tsend",
]);

const TFCLAW_SLASH_COMMAND_ALIAS_TO_LEGACY: Record<string, string> = {
  "/tfhelp": "/help",
  "/tfstate": "/state",
  "/tflist": "/list",
  "/tfnew": "/new",
  "/tfcapture": "/capture",
  "/tfattach": "/attach",
  "/tfkey": "/key",
  "/tfctrlc": "/ctrlc",
  "/tfctrld": "/ctrld",
  "/tfuse": "/use",
  "/tfclose": "/close",
};

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
const FEISHU_DEBUG_INBOUND = toBoolean(process.env.TFCLAW_FEISHU_DEBUG_INBOUND, false);

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

function normalizeLeadingCommandSlash(text: string): string {
  const leadingSpaces = text.match(/^\s*/)?.[0] ?? "";
  const rest = text.slice(leadingSpaces.length);
  if (rest.startsWith("／")) {
    return `${leadingSpaces}/${rest.slice(1)}`;
  }
  return text;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripLeadingFeishuMentions(text: string, mentionKeys: string[]): string {
  let current = text;
  const normalizedKeys = mentionKeys
    .map((item) => item.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);

  let changed = true;
  while (changed) {
    changed = false;
    const trimmedStart = current.trimStart();

    // remove explicit <at ...>...</at> prefixes
    const atTag = trimmedStart.match(/^<at\b[^>]*>[\s\S]*?<\/at>\s*/i);
    if (atTag) {
      current = trimmedStart.slice(atTag[0].length);
      changed = true;
      continue;
    }

    // remove mention keys emitted by Feishu, e.g. @_user_1
    const matchedKey = normalizedKeys.find((key) => trimmedStart.startsWith(key));
    if (matchedKey) {
      current = trimmedStart.slice(matchedKey.length).trimStart();
      changed = true;
    }
  }

  return current;
}

function normalizeFeishuInboundText(rawText: string, mentionKeys: string[]): string {
  const noInvisible = rawText.replace(/\u200b/g, " ");
  const withoutMentions = stripLeadingFeishuMentions(noInvisible, mentionKeys);
  return normalizeLeadingCommandSlash(withoutMentions).trim();
}

function extractFeishuInlineMentionKeys(rawText: string): string[] {
  if (!rawText) {
    return [];
  }
  const matches = rawText.match(/@_user_\d+/g) ?? [];
  return Array.from(new Set(matches.map((item) => item.trim()).filter(Boolean)));
}

function decodeHtmlEntity(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function extractFeishuAtTags(rawText: string): FeishuAtTagEntry[] {
  if (!rawText) {
    return [];
  }

  const results: FeishuAtTagEntry[] = [];
  const seen = new Set<string>();
  const pattern = /<at\b([^>]*)>([\s\S]*?)<\/at>/gi;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(rawText)) !== null) {
    const attrs = match[1] ?? "";
    const body = match[2] ?? "";

    let id = "";
    let key = "";
    const attrPattern = /([a-zA-Z_][\w:-]*)\s*=\s*(['"])(.*?)\2/g;
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = attrPattern.exec(attrs)) !== null) {
      const name = (attrMatch[1] ?? "").trim().toLowerCase();
      const value = decodeHtmlEntity((attrMatch[3] ?? "").trim());
      if (!value) {
        continue;
      }
      if (name === "user_id" || name === "open_id" || name === "id") {
        id = value;
      }
      if (name === "key" || name === "mention_key") {
        key = value;
      }
    }

    const name = decodeHtmlEntity(body.replace(/<[^>]*>/g, "").trim());
    const dedupKey = `${key}|${id}|${name}`;
    if (seen.has(dedupKey)) {
      continue;
    }
    seen.add(dedupKey);
    results.push({ key, id, name });
  }

  return results;
}

function extractFeishuMentions(messageObj: Record<string, unknown>, contentObj: Record<string, unknown>): FeishuMentionEntry[] {
  const mentions: FeishuMentionEntry[] = [];
  const seen = new Set<string>();
  const collect = (value: unknown): void => {
    if (!Array.isArray(value)) {
      return;
    }
    for (const item of value) {
      const mentionObj = toObject(item);
      const mentionIdObj = toObject(mentionObj.id);
      const key = toString(mentionObj.key).trim();
      const name = toString(mentionObj.name, toString(mentionObj.user_name)).trim();
      const openId = toString(mentionIdObj.open_id, toString(mentionObj.open_id)).trim();
      const userId = toString(mentionIdObj.user_id, toString(mentionObj.user_id)).trim();
      if (!key && !name && !openId && !userId) {
        continue;
      }
      const dedupKey = `${key}|${name}|${openId}|${userId}`;
      if (seen.has(dedupKey)) {
        continue;
      }
      seen.add(dedupKey);
      mentions.push({
        key,
        name,
        openId,
        userId,
      });
    }
  };
  collect(messageObj.mentions);
  collect(contentObj.mentions);
  return mentions;
}

function mentionKeys(entries: FeishuMentionEntry[]): string[] {
  return entries
    .map((entry) => entry.key.trim())
    .filter(Boolean);
}

function isFeishuMessageMentionedToBot(
  entries: FeishuMentionEntry[],
  botOpenId: string,
  botName: string,
  appId: string,
  options?: {
    atTags?: FeishuAtTagEntry[];
    mentionKeys?: string[];
  },
): boolean {
  const atTags = options?.atTags ?? [];
  const inlineMentionKeys = options?.mentionKeys ?? [];
  if (entries.length === 0) {
    if (atTags.length === 0) {
      const hasFallbackInlineMention = inlineMentionKeys.length === 1 && inlineMentionKeys[0] === "@_user_0";
      if (!botOpenId.trim() && !botName.trim() && hasFallbackInlineMention) {
        return true;
      }
      return false;
    }
  }

  const normalizedBotOpenId = botOpenId.trim();
  const normalizedBotName = botName.trim();
  const normalizedAppId = appId.trim();
  for (const entry of entries) {
    if (normalizedBotOpenId && (entry.openId === normalizedBotOpenId || entry.userId === normalizedBotOpenId)) {
      return true;
    }
    if (normalizedBotName && entry.name && (entry.name === normalizedBotName || entry.name.includes(normalizedBotName))) {
      return true;
    }
    if (normalizedAppId && (entry.openId === normalizedAppId || entry.userId === normalizedAppId)) {
      return true;
    }
  }

  for (const entry of atTags) {
    const atId = entry.id.trim();
    if (normalizedBotOpenId && atId === normalizedBotOpenId) {
      return true;
    }
    if (normalizedAppId && atId === normalizedAppId) {
      return true;
    }
    if (normalizedBotName && entry.name && (entry.name === normalizedBotName || entry.name.includes(normalizedBotName))) {
      return true;
    }
  }

  if (!normalizedBotOpenId && !normalizedBotName && entries.length === 1 && entries[0]?.key === "@_user_0") {
    return true;
  }
  if (!normalizedBotOpenId && !normalizedBotName && atTags.length === 1) {
    return true;
  }

  return false;
}

function replaceFeishuMentionTokens(
  rawText: string,
  entries: FeishuMentionEntry[],
  botOpenId: string,
  botName: string,
): string {
  let output = rawText.replace(/\u200b/g, " ").replace(/@_all/g, "@全体成员");
  const normalizedBotOpenId = botOpenId.trim();
  const normalizedBotName = botName.trim();

  for (const entry of entries) {
    const key = entry.key.trim();
    if (!key) {
      continue;
    }
    const isBotMention =
      (normalizedBotOpenId.length > 0 && (entry.openId === normalizedBotOpenId || entry.userId === normalizedBotOpenId))
      || (normalizedBotName.length > 0 && entry.name.length > 0
        && (entry.name === normalizedBotName || entry.name.includes(normalizedBotName)));
    if (isBotMention) {
      output = output.replace(new RegExp(`${escapeRegExp(key)}\\s*`, "g"), "");
      continue;
    }
    if (entry.name) {
      output = output.split(key).join(`@${entry.name}`);
    }
  }

  return output
    .replace(/[ \t]+/g, " ")
    .replace(/\n +/g, "\n")
    .trim();
}

interface FeishuPostMediaKeyEntry {
  fileKey: string;
  fileName: string;
}

interface FeishuPostParseResult {
  textContent: string;
  imageKeys: string[];
  mediaKeys: FeishuPostMediaKeyEntry[];
  mentionedIds: string[];
}

function resolveFeishuPostPayload(contentObj: Record<string, unknown>): Record<string, unknown> | undefined {
  const directContent = contentObj.content;
  if (Array.isArray(directContent)) {
    return contentObj;
  }

  const postObj = toObject(contentObj.post);
  if (Array.isArray(postObj.content)) {
    return postObj;
  }
  for (const value of Object.values(postObj)) {
    const candidate = toObject(value);
    if (Array.isArray(candidate.content)) {
      return candidate;
    }
  }

  for (const value of Object.values(contentObj)) {
    const candidate = toObject(value);
    if (Array.isArray(candidate.content)) {
      return candidate;
    }
  }
  return undefined;
}

function dedupeStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((item) => item.trim()).filter(Boolean)));
}

function parseFeishuPostContent(contentObj: Record<string, unknown>): FeishuPostParseResult {
  const payload = resolveFeishuPostPayload(contentObj);
  if (!payload) {
    return {
      textContent: "[富文本消息]",
      imageKeys: [],
      mediaKeys: [],
      mentionedIds: [],
    };
  }

  const paragraphs = Array.isArray(payload.content) ? payload.content : [];
  const textLines: string[] = [];
  const imageKeys: string[] = [];
  const mediaKeys: FeishuPostMediaKeyEntry[] = [];
  const mentionedIds: string[] = [];

  const title = toString(payload.title).trim();
  if (title) {
    textLines.push(title);
  }

  for (const paragraph of paragraphs) {
    if (!Array.isArray(paragraph)) {
      continue;
    }
    const parts: string[] = [];
    for (const element of paragraph) {
      const item = toObject(element);
      const tag = toString(item.tag).trim().toLowerCase();
      if (!tag) {
        continue;
      }
      if (tag === "text") {
        const text = toString(item.text).trim();
        if (text) {
          parts.push(text);
        }
        continue;
      }
      if (tag === "a") {
        const label = toString(item.text).trim();
        const href = toString(item.href).trim();
        if (label && href) {
          parts.push(`${label}: ${href}`);
        } else if (label) {
          parts.push(label);
        } else if (href) {
          parts.push(href);
        }
        continue;
      }
      if (tag === "at") {
        const mentionName = toString(item.user_name, toString(item.text)).trim();
        const mentionId = toString(item.open_id, toString(item.user_id)).trim();
        if (mentionName) {
          parts.push(`@${mentionName}`);
        }
        if (mentionId) {
          mentionedIds.push(mentionId);
        }
        continue;
      }
      if (tag === "img") {
        const imageKey = toString(item.image_key).trim();
        if (imageKey) {
          imageKeys.push(imageKey);
        }
        parts.push("[图片]");
        continue;
      }
      if (tag === "media") {
        const fileKey = toString(item.file_key).trim();
        const fileName = toString(item.file_name, "[媒体文件]").trim() || "[媒体文件]";
        if (fileKey) {
          mediaKeys.push({
            fileKey,
            fileName,
          });
        }
        parts.push(`[媒体] ${fileName}`);
        continue;
      }
      if (tag === "emotion") {
        const emoji = toString(item.emoji, toString(item.text, toString(item.emoji_type))).trim();
        if (emoji) {
          parts.push(emoji);
        }
        continue;
      }
      if (tag === "code" || tag === "code_block" || tag === "pre") {
        const code = toString(item.text, toString(item.content)).trim();
        if (code) {
          parts.push(code);
        }
        continue;
      }
      if (tag === "br") {
        parts.push("\n");
      }
    }
    const line = parts.join(" ").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
    if (line) {
      textLines.push(line);
    }
  }

  return {
    textContent: textLines.join("\n").trim() || "[富文本消息]",
    imageKeys: dedupeStrings(imageKeys),
    mediaKeys: Array.from(
      new Map(
        mediaKeys
          .filter((entry) => entry.fileKey.trim())
          .map((entry) => [entry.fileKey.trim(), { fileKey: entry.fileKey.trim(), fileName: entry.fileName }]),
      ).values(),
    ),
    mentionedIds: dedupeStrings(mentionedIds),
  };
}

function buildFeishuResourceHint(messageType: string, contentObj: Record<string, unknown>, messageId: string): string {
  const normalizedType = messageType.trim().toLowerCase();
  if (normalizedType === "post") {
    const parsedPost = parseFeishuPostContent(contentObj);
    const parts = [
      "[附件待取] 类型: post",
      `message_id: ${messageId || "unknown"}`,
      `内嵌图片数: ${parsedPost.imageKeys.length}`,
      `内嵌媒体数: ${parsedPost.mediaKeys.length}`,
    ];
    if (parsedPost.imageKeys.length > 0) {
      parts.push(`image_keys: ${parsedPost.imageKeys.join(",")}`);
    }
    if (parsedPost.mediaKeys.length > 0) {
      parts.push(`media_file_keys: ${parsedPost.mediaKeys.map((entry) => entry.fileKey).join(",")}`);
    }
    parts.push("下载提示: 调用 download_message_resource 获取并解析内容");
    return parts.join(" | ");
  }

  if (!["image", "file", "media", "video", "audio", "sticker"].includes(normalizedType)) {
    return "";
  }

  let fileKey = "";
  let name = "";
  if (normalizedType === "image") {
    fileKey = toString(contentObj.image_key).trim();
    name = toString(contentObj.image_name, `image_${messageId || "unknown"}.png`).trim();
  } else if (normalizedType === "sticker") {
    fileKey = toString(contentObj.file_key, toString(contentObj.media_id)).trim();
    name = toString(contentObj.file_name, `sticker_${messageId || "unknown"}.webp`).trim();
  } else {
    fileKey = toString(contentObj.file_key, toString(contentObj.media_id)).trim();
    name = toString(contentObj.file_name, toString(contentObj.file, `${normalizedType}_${messageId || "unknown"}`)).trim();
  }

  const parts = [
    `[附件待取] 类型: ${normalizedType}`,
    `文件名: ${name || "未命名"}`,
    `message_id: ${messageId || "unknown"}`,
  ];
  if (fileKey) {
    parts.push(`file_key: ${fileKey}`);
  }
  parts.push("下载提示: 调用 download_message_resource 获取并解析内容");
  return parts.join(" | ");
}

function buildFeishuNonTextBaseText(
  messageType: string,
  contentObj: Record<string, unknown>,
  messageId: string,
): string {
  const normalizedType = messageType.trim().toLowerCase();
  if (normalizedType === "post") {
    const parsedPost = parseFeishuPostContent(contentObj);
    const resourceHint = buildFeishuResourceHint(normalizedType, contentObj, messageId);
    return [parsedPost.textContent, resourceHint].filter(Boolean).join("\n\n").trim();
  }

  if (normalizedType === "share_chat") {
    const body = toString(contentObj.body).trim();
    const summary = toString(contentObj.summary).trim();
    const shareChatId = toString(contentObj.share_chat_id).trim();
    const lines = [
      "[转发会话消息]",
      body || summary ? `内容: ${body || summary}` : "",
      shareChatId ? `share_chat_id: ${shareChatId}` : "",
    ].filter(Boolean);
    return lines.join("\n").trim();
  }

  if (normalizedType === "merge_forward") {
    return "[合并转发消息] 已收到 merge_forward 消息。";
  }

  if (normalizedType === "share_user") {
    const userName = toString(contentObj.user_name, toString(contentObj.name)).trim();
    const userId = toString(contentObj.user_id, toString(contentObj.open_id)).trim();
    const lines = [
      "[分享联系人消息]",
      userName ? `用户名: ${userName}` : "",
      userId ? `用户ID: ${userId}` : "",
    ].filter(Boolean);
    return lines.join("\n").trim();
  }

  const resourceHint = buildFeishuResourceHint(normalizedType, contentObj, messageId);
  if (resourceHint) {
    return resourceHint;
  }

  const fallback = toString(contentObj.text, toString(contentObj.content)).trim();
  if (fallback) {
    return fallback;
  }
  return `[非文本消息] 类型: ${normalizedType || "unknown"}`;
}

const FEISHU_LINK_RE = /https?:\/\/[^\s<>"'`]+/g;
const FEISHU_DOC_LINK_PATH_MARKERS = [
  "/docx/",
  "/doc/",
  "/wiki/",
  "/base/",
  "/sheet/",
  "/sheets/",
  "/bitable/",
];

function trimTrailingPunctuation(text: string): string {
  return text.replace(/[),.;!?，。；！？、]+$/g, "");
}

function extractFeishuDocLinks(text: string): string[] {
  if (!text) {
    return [];
  }

  const matches = text.match(FEISHU_LINK_RE) ?? [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of matches) {
    const candidate = trimTrailingPunctuation(raw.trim());
    if (!candidate) {
      continue;
    }
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      continue;
    }
    const host = parsed.hostname.trim().toLowerCase();
    if (!host) {
      continue;
    }
    const isFeishuHost =
      host.endsWith(".feishu.cn")
      || host === "feishu.cn"
      || host.endsWith(".larksuite.com")
      || host === "larksuite.com";
    if (!isFeishuHost) {
      continue;
    }
    const pathName = parsed.pathname.trim().toLowerCase();
    const hasDocMarker = FEISHU_DOC_LINK_PATH_MARKERS.some((marker) => pathName.includes(marker));
    if (!hasDocMarker) {
      continue;
    }
    const normalized = parsed.toString();
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function buildFeishuDocToolHint(text: string): string {
  const links = extractFeishuDocLinks(text);
  if (links.length === 0) {
    return "";
  }
  const lines = links.map((link, idx) => `${idx + 1}. ${link}`);
  return [
    "[系统提示] 检测到飞书文档/知识库链接。请优先调用内置 Feishu 工具读取链接内容后再回答。",
    "[链接列表]",
    ...lines,
    "[可用工具]",
    "- feishu_doc",
    "- feishu_wiki",
    "- feishu_drive",
    "- feishu_bitable",
  ].join("\n");
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

function hostFromUrl(raw: string): string {
  const text = raw.trim();
  if (!text) {
    return "";
  }
  try {
    return new URL(text).hostname.trim().toLowerCase();
  } catch {
    return "";
  }
}

function isLocalNoProxyHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "0.0.0.0";
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

function joinHttpUrl(baseUrl: string, pathValue: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  const pathPart = pathValue.trim();
  if (!base) {
    return pathPart;
  }
  if (!pathPart) {
    return base;
  }
  if (pathPart.startsWith("http://") || pathPart.startsWith("https://")) {
    return pathPart;
  }
  return `${base}/${pathPart.replace(/^\/+/, "")}`;
}

class NexChatBridgeClient {
  readonly enabled: boolean;

  constructor(private readonly config: NexChatBotConfig) {
    this.enabled = config.enabled && config.baseUrl.trim().length > 0;
  }

  private endpointUrl(): string {
    return joinHttpUrl(this.config.baseUrl, this.config.runPath);
  }

  async run(request: NexChatBridgeRequest): Promise<string> {
    if (!this.enabled) {
      throw new Error("nexchatbot bridge is disabled");
    }

    const timeoutMs = Math.max(1000, this.config.timeoutMs);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      const apiKey = this.config.apiKey.trim();
      if (apiKey) {
        headers["x-api-key"] = apiKey;
        headers.authorization = `Bearer ${apiKey}`;
      }

      const response = await fetch(this.endpointUrl(), {
        method: "POST",
        headers,
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      const responseText = await response.text();

      let payload: Record<string, unknown> = {};
      if (responseText) {
        try {
          payload = toObject(JSON.parse(responseText));
        } catch {
          payload = {};
        }
      }

      if (!response.ok) {
        const detail = toString(payload.detail) || toString(payload.error) || responseText.slice(0, 300);
        throw new Error(`http ${response.status}: ${detail || response.statusText}`);
      }

      const status = toString(payload.status).trim().toLowerCase();
      if (status && status !== "ok") {
        const detail = toString(payload.error) || toString(payload.detail) || "unknown error";
        throw new Error(`bridge status=${status}: ${detail}`);
      }

      const reply = toString(payload.reply).trim();
      if (reply) {
        return reply;
      }

      const detail = toString(payload.error) || toString(payload.detail);
      if (detail) {
        throw new Error(detail);
      }
      return "(nexchatbot returned empty reply)";
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new Error(`request timeout after ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

interface CommandRunResult {
  code: number;
  stdout: string;
  stderr: string;
  spawnError?: Error;
}

interface LinuxUserAccount {
  username: string;
  uid: number;
  gid: number;
  home: string;
  shell: string;
}

interface OpenClawUserBinding {
  linuxUser: string;
  gatewayPort: number;
  gatewayToken: string;
  createdAt: string;
  updatedAt: string;
}

interface OpenClawUserMapFile {
  version: 1;
  users: Record<string, OpenClawUserBinding>;
}

interface OpenClawResolvedUserBinding extends OpenClawUserBinding {
  userKey: string;
  account: LinuxUserAccount;
}

interface OpenClawExecutionScope {
  userKey: string;
  linuxUser: string;
  homeDir: string;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

const OPENCLAW_BRIDGE_FORCED_MODEL_ID = "nex/nex-n1.1";
const OPENCLAW_BRIDGE_FORCED_CONTEXT_WINDOW = 128000;
const OPENCLAW_BRIDGE_FORCED_MAX_TOKENS = 8192;
const OPENCLAW_BRIDGE_COMPACTION_RESERVE_TOKENS_FLOOR = 20000;
const OPENCLAW_BRIDGE_WORKDIR_CONST_NAME = "TFCLAW_USER_WORKDIR";
const OPENCLAW_BRIDGE_WORKDIR_SEPARATOR = "——————————————————————";
const OPENCLAW_BRIDGE_INBOUND_MAX_FILE_BYTES = 30 * 1024 * 1024;
const OPENCLAW_BRIDGE_OUTBOUND_MAX_FILE_BYTES = 30 * 1024 * 1024;
const OPENCLAW_BRIDGE_MEDIA_FETCH_TIMEOUT_MS = 20_000;
const FEISHU_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const FEISHU_MAX_FILE_BYTES = 30 * 1024 * 1024;
const OPENCLAW_BUILTIN_SLASH_COMMANDS = new Set([
  "help",
  "commands",
  "status",
  "context",
  "compact",
  "usage",
  "model",
  "reset",
  "new",
  "think",
  "verbose",
  "reasoning",
  "elevated",
  "exec",
  "skill",
  "whoami",
  "approve",
  "allowlist",
  "config",
  "debug",
  "restart",
  "stop",
  "queue",
  "tts",
]);
const OPENCLAW_BRIDGE_FORCED_PROVIDER = {
  baseUrl: "https://nex-deepseek-long-context.openapi-qb-ai.sii.edu.cn/v1",
  apiKey: "XncN/r7Uvu0PfmM9jwA0+0WRjTL4wE5RQa9qbUFnAM8=",
  api: "openai-completions",
  models: [
    {
      id: OPENCLAW_BRIDGE_FORCED_MODEL_ID,
      name: OPENCLAW_BRIDGE_FORCED_MODEL_ID,
      contextWindow: OPENCLAW_BRIDGE_FORCED_CONTEXT_WINDOW,
      maxTokens: OPENCLAW_BRIDGE_FORCED_MAX_TOKENS,
    },
  ],
};

class OpenClawPerUserBridge {
  readonly enabled: boolean;

  private readonly mapFilePath: string;
  private readonly openclawEntryPath: string;
  private readonly distEntryCandidates: string[];

  private mapLock: Promise<void> = Promise.resolve();
  private runAsModePromise: Promise<"runuser" | "sudo" | "su"> | undefined;
  private distChecked = false;

  constructor(private readonly config: OpenClawBridgeConfig) {
    const root = path.resolve(config.openclawRoot || ".");
    this.config.openclawRoot = root;
    this.enabled = config.enabled && root.trim().length > 0;
    this.mapFilePath = path.join(path.resolve(config.stateDir), "feishu-user-map.json");
    this.openclawEntryPath = path.join(root, "openclaw.mjs");
    this.distEntryCandidates = [
      path.join(root, "dist", "entry.js"),
      path.join(root, "dist", "entry.mjs"),
    ];
  }

  async run(request: OpenClawBridgeRequest): Promise<OpenClawBridgeResponse> {
    if (!this.enabled) {
      throw new Error("openclaw bridge is disabled");
    }

    await this.ensureOpenClawEntry();
    const binding = await this.ensureUserBinding(request);
    const runtime = this.prepareUserRuntime(binding, request.workspaceOverrideDir);
    await this.ensureTmuxOpenClawProcess(binding, runtime);

    const attachmentContext = this.stageInboundAttachments(binding, runtime, request.attachments ?? []);
    const textWithAttachmentContext = this.injectAttachmentContextIntoText(request.text, attachmentContext);
    const slashCommand = this.resolveBuiltinSlashCommand(request.text);
    const prompt = slashCommand
      ? request.text.trim()
      : this.composePrompt(
          textWithAttachmentContext,
          request.historySeed,
          runtime.workspaceConstDeclaration,
        );
    const reply = await this.callGatewayChat({
      gatewayUrl: `ws://${this.config.gatewayHost}:${binding.gatewayPort}`,
      gatewayToken: binding.gatewayToken,
      message: prompt,
      attachments: attachmentContext.gatewayAttachments,
      workspaceDir: runtime.workspaceDir,
      homeDir: binding.account.home,
    });
    const normalized = reply.text.trim();
    if (!normalized && reply.media.length === 0) {
      return {
        text: "(openclaw returned empty reply)",
        media: [],
      };
    }
    if (normalized.toUpperCase() === "NO_REPLY") {
      return {
        text: "(openclaw returned NO_REPLY)",
        media: [],
      };
    }
    return {
      text: normalized,
      media: reply.media,
    };
  }

  private composePrompt(
    text: string,
    historySeed?: HistorySeedEntry[],
    workspaceConstDeclaration?: string,
  ): string {
    const current = text.trim();
    const workdirPrefix = workspaceConstDeclaration
      ? [
          `您的工作目录是：${workspaceConstDeclaration}`,
          OPENCLAW_BRIDGE_WORKDIR_SEPARATOR,
          "如涉及文件或目录操作，请默认在该工作目录内执行，除非用户明确指定其他路径。",
          "你可以直接执行 shell 命令（exec 工具可用）；不要假设自己没有 shell 权限。",
          "本桥接支持你向飞书用户回传图片/文件。",
          "当你需要回传媒体时，请在最终回复中单独添加一行或多行：MEDIA:<文件路径或URL>（每行一个）。",
          "例如：MEDIA:./reports/result.png 或 MEDIA:/abs/path/report.pdf。",
          "不要回复“无法发送附件/无法主动发送文件”之类限制说明；你可以通过 MEDIA 指令发送。",
          "",
        ]
      : [];
    const items = (historySeed ?? []).map((item) => item.content.trim()).filter(Boolean);
    if (items.length === 0) {
      return [...workdirPrefix, current].join("\n");
    }
    return [
      ...workdirPrefix,
      "以下是同一用户在本轮 @ 之前发送的上下文消息（按时间顺序）：",
      ...items.map((item, idx) => `${idx + 1}. ${item}`),
      "",
      "当前消息：",
      current,
    ].join("\n");
  }

  private injectAttachmentContextIntoText(
    text: string,
    context: { promptLines: string[] },
  ): string {
    const baseText = text.trim();
    if (context.promptLines.length === 0) {
      return baseText;
    }
    const sections: string[] = [];
    if (baseText) {
      sections.push(baseText);
    }
    sections.push(
      [
        "[系统提示] 已接收用户上传的附件（已保存到当前用户工作区，可直接读取）：",
        ...context.promptLines,
      ].join("\n"),
    );
    return sections.join("\n\n").trim();
  }

  private stageInboundAttachments(
    binding: OpenClawResolvedUserBinding,
    runtime: { workspaceDir: string },
    attachments: BridgeInboundAttachment[],
  ): {
    promptLines: string[];
    gatewayAttachments: Array<{ type: "image"; mimeType: string; fileName: string; content: string }>;
  } {
    if (attachments.length === 0) {
      return {
        promptLines: [],
        gatewayAttachments: [],
      };
    }

    const inboundRoot = path.join(runtime.workspaceDir, "inbound", `${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fs.mkdirSync(inboundRoot, { recursive: true });
    this.ensurePathOwnerAndMode(inboundRoot, binding.account.uid, binding.account.gid, 0o700);

    const promptLines: string[] = [];
    const gatewayAttachments: Array<{ type: "image"; mimeType: string; fileName: string; content: string }> = [];

    for (const [index, item] of attachments.entries()) {
      const decoded = Buffer.from(item.contentBase64, "base64");
      if (decoded.byteLength === 0) {
        continue;
      }
      if (decoded.byteLength > OPENCLAW_BRIDGE_INBOUND_MAX_FILE_BYTES) {
        continue;
      }

      const safeName = this.sanitizeAttachmentFileName(
        item.fileName,
        `${item.messageType || "file"}-${index + 1}`,
      );
      const targetPath = path.join(inboundRoot, safeName);
      fs.writeFileSync(targetPath, decoded, { mode: 0o600 });
      this.ensurePathOwnerAndMode(targetPath, binding.account.uid, binding.account.gid, 0o600);

      const normalizedMimeType = this.normalizeMimeType(item.mimeType);
      const mimeType = normalizedMimeType === "application/octet-stream"
        ? this.inferMimeTypeFromFileName(safeName)
        : normalizedMimeType;
      promptLines.push(
        `${index + 1}. ${safeName} | type=${item.messageType || "file"} | mime=${mimeType} | path=${targetPath}`,
      );

      if (!this.isImageMimeType(mimeType) && item.messageType.trim().toLowerCase() !== "image") {
        continue;
      }
      gatewayAttachments.push({
        type: "image",
        mimeType: mimeType.startsWith("image/") ? mimeType : "image/png",
        fileName: safeName,
        content: item.contentBase64,
      });
    }

    return {
      promptLines,
      gatewayAttachments,
    };
  }

  private sanitizeAttachmentFileName(fileName: string, fallbackPrefix: string): string {
    const trimmed = fileName.trim();
    const base = path.basename(trimmed || `${fallbackPrefix}.bin`);
    const normalized = base
      .replace(/[\/\\]/g, "_")
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .trim();
    const fallback = `${fallbackPrefix}.bin`;
    return (normalized || fallback).slice(0, 120);
  }

  private normalizeMimeType(mime: string): string {
    const cleaned = mime.trim().split(";")[0]?.trim().toLowerCase() || "";
    return cleaned || "application/octet-stream";
  }

  private inferMimeTypeFromFileName(fileName: string): string {
    const ext = path.extname(fileName).trim().toLowerCase();
    switch (ext) {
      case ".png":
        return "image/png";
      case ".jpg":
      case ".jpeg":
        return "image/jpeg";
      case ".webp":
        return "image/webp";
      case ".gif":
        return "image/gif";
      case ".bmp":
        return "image/bmp";
      case ".svg":
        return "image/svg+xml";
      case ".pdf":
        return "application/pdf";
      case ".txt":
        return "text/plain";
      case ".json":
        return "application/json";
      case ".csv":
        return "text/csv";
      case ".md":
        return "text/markdown";
      case ".mp3":
        return "audio/mpeg";
      case ".wav":
        return "audio/wav";
      case ".mp4":
        return "video/mp4";
      default:
        return "application/octet-stream";
    }
  }

  private isImageMimeType(mimeType: string): boolean {
    return this.normalizeMimeType(mimeType).startsWith("image/");
  }

  private buildWorkspaceConstDeclaration(workspaceDir: string): string {
    return `const ${OPENCLAW_BRIDGE_WORKDIR_CONST_NAME} = ${JSON.stringify(workspaceDir)};`;
  }

  private resolveBuiltinSlashCommand(text: string): string | undefined {
    const trimmed = text.trim();
    const match = trimmed.match(/^\/([a-zA-Z][\w-]*)\b/);
    if (!match) {
      return undefined;
    }
    const command = (match[1] ?? "").toLowerCase();
    if (!command || !OPENCLAW_BUILTIN_SLASH_COMMANDS.has(command)) {
      return undefined;
    }
    return command;
  }

  private resolveRequestUserKey(
    request: Pick<OpenClawBridgeRequest, "senderOpenId" | "senderUserId" | "senderId" | "routingUserKey">,
  ): string {
    return resolveSenderUserKey(request);
  }

  resolveUserKeyFromRequest(
    request: Pick<OpenClawBridgeRequest, "senderOpenId" | "senderUserId" | "senderId" | "routingUserKey">,
  ): string {
    return this.resolveRequestUserKey(request);
  }

  async resolveExecutionScope(
    request: Pick<OpenClawBridgeRequest, "senderOpenId" | "senderUserId" | "senderId" | "routingUserKey">,
  ): Promise<OpenClawExecutionScope> {
    const binding = await this.ensureUserBinding(request);
    return {
      userKey: binding.userKey,
      linuxUser: binding.account.username,
      homeDir: binding.account.home,
    };
  }

  async listUserBindings(): Promise<Array<{
    userKey: string;
    linuxUser: string;
    gatewayPort: number;
    createdAt: string;
    updatedAt: string;
  }>> {
    const map = await this.loadUserMap();
    return Object.entries(map.users)
      .map(([userKey, binding]) => ({
        userKey,
        linuxUser: binding.linuxUser,
        gatewayPort: binding.gatewayPort,
        createdAt: binding.createdAt,
        updatedAt: binding.updatedAt,
      }))
      .sort((a, b) => a.userKey.localeCompare(b.userKey));
  }

  private deriveLinuxUser(userKey: string): string {
    const hash = createHash("sha1").update(userKey).digest("hex");
    const rawPrefix = this.config.userPrefix.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_");
    const safePrefix = rawPrefix && /^[a-z_]/.test(rawPrefix) ? rawPrefix : "tfoc_";
    const candidate = `${safePrefix}${hash.slice(0, 16)}`.replace(/[^a-z0-9_-]/g, "_");
    const limited = candidate.slice(0, 31);
    return /^[a-z_]/.test(limited) ? limited : `u${limited.slice(1)}`;
  }

  private buildRandomToken(): string {
    return randomBytes(24).toString("hex");
  }

  private async withMapLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.mapLock;
    let release: (() => void) | undefined;
    this.mapLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release?.();
    }
  }

  private async loadUserMap(): Promise<OpenClawUserMapFile> {
    if (!fs.existsSync(this.mapFilePath)) {
      return { version: 1, users: {} };
    }
    try {
      const rawText = fs.readFileSync(this.mapFilePath, "utf8");
      const parsed = toObject(JSON.parse(rawText));
      const rawUsers = toObject(parsed.users);
      const users: Record<string, OpenClawUserBinding> = {};
      for (const [key, value] of Object.entries(rawUsers)) {
        const item = toObject(value);
        const linuxUser = toString(item.linuxUser).trim();
        const gatewayPort = toNumber(item.gatewayPort, 0);
        const gatewayToken = toString(item.gatewayToken).trim();
        if (!linuxUser || gatewayPort <= 0) {
          continue;
        }
        users[key] = {
          linuxUser,
          gatewayPort,
          gatewayToken,
          createdAt: toString(item.createdAt, new Date().toISOString()),
          updatedAt: toString(item.updatedAt, new Date().toISOString()),
        };
      }
      return { version: 1, users };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`failed to parse openclaw user map: ${msg}`);
    }
  }

  private async saveUserMap(map: OpenClawUserMapFile): Promise<void> {
    const dir = path.dirname(this.mapFilePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = `${this.mapFilePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(map, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(tmpPath, this.mapFilePath);
  }

  private async commandExists(command: string): Promise<boolean> {
    const probe = await this.runCommand("bash", ["-lc", `command -v ${shellQuote(command)} >/dev/null 2>&1`], {
      timeoutMs: 3000,
    });
    return probe.code === 0;
  }

  private async resolveRunAsMode(): Promise<"runuser" | "sudo" | "su"> {
    this.runAsModePromise ??= (async () => {
      if (await this.commandExists("runuser")) {
        return "runuser";
      }
      if (await this.commandExists("sudo")) {
        return "sudo";
      }
      if (await this.commandExists("su")) {
        return "su";
      }
      throw new Error("neither runuser/sudo/su is available on this host");
    })();
    return await this.runAsModePromise;
  }

  private async runAsUser(
    username: string,
    command: string,
    args: string[],
    options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number },
  ): Promise<CommandRunResult> {
    const mergedEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...(options?.env ?? {}),
    };
    delete mergedEnv.TMUX;
    delete mergedEnv.TMUX_PANE;

    const runOptions = {
      cwd: options?.cwd,
      env: mergedEnv,
      timeoutMs: options?.timeoutMs,
    };

    const mode = await this.resolveRunAsMode();
    if (mode === "runuser") {
      return await this.runCommand("runuser", ["-u", username, "--", command, ...args], runOptions);
    }
    if (mode === "sudo") {
      return await this.runCommand("sudo", ["-u", username, "--", command, ...args], runOptions);
    }
    const cmdline = [command, ...args].map(shellQuote).join(" ");
    return await this.runCommand("su", ["-s", "/bin/bash", "-", username, "-c", cmdline], runOptions);
  }

  private parsePasswdLine(line: string): LinuxUserAccount | undefined {
    const parts = line.split(":");
    if (parts.length < 7) {
      return undefined;
    }
    const username = (parts[0] ?? "").trim();
    const uid = Number.parseInt(parts[2] ?? "", 10);
    const gid = Number.parseInt(parts[3] ?? "", 10);
    const home = (parts[5] ?? "").trim();
    const shell = (parts[6] ?? "").trim();
    if (!username || !Number.isFinite(uid) || !Number.isFinite(gid)) {
      return undefined;
    }
    return {
      username,
      uid,
      gid,
      home: home || path.join(this.config.userHomeRoot, username),
      shell: shell || "/bin/bash",
    };
  }

  private ensureLinuxHomePermissions(account: LinuxUserAccount): void {
    const homeRoot = path.resolve(this.config.userHomeRoot);
    fs.mkdirSync(homeRoot, { recursive: true });
    try {
      fs.chmodSync(homeRoot, 0o711);
    } catch {
      // Ignore mode errors and continue.
    }
    fs.mkdirSync(account.home, { recursive: true });
    this.ensurePathOwnerAndMode(account.home, account.uid, account.gid, 0o700);
  }

  private async queryLinuxUser(username: string): Promise<LinuxUserAccount | undefined> {
    const result = await this.runCommand("getent", ["passwd", username], { timeoutMs: 5000 });
    if (result.code !== 0) {
      return undefined;
    }
    const line = result.stdout
      .split(/\r?\n/)
      .map((item) => item.trim())
      .find((item) => item.startsWith(`${username}:`));
    if (!line) {
      return undefined;
    }
    return this.parsePasswdLine(line);
  }

  private async ensureLinuxUser(username: string): Promise<LinuxUserAccount> {
    const existing = await this.queryLinuxUser(username);
    if (existing) {
      this.ensureLinuxHomePermissions(existing);
      return existing;
    }
    if (!this.config.allowAutoCreateUser) {
      throw new Error(`linux user ${username} does not exist and auto-create is disabled`);
    }
    const uid = process.getuid?.();
    if (uid !== 0) {
      throw new Error(`linux user ${username} does not exist. run gateway as root to auto-create users`);
    }
    const homeDir = path.join(path.resolve(this.config.userHomeRoot), username);
    fs.mkdirSync(path.dirname(homeDir), { recursive: true });
    const created = await this.runCommand("useradd", ["-m", "-d", homeDir, "-s", "/bin/bash", username], {
      timeoutMs: 10_000,
    });
    if (created.code !== 0) {
      const retried = await this.queryLinuxUser(username);
      if (retried) {
        return retried;
      }
      throw new Error(`failed to create linux user ${username}: ${created.stderr.trim() || "unknown error"}`);
    }
    const account = await this.queryLinuxUser(username);
    if (!account) {
      throw new Error(`linux user ${username} created but account lookup failed`);
    }
    this.ensureLinuxHomePermissions(account);
    return account;
  }

  private async isPortAvailable(host: string, port: number): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
      const server = net.createServer();
      server.unref();
      server.once("error", () => {
        resolve(false);
      });
      server.listen(port, host, () => {
        server.close(() => resolve(true));
      });
    });
  }

  private async isPortOpen(host: string, port: number, timeoutMs = 800): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ host, port });
      const timer = setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, timeoutMs);
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
  }

  private async waitForPortOpen(host: string, port: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + Math.max(1000, timeoutMs);
    while (Date.now() < deadline) {
      if (await this.isPortOpen(host, port)) {
        return true;
      }
      await delay(300);
    }
    return false;
  }

  private async allocateGatewayPort(map: OpenClawUserMapFile, seed: string): Promise<number> {
    const minPort = Math.max(1, this.config.gatewayPortBase);
    const maxPort = Math.max(minPort, this.config.gatewayPortMax);
    const span = maxPort - minPort + 1;
    const used = new Set<number>();
    for (const item of Object.values(map.users)) {
      if (Number.isFinite(item.gatewayPort) && item.gatewayPort >= minPort && item.gatewayPort <= maxPort) {
        used.add(item.gatewayPort);
      }
    }
    const hashSeed = Number.parseInt(seed.slice(0, 8), 16);
    for (let i = 0; i < span; i += 1) {
      const candidate = minPort + ((hashSeed + i) % span);
      if (used.has(candidate)) {
        continue;
      }
      if (await this.isPortAvailable(this.config.gatewayHost, candidate)) {
        return candidate;
      }
    }
    throw new Error(`no available openclaw gateway port in ${minPort}-${maxPort}`);
  }

  private async ensureUserBinding(
    request: Pick<OpenClawBridgeRequest, "senderOpenId" | "senderUserId" | "senderId" | "routingUserKey">,
  ): Promise<OpenClawResolvedUserBinding> {
    const userKey = this.resolveRequestUserKey(request);
    if (!userKey) {
      throw new Error("missing feishu sender identity (open_id/user_id/sender_id)");
    }

    return await this.withMapLock(async () => {
      const nowIso = new Date().toISOString();
      const seedHash = createHash("sha1").update(userKey).digest("hex");
      const map = await this.loadUserMap();
      const existing = map.users[userKey];
      let entry: OpenClawUserBinding = existing
        ? { ...existing }
        : {
            linuxUser: this.deriveLinuxUser(userKey),
            gatewayPort: 0,
            gatewayToken: "",
            createdAt: nowIso,
            updatedAt: nowIso,
          };

      let changed = !existing;
      if (!entry.gatewayToken.trim()) {
        entry.gatewayToken = this.buildRandomToken();
        changed = true;
      }
      if (!Number.isFinite(entry.gatewayPort) || entry.gatewayPort <= 0) {
        entry.gatewayPort = await this.allocateGatewayPort(map, seedHash);
        changed = true;
      }

      const account = await this.ensureLinuxUser(entry.linuxUser);

      if (changed) {
        entry.updatedAt = nowIso;
      }
      map.users[userKey] = entry;
      if (changed || !existing) {
        await this.saveUserMap(map);
      }

      return {
        userKey,
        linuxUser: entry.linuxUser,
        gatewayPort: entry.gatewayPort,
        gatewayToken: entry.gatewayToken,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        account,
      };
    });
  }

  private buildOpenClawConfig(
    baseConfig: Record<string, unknown>,
    binding: OpenClawResolvedUserBinding,
    workspaceRoot: string,
  ): Record<string, unknown> {
    let cfg: Record<string, unknown> = {};
    try {
      cfg = toObject(JSON.parse(JSON.stringify(baseConfig)));
    } catch {
      cfg = {};
    }

    const userSkillsDir = path.join(binding.account.home, "skills");
    const sharedSkillsDir = path.resolve(this.config.sharedSkillsDir);

    const gateway = toObject(cfg.gateway);
    gateway.mode = "local";
    gateway.bind = "loopback";
    gateway.port = binding.gatewayPort;
    gateway.auth = {
      mode: "token",
      token: binding.gatewayToken,
    };
    cfg.gateway = gateway;

    const channels = toObject(cfg.channels);
    const feishu = toObject(channels.feishu);
    const feishuWebhookPort = this.derivePerUserFeishuWebhookPort(binding.gatewayPort);
    // Keep Feishu tools available in per-user openclaw while disabling WS ingress conflicts.
    feishu.enabled = true;
    feishu.connectionMode = "webhook";
    feishu.webhookHost = "127.0.0.1";
    feishu.webhookPort = feishuWebhookPort;
    if (!toString(feishu.webhookPath).trim()) {
      feishu.webhookPath = "/feishu/events";
    }
    if (!toString(feishu.appId).trim() && this.config.feishuAppId.trim()) {
      feishu.appId = this.config.feishuAppId.trim();
    }
    if (!toString(feishu.appSecret).trim() && this.config.feishuAppSecret.trim()) {
      feishu.appSecret = this.config.feishuAppSecret.trim();
    }
    const configuredVerificationToken = this.config.feishuVerificationToken.trim();
    if (!toString(feishu.verificationToken).trim()) {
      feishu.verificationToken = configuredVerificationToken || `tfclaw-${binding.account.username}`;
    }
    const feishuTools = toObject(feishu.tools);
    feishuTools.doc = true;
    feishuTools.chat = true;
    feishuTools.wiki = true;
    feishuTools.drive = true;
    feishuTools.scopes = true;
    feishu.tools = feishuTools;
    channels.feishu = feishu;
    cfg.channels = channels;

    // Force all per-user bridge instances onto the shared nex provider/model.
    const models = toObject(cfg.models);
    models.providers = {
      nex: OPENCLAW_BRIDGE_FORCED_PROVIDER,
    };
    cfg.models = models;

    const agents = toObject(cfg.agents);
    const defaults = toObject(agents.defaults);
    defaults.workspace = workspaceRoot;
    defaults.model = {
      primary: OPENCLAW_BRIDGE_FORCED_MODEL_ID,
    };
    defaults.models = {
      [OPENCLAW_BRIDGE_FORCED_MODEL_ID]: {},
    };
    const compaction = toObject(defaults.compaction);
    compaction.mode = "safeguard";
    compaction.reserveTokensFloor = OPENCLAW_BRIDGE_COMPACTION_RESERVE_TOKENS_FLOOR;
    defaults.compaction = compaction;
    agents.defaults = defaults;
    // Prevent inheriting host-level pre-bound agents/workspaces that may be inaccessible to per-user accounts.
    agents.list = [];
    cfg.agents = agents;

    // Load user-personalized skills from <user-home>/skills.
    const skills = toObject(cfg.skills);
    const load = toObject(skills.load);
    const normalizedUserSkillsDir = path.resolve(userSkillsDir);
    const normalizedSharedSkillsDir = path.resolve(sharedSkillsDir);
    // Keep skills sources deterministic: shared + per-user private.
    load.extraDirs = [normalizedSharedSkillsDir, normalizedUserSkillsDir];
    skills.load = load;
    cfg.skills = skills;

    // Per-user bridge is the only ingress/egress; disable template bindings to avoid cross-user drift.
    cfg.bindings = [];

    // Enforce per-user filesystem boundary while allowing command execution as the mapped linux user.
    const tools = toObject(cfg.tools);
    const exec = toObject(tools.exec);
    // Force host exec policy evaluation path and disable interactive approvals.
    exec.host = "gateway";
    exec.security = "full";
    exec.ask = "off";
    const applyPatch = toObject(exec.applyPatch);
    applyPatch.workspaceOnly = true;
    exec.applyPatch = applyPatch;
    tools.exec = exec;

    const fsTools = toObject(tools.fs);
    fsTools.workspaceOnly = true;
    tools.fs = fsTools;
    cfg.tools = tools;

    return cfg;
  }

  private derivePerUserFeishuWebhookPort(gatewayPort: number): number {
    const primary = gatewayPort + this.config.feishuWebhookPortOffset;
    if (primary >= 1025 && primary <= 65535) {
      return primary;
    }
    const secondary = gatewayPort + 1000;
    if (secondary >= 1025 && secondary <= 65535) {
      return secondary;
    }
    return Math.max(1025, Math.min(65535, gatewayPort - 1000));
  }

  private ensurePathOwnerAndMode(targetPath: string, uid: number, gid: number, mode: number): void {
    try {
      fs.chownSync(targetPath, uid, gid);
    } catch {
      // Ignore ownership errors and continue.
    }
    try {
      fs.chmodSync(targetPath, mode);
    } catch {
      // Ignore mode errors and continue.
    }
  }

  private writeExecApprovalsForUser(binding: OpenClawResolvedUserBinding): string {
    const stateDir = path.join(binding.account.home, ".openclaw");
    const approvalsPath = path.join(stateDir, "exec-approvals.json");
    fs.mkdirSync(stateDir, { recursive: true });

    let existing: Record<string, unknown> = {};
    if (fs.existsSync(approvalsPath)) {
      try {
        existing = toObject(JSON.parse(fs.readFileSync(approvalsPath, "utf8")));
      } catch {
        existing = {};
      }
    }

    const socket = toObject(existing.socket);
    const token = toString(socket.token).trim() || this.buildRandomToken();
    const socketPath = toString(socket.path).trim() || path.join(stateDir, "exec-approvals.sock");

    const defaults = toObject(existing.defaults);
    defaults.security = "full";
    defaults.ask = "off";
    defaults.askFallback = "full";

    const agents = toObject(existing.agents);
    const mainAgent = toObject(agents.main);
    mainAgent.security = "full";
    mainAgent.ask = "off";
    mainAgent.askFallback = "full";
    agents.main = mainAgent;

    const normalized = {
      version: 1,
      socket: {
        path: socketPath,
        token,
      },
      defaults,
      agents,
    };

    fs.writeFileSync(approvalsPath, `${JSON.stringify(normalized, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    this.ensurePathOwnerAndMode(stateDir, binding.account.uid, binding.account.gid, 0o700);
    this.ensurePathOwnerAndMode(approvalsPath, binding.account.uid, binding.account.gid, 0o600);
    return approvalsPath;
  }

  private buildExecJailShellScript(): string {
    return [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "",
      'REAL_SHELL="${TFCLAW_EXEC_REAL_SHELL:-/bin/bash}"',
      'WORKSPACE="${TFCLAW_EXEC_WORKSPACE:-${PWD}}"',
      'USER_HOME="${TFCLAW_EXEC_HOME:-${HOME:-$WORKSPACE}}"',
      'USER_NAME="${USER:-$(id -un 2>/dev/null || echo user)}"',
      'PATH_DEFAULT="${PATH:-/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin}"',
      "",
      'if [[ "${1:-}" != "-c" || $# -lt 2 ]]; then',
      '  exec "$REAL_SHELL" "$@"',
      "fi",
      "",
      'CMD="$2"',
      'WORKSPACE="$(readlink -f "$WORKSPACE" 2>/dev/null || realpath "$WORKSPACE" 2>/dev/null || echo "$WORKSPACE")"',
      'USER_HOME="$(readlink -f "$USER_HOME" 2>/dev/null || realpath "$USER_HOME" 2>/dev/null || echo "$USER_HOME")"',
      'if [[ ! -d "$WORKSPACE" ]]; then',
      '  exec "$REAL_SHELL" -c "$CMD"',
      "fi",
      'if [[ ! -d "$USER_HOME" ]]; then',
      '  USER_HOME="$WORKSPACE"',
      "fi",
      "",
      'cd "$WORKSPACE"',
      'export PATH="$PATH_DEFAULT"',
      'export HOME="$USER_HOME"',
      'export USER="$USER_NAME"',
      'export LOGNAME="$USER_NAME"',
      'export SHELL="$REAL_SHELL"',
      'export TERM="${TERM:-xterm-256color}"',
      'export LANG="${LANG:-C.UTF-8}"',
      'exec "$REAL_SHELL" -lc "$CMD"',
    ].join("\n");
  }

  private loadBaseOpenClawConfig(): Record<string, unknown> {
    const templatePath = this.config.configTemplatePath.trim();
    if (!templatePath) {
      return {};
    }
    const absPath = path.resolve(templatePath);
    if (!fs.existsSync(absPath)) {
      throw new Error(`openclaw config template not found: ${absPath}`);
    }
    try {
      return toObject(JSON.parse(fs.readFileSync(absPath, "utf8")));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`failed to parse openclaw config template (${absPath}): ${msg}`);
    }
  }

  private prepareUserRuntime(binding: OpenClawResolvedUserBinding, workspaceOverrideDir?: string): {
    sessionName: string;
    startCommand: string;
    workspaceConstDeclaration: string;
    workspaceDir: string;
  } {
    const runtimeDir = path.join(binding.account.home, ".tfclaw-openclaw");
    const workspaceDir = workspaceOverrideDir?.trim()
      ? path.resolve(workspaceOverrideDir.trim())
      : path.join(runtimeDir, "workspace");
    const agentsDir = path.join(runtimeDir, "agents");
    const shellWrapperDir = path.join(runtimeDir, "bin");
    const shellWrapperPath = path.join(shellWrapperDir, "tfclaw-jail-shell.sh");
    const skillsDir = path.join(binding.account.home, "skills");
    const openclawStateDir = path.join(binding.account.home, ".openclaw");
    const workspaceConstRuntimePath = path.join(runtimeDir, "WORKDIR.const.js");
    const workspaceConstWorkspacePath = path.join(workspaceDir, "WORKDIR.const.js");
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.mkdirSync(shellWrapperDir, { recursive: true });
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.mkdirSync(openclawStateDir, { recursive: true });
    const workspaceConstDeclaration = this.buildWorkspaceConstDeclaration(workspaceDir);
    fs.writeFileSync(workspaceConstRuntimePath, `${workspaceConstDeclaration}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.writeFileSync(workspaceConstWorkspacePath, `${workspaceConstDeclaration}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });

    const baseConfig = this.loadBaseOpenClawConfig();
    const configObj = this.buildOpenClawConfig(baseConfig, binding, workspaceDir);
    const configPath = path.join(runtimeDir, "openclaw.json");

    fs.writeFileSync(configPath, `${JSON.stringify(configObj, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.writeFileSync(shellWrapperPath, `${this.buildExecJailShellScript()}\n`, {
      encoding: "utf8",
      mode: 0o700,
    });
    this.writeExecApprovalsForUser(binding);
    this.ensurePathOwnerAndMode(binding.account.home, binding.account.uid, binding.account.gid, 0o700);
    this.ensurePathOwnerAndMode(runtimeDir, binding.account.uid, binding.account.gid, 0o700);
    this.ensurePathOwnerAndMode(workspaceDir, binding.account.uid, binding.account.gid, 0o700);
    this.ensurePathOwnerAndMode(agentsDir, binding.account.uid, binding.account.gid, 0o700);
    this.ensurePathOwnerAndMode(shellWrapperDir, binding.account.uid, binding.account.gid, 0o700);
    this.ensurePathOwnerAndMode(shellWrapperPath, binding.account.uid, binding.account.gid, 0o700);
    this.ensurePathOwnerAndMode(skillsDir, binding.account.uid, binding.account.gid, 0o700);
    this.ensurePathOwnerAndMode(openclawStateDir, binding.account.uid, binding.account.gid, 0o700);
    this.ensurePathOwnerAndMode(configPath, binding.account.uid, binding.account.gid, 0o600);
    this.ensurePathOwnerAndMode(workspaceConstRuntimePath, binding.account.uid, binding.account.gid, 0o600);
    this.ensurePathOwnerAndMode(workspaceConstWorkspacePath, binding.account.uid, binding.account.gid, 0o600);

    const nodePath = path.resolve(this.config.nodePath || process.execPath);
    const startCommand = [
      "unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy NO_PROXY no_proxy npm_config_proxy npm_config_https_proxy npm_config_http_proxy npm_config_noproxy",
      "umask 077",
      `cd ${shellQuote(this.config.openclawRoot)}`,
      `HOME=${shellQuote(binding.account.home)} USER=${shellQuote(binding.account.username)} LOGNAME=${shellQuote(binding.account.username)} SHELL=${shellQuote(shellWrapperPath)} TFCLAW_EXEC_WORKSPACE=${shellQuote(workspaceDir)} TFCLAW_EXEC_HOME=${shellQuote(binding.account.home)} TFCLAW_EXEC_REAL_SHELL='/bin/bash' OPENCLAW_HOME=${shellQuote(binding.account.home)} CLAWHUB_WORKDIR=${shellQuote(binding.account.home)} OPENCLAW_CONFIG_PATH=${shellQuote(configPath)} OPENCLAW_GATEWAY_TOKEN=${shellQuote(binding.gatewayToken)} exec ${shellQuote(nodePath)} ${shellQuote(this.openclawEntryPath)} gateway --allow-unconfigured --port ${binding.gatewayPort} --bind loopback --auth token --token ${shellQuote(binding.gatewayToken)}`,
    ].join(" && ");

    const sessionRaw = `${this.config.tmuxSessionPrefix}${binding.account.username}`;
    const sessionName = sanitizeTmuxName(sessionRaw) || `openclaw_${binding.account.username}`;
    return {
      sessionName,
      startCommand,
      workspaceConstDeclaration,
      workspaceDir,
    };
  }

  private async ensureTmuxOpenClawProcess(
    binding: OpenClawResolvedUserBinding,
    runtime: { sessionName: string; startCommand: string },
  ): Promise<void> {
    if (await this.isPortOpen(this.config.gatewayHost, binding.gatewayPort)) {
      return;
    }

    const hasSession = await this.runAsUser(binding.account.username, "tmux", [
      "has-session",
      "-t",
      runtime.sessionName,
    ]);
    if (hasSession.code === 0) {
      await this.runAsUser(binding.account.username, "tmux", [
        "kill-session",
        "-t",
        runtime.sessionName,
      ]);
    }

    const started = await this.runAsUser(
      binding.account.username,
      "tmux",
      ["new-session", "-d", "-s", runtime.sessionName, "bash", "-lc", runtime.startCommand],
      { timeoutMs: 10_000 },
    );
    if (started.code !== 0) {
      throw new Error(
        `failed to start tmux session for ${binding.account.username}: ${started.stderr.trim() || "unknown error"}`,
      );
    }

    const ready = await this.waitForPortOpen(
      this.config.gatewayHost,
      binding.gatewayPort,
      this.config.startupTimeoutMs,
    );
    if (ready) {
      return;
    }

    const pane = await this.runAsUser(binding.account.username, "tmux", [
      "capture-pane",
      "-p",
      "-t",
      `${runtime.sessionName}:0.0`,
    ]);
    const tail = pane.stdout.trim().split(/\r?\n/).slice(-20).join("\n");
    throw new Error(
      `openclaw gateway did not become ready on ${this.config.gatewayHost}:${binding.gatewayPort}. tmux tail:\n${tail || "(empty)"}`,
    );
  }

  private extractChatText(message: unknown): string {
    const obj = toObject(message);
    const directText = toString(obj.text).trim();
    if (directText) {
      return directText;
    }
    const content = obj.content;
    if (typeof content === "string") {
      return content.trim();
    }
    if (!Array.isArray(content)) {
      return "";
    }
    const lines: string[] = [];
    for (const item of content) {
      const block = toObject(item);
      const type = toString(block.type).trim().toLowerCase();
      if (type !== "text") {
        continue;
      }
      const text = toString(block.text).trim();
      if (text) {
        lines.push(text);
      }
    }
    return lines.join("\n").trim();
  }

  private unwrapMediaCandidate(raw: string): string {
    return raw
      .trim()
      .replace(/^`(.+)`$/, "$1")
      .replace(/^"(.+)"$/, "$1")
      .replace(/^'(.+)'$/, "$1")
      .trim();
  }

  private looksLikeMediaReference(candidate: string): boolean {
    const value = this.unwrapMediaCandidate(candidate);
    if (!value) {
      return false;
    }
    if (/^data:[^;,]+;base64,/i.test(value)) {
      return true;
    }
    if (/^https?:\/\//i.test(value) || /^file:\/\//i.test(value)) {
      return true;
    }
    if (/^~\//.test(value)) {
      return true;
    }
    if (/^(?:\/|\.{1,2}\/)/.test(value)) {
      return true;
    }
    if (/^[a-zA-Z]:[\\/]/.test(value) || /^\\\\/.test(value)) {
      return true;
    }
    return /^[^\\/:*?"<>|\r\n]+\.[a-zA-Z0-9]{1,10}(?:[?#].*)?$/.test(value);
  }

  private parseMediaDirectivesFromText(text: string): { text: string; mediaRefs: string[] } {
    if (!text.trim()) {
      return { text: "", mediaRefs: [] };
    }
    const keptLines: string[] = [];
    const mediaRefs: string[] = [];
    const inlinePattern = /^\s*(?:>\s*)?(?:[-*]\s+|\d+[.)]\s+)?MEDIA(?:\s*[:：]\s*|\s+)(.+)\s*$/i;
    const markerPattern = /^\s*(?:>\s*)?(?:[-*]\s+|\d+[.)]\s+)?MEDIA\s*[:：]?\s*$/i;
    const listValuePattern = /^\s*(?:>\s*)?(?:[-*]\s+|\d+[.)]\s+)?(.+?)\s*$/;
    let awaitingValue = false;
    let inFence = false;

    for (const rawLine of text.split(/\r?\n/)) {
      const trimmed = rawLine.trim();
      if (/^(?:```|~~~)/.test(trimmed)) {
        inFence = !inFence;
        awaitingValue = false;
        keptLines.push(rawLine);
        continue;
      }
      if (inFence) {
        keptLines.push(rawLine);
        continue;
      }

      const inline = rawLine.match(inlinePattern);
      if (inline) {
        const candidate = this.unwrapMediaCandidate(inline[1] ?? "");
        if (this.looksLikeMediaReference(candidate)) {
          mediaRefs.push(candidate);
          awaitingValue = false;
          continue;
        }
        if (!candidate) {
          awaitingValue = true;
          continue;
        }
        keptLines.push(rawLine);
        awaitingValue = false;
        continue;
      }

      if (markerPattern.test(rawLine)) {
        awaitingValue = true;
        continue;
      }

      if (awaitingValue) {
        if (!trimmed) {
          continue;
        }
        const listCandidate = listValuePattern.exec(rawLine)?.[1] ?? "";
        const normalized = this.unwrapMediaCandidate(listCandidate);
        if (this.looksLikeMediaReference(normalized)) {
          mediaRefs.push(normalized);
          continue;
        }
        awaitingValue = false;
      }

      keptLines.push(rawLine);
    }
    return {
      text: keptLines.join("\n").trim(),
      mediaRefs: Array.from(new Set(mediaRefs)),
    };
  }

  private extractMediaReferencesFromMessage(message: unknown): string[] {
    const obj = toObject(message);
    const refs: string[] = [];
    const singularKeys = [
      "mediaUrl",
      "url",
      "path",
      "filePath",
      "file",
      "fileUrl",
      "imageUrl",
      "audioUrl",
      "videoUrl",
      "source",
      "src",
    ];
    const pluralKeys = [
      "mediaUrls",
      "urls",
      "paths",
      "filePaths",
      "fileUrls",
      "imageUrls",
      "audioUrls",
      "videoUrls",
      "sources",
    ];
    const nestedKeys = ["content", "attachments", "details", "payload", "message", "media", "files"];

    const collectFromRecord = (record: Record<string, unknown>): void => {
      for (const key of singularKeys) {
        const value = this.unwrapMediaCandidate(toString(record[key]).trim());
        if (value && this.looksLikeMediaReference(value)) {
          refs.push(value);
        }
      }
      for (const key of pluralKeys) {
        const raw = record[key];
        if (!Array.isArray(raw)) {
          continue;
        }
        for (const item of raw) {
          const value = this.unwrapMediaCandidate(toString(item).trim());
          if (value && this.looksLikeMediaReference(value)) {
            refs.push(value);
          }
        }
      }
    };

    const walk = (value: unknown, depth: number): void => {
      if (depth > 3 || value == null) {
        return;
      }
      if (Array.isArray(value)) {
        for (const item of value) {
          walk(item, depth + 1);
        }
        return;
      }
      if (typeof value !== "object") {
        return;
      }
      const record = toObject(value);
      collectFromRecord(record);
      for (const key of nestedKeys) {
        if (record[key] !== undefined) {
          walk(record[key], depth + 1);
        }
      }
    };

    walk(obj, 0);
    return Array.from(new Set(refs));
  }

  private isLikelyBase64(value: string): boolean {
    const compact = value.replace(/\s+/g, "");
    if (!compact || compact.length % 4 !== 0) {
      return false;
    }
    return /^[A-Za-z0-9+/]+={0,2}$/.test(compact);
  }

  private parseDataUrl(dataUrl: string): { mimeType: string; base64: string } | undefined {
    const matched = dataUrl.match(/^data:([^;,]+)?;base64,(.+)$/i);
    if (!matched) {
      return undefined;
    }
    const mimeType = this.normalizeMimeType(matched[1] ?? "");
    const base64 = (matched[2] ?? "").replace(/\s+/g, "");
    if (!this.isLikelyBase64(base64)) {
      return undefined;
    }
    return { mimeType, base64 };
  }

  private extractDirectMediaFromMessage(message: unknown): OpenClawBridgeMediaItem[] {
    const obj = toObject(message);
    if (!Array.isArray(obj.content)) {
      return [];
    }

    const result: OpenClawBridgeMediaItem[] = [];
    for (const item of obj.content) {
      const block = toObject(item);
      const type = toString(block.type).trim().toLowerCase();
      if (!type || (type !== "image" && type !== "file" && type !== "media")) {
        continue;
      }
      const rawData = toString(block.data, toString(block.base64, toString(block.content))).trim();
      if (!rawData) {
        continue;
      }

      let contentBase64 = rawData.replace(/\s+/g, "");
      let mimeType = this.normalizeMimeType(
        toString(block.mimeType, toString(block.mime, toString(block.contentType))),
      );
      if (rawData.startsWith("data:")) {
        const parsed = this.parseDataUrl(rawData);
        if (!parsed) {
          continue;
        }
        contentBase64 = parsed.base64;
        mimeType = parsed.mimeType;
      } else if (!this.isLikelyBase64(contentBase64)) {
        continue;
      }

      const fileName = this.sanitizeAttachmentFileName(
        toString(block.fileName, toString(block.name, `${type}-${Date.now()}`)),
        type || "media",
      );
      const isImage = type === "image" || this.isImageMimeType(mimeType);
      result.push({
        kind: isImage ? "image" : "file",
        fileName,
        mimeType: mimeType || this.inferMimeTypeFromFileName(fileName),
        contentBase64,
        source: "gateway-message-block",
      });
    }
    return result;
  }

  private dedupeMediaItems(items: OpenClawBridgeMediaItem[]): OpenClawBridgeMediaItem[] {
    const seen = new Set<string>();
    const out: OpenClawBridgeMediaItem[] = [];
    for (const item of items) {
      const key = `${item.kind}::${item.fileName}::${item.contentBase64.slice(0, 64)}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push(item);
    }
    return out;
  }

  private normalizeMediaReference(raw: string): string {
    return raw
      .trim()
      .replace(/^`(.+)`$/, "$1")
      .replace(/^"(.+)"$/, "$1")
      .replace(/^'(.+)'$/, "$1")
      .trim();
  }

  private isPathInsideRoot(targetPath: string, rootPath: string): boolean {
    const target = path.resolve(targetPath);
    const root = path.resolve(rootPath);
    if (target === root) {
      return true;
    }
    return target.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);
  }

  private resolveLocalMediaPath(reference: string, workspaceDir: string, homeDir: string): string {
    const normalized = this.normalizeMediaReference(reference);
    if (!normalized) {
      throw new Error("empty media reference");
    }
    if (normalized.startsWith("file://")) {
      try {
        return decodeURIComponent(new URL(normalized).pathname);
      } catch {
        throw new Error(`invalid file url: ${normalized}`);
      }
    }
    if (normalized.startsWith("~/")) {
      return path.join(homeDir, normalized.slice(2));
    }
    if (path.isAbsolute(normalized)) {
      return normalized;
    }
    return path.resolve(workspaceDir, normalized);
  }

  private async loadMediaFromReference(
    reference: string,
    options: { workspaceDir: string; homeDir: string },
  ): Promise<OpenClawBridgeMediaItem> {
    const normalized = this.normalizeMediaReference(reference);
    if (!normalized) {
      throw new Error("empty media reference");
    }

    if (normalized.startsWith("data:")) {
      const parsed = this.parseDataUrl(normalized);
      if (!parsed) {
        throw new Error("invalid data url media reference");
      }
      const fileName = this.sanitizeAttachmentFileName(
        `inline.${this.isImageMimeType(parsed.mimeType) ? "png" : "bin"}`,
        "inline-media",
      );
      return {
        kind: this.isImageMimeType(parsed.mimeType) ? "image" : "file",
        fileName,
        mimeType: parsed.mimeType || this.inferMimeTypeFromFileName(fileName),
        contentBase64: parsed.base64,
        source: "data-url",
      };
    }

    if (/^https?:\/\//i.test(normalized)) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), OPENCLAW_BRIDGE_MEDIA_FETCH_TIMEOUT_MS);
      try {
        const response = await fetch(normalized, {
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`http ${response.status}`);
        }
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        if (buffer.byteLength === 0) {
          throw new Error("empty body");
        }
        if (buffer.byteLength > OPENCLAW_BRIDGE_OUTBOUND_MAX_FILE_BYTES) {
          throw new Error(`file too large: ${buffer.byteLength} bytes`);
        }
        let fileName = "downloaded-media.bin";
        try {
          const parsedUrl = new URL(normalized);
          const fromPath = path.basename(parsedUrl.pathname || "");
          if (fromPath) {
            fileName = fromPath;
          }
        } catch {
          // no-op
        }
        const safeName = this.sanitizeAttachmentFileName(fileName, "downloaded-media");
        const headerMimeType = this.normalizeMimeType(response.headers.get("content-type") ?? "");
        const mimeType = headerMimeType === "application/octet-stream"
          ? this.inferMimeTypeFromFileName(safeName)
          : headerMimeType;
        return {
          kind: this.isImageMimeType(mimeType) ? "image" : "file",
          fileName: safeName,
          mimeType,
          contentBase64: buffer.toString("base64"),
          source: normalized,
        };
      } finally {
        clearTimeout(timer);
      }
    }

    const resolved = this.resolveLocalMediaPath(normalized, options.workspaceDir, options.homeDir);
    if (
      !this.isPathInsideRoot(resolved, options.workspaceDir)
      && !this.isPathInsideRoot(resolved, options.homeDir)
    ) {
      throw new Error(`local media path outside user scope: ${resolved}`);
    }
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) {
      throw new Error(`not a file: ${resolved}`);
    }
    if (stat.size > OPENCLAW_BRIDGE_OUTBOUND_MAX_FILE_BYTES) {
      throw new Error(`file too large: ${stat.size} bytes`);
    }
    const buffer = fs.readFileSync(resolved);
    const fileName = this.sanitizeAttachmentFileName(path.basename(resolved), "media");
    const mimeType = this.inferMimeTypeFromFileName(fileName);
    return {
      kind: this.isImageMimeType(mimeType) ? "image" : "file",
      fileName,
      mimeType,
      contentBase64: buffer.toString("base64"),
      source: resolved,
    };
  }

  private async resolveMediaReferences(
    refs: string[],
    options: { workspaceDir: string; homeDir: string },
  ): Promise<OpenClawBridgeMediaItem[]> {
    const items: OpenClawBridgeMediaItem[] = [];
    for (const reference of Array.from(new Set(refs))) {
      try {
        const media = await this.loadMediaFromReference(reference, options);
        items.push(media);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.warn(`[gateway] openclaw media bridge skip ${reference}: ${msg}`);
      }
    }
    return items;
  }

  private listRecentFilesUnder(
    rootDir: string,
    options?: {
      maxCount?: number;
      maxDirs?: number;
      modifiedAfterMs?: number;
      excludeDirs?: string[];
      excludeDirNames?: string[];
    },
  ): string[] {
    if (!rootDir || !fs.existsSync(rootDir)) {
      return [];
    }
    const maxCount = Math.max(1, options?.maxCount ?? 40);
    const maxDirs = Math.max(1, options?.maxDirs ?? 200);
    const modifiedAfterMs = options?.modifiedAfterMs;
    const excludeDirs = (options?.excludeDirs ?? []).map((item) => path.resolve(item));
    const excludeDirNames = new Set((options?.excludeDirNames ?? []).map((item) => item.toLowerCase()));
    const stack = [rootDir];
    const files: Array<{ filePath: string; mtimeMs: number }> = [];
    let scannedDirs = 0;

    while (stack.length > 0 && scannedDirs < maxDirs) {
      const currentDir = stack.pop() ?? "";
      if (!currentDir) {
        continue;
      }
      if (
        excludeDirs.some((dir) =>
          this.isPathInsideRoot(path.resolve(currentDir), dir)
        )
      ) {
        continue;
      }
      scannedDirs += 1;
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(currentDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const candidate = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          if (excludeDirNames.has(entry.name.toLowerCase())) {
            continue;
          }
          stack.push(candidate);
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }
        let stat: fs.Stats | undefined;
        try {
          stat = fs.statSync(candidate);
        } catch {
          stat = undefined;
        }
        if (!stat || !stat.isFile()) {
          continue;
        }
        if (typeof modifiedAfterMs === "number" && Number.isFinite(modifiedAfterMs) && stat.mtimeMs < modifiedAfterMs) {
          continue;
        }
        files.push({
          filePath: candidate,
          mtimeMs: Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : 0,
        });
      }
    }

    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return files.slice(0, maxCount).map((item) => item.filePath);
  }

  private async resolveMediaPlaceholderFallback(
    rawText: string,
    options: { workspaceDir: string; homeDir: string; runStartedAtMs?: number },
  ): Promise<OpenClawBridgeMediaItem[]> {
    const marker = rawText.match(/^\s*(?:>\s*)?(?:[-*]\s+|\d+[.)]\s+)?MEDIA\s*[:：]?\s*([^\n]*)\s*$/im);
    if (!marker) {
      return [];
    }
    const markerValue = this.unwrapMediaCandidate(marker[1] ?? "");
    if (markerValue && this.looksLikeMediaReference(markerValue)) {
      try {
        return [await this.loadMediaFromReference(markerValue, options)];
      } catch {
        // Continue to inbound fallback.
      }
    }

    const candidateRoots = Array.from(
      new Set([
        path.join(options.workspaceDir, "outbound"),
        path.join(options.workspaceDir, "media"),
        options.workspaceDir,
      ]),
    );
    const scanOptions = {
      maxCount: 120,
      maxDirs: 400,
      modifiedAfterMs: typeof options.runStartedAtMs === "number"
        ? Math.max(0, options.runStartedAtMs - 30_000)
        : undefined,
      excludeDirs: markerValue ? [] : [path.join(options.workspaceDir, "inbound")],
      excludeDirNames: [".git", "node_modules"],
    };
    let recentFiles = candidateRoots.flatMap((rootDir) => this.listRecentFilesUnder(rootDir, scanOptions));
    if (recentFiles.length === 0 && typeof scanOptions.modifiedAfterMs === "number") {
      recentFiles = candidateRoots.flatMap((rootDir) =>
        this.listRecentFilesUnder(rootDir, { ...scanOptions, modifiedAfterMs: undefined }));
    }
    recentFiles = Array.from(new Set(recentFiles)).filter((candidate) =>
      this.isPathInsideRoot(candidate, options.workspaceDir)
      || this.isPathInsideRoot(candidate, options.homeDir));
    if (recentFiles.length === 0) {
      return [];
    }

    let target = recentFiles[0] ?? "";
    if (markerValue) {
      const normalizedMarker = markerValue
        .replace(/^[./]+/, "")
        .replace(/\\/g, "/")
        .toLowerCase();
      if (normalizedMarker) {
        const matched = recentFiles.find((candidate) => {
          const rel = path.relative(options.workspaceDir, candidate).replace(/\\/g, "/").toLowerCase();
          const base = path.basename(candidate).toLowerCase();
          return rel.startsWith(normalizedMarker) || base.startsWith(normalizedMarker);
        });
        if (matched) {
          target = matched;
        }
      }
    }

    if (!target) {
      return [];
    }
    try {
      return [await this.loadMediaFromReference(target, options)];
    } catch {
      return [];
    }
  }

  private formatFrameError(frame: Record<string, unknown>): string {
    const error = toObject(frame.error);
    const message = toString(error.message).trim();
    if (message) {
      return message;
    }
    const code = toString(error.code).trim();
    if (code) {
      return `gateway error: ${code}`;
    }
    return "gateway request failed";
  }

  private async callGatewayChat(params: {
    gatewayUrl: string;
    gatewayToken: string;
    message: string;
    attachments?: Array<{ type: "image"; mimeType: string; fileName: string; content: string }>;
    workspaceDir: string;
    homeDir: string;
  }): Promise<OpenClawBridgeResponse> {
    return await new Promise<OpenClawBridgeResponse>((resolve, reject) => {
      const ws = new WebSocket(params.gatewayUrl);
      const connectReqId = `connect-${randomId()}`;
      const chatReqId = `chat-${randomId()}`;
      const runStartedAtMs = Date.now();
      let closed = false;
      let runId = "";
      let lastDelta = "";
      let lastAssistantText = "";
      let lastMediaRefs: string[] = [];
      let lastDirectMedia: OpenClawBridgeMediaItem[] = [];

      const cleanup = (): void => {
        if (closed) {
          return;
        }
        closed = true;
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          // no-op
        }
      };

      const fail = (error: string): void => {
        cleanup();
        reject(new Error(error));
      };

      const done = (reply: OpenClawBridgeResponse): void => {
        cleanup();
        resolve(reply);
      };

      const timer = setTimeout(() => {
        fail(`openclaw gateway request timeout after ${this.config.requestTimeoutMs}ms`);
      }, this.config.requestTimeoutMs);

      ws.once("open", () => {
        const connectFrame = {
          type: "req",
          id: connectReqId,
          method: "connect",
          params: {
            minProtocol: 1,
            maxProtocol: 99,
            client: {
              id: "gateway-client",
              version: "1.0.0",
              platform: process.platform,
              mode: "backend",
            },
            role: "operator",
            scopes: ["operator.admin"],
            caps: [],
            auth: params.gatewayToken ? { token: params.gatewayToken } : undefined,
          },
        };
        ws.send(JSON.stringify(connectFrame));
      });

      ws.on("message", (raw) => {
        let frame: Record<string, unknown>;
        try {
          const text = typeof raw === "string" ? raw : raw.toString();
          frame = toObject(JSON.parse(text));
        } catch {
          return;
        }

        const frameType = toString(frame.type).trim().toLowerCase();
        if (frameType === "res") {
          const id = toString(frame.id).trim();
          const ok = Boolean(frame.ok);
          if (id === connectReqId) {
            if (!ok) {
              fail(`openclaw gateway connect failed: ${this.formatFrameError(frame)}`);
              return;
            }
            const chatFrame = {
              type: "req",
              id: chatReqId,
              method: "chat.send",
              params: {
                sessionKey: this.config.sessionKey,
                message: params.message,
                deliver: false,
                attachments: params.attachments?.length ? params.attachments : undefined,
                timeoutMs: this.config.requestTimeoutMs,
                idempotencyKey: `tfclaw-openclaw-${randomId()}`,
              },
            };
            ws.send(JSON.stringify(chatFrame));
            return;
          }

          if (id === chatReqId) {
            if (!ok) {
              fail(`openclaw chat.send failed: ${this.formatFrameError(frame)}`);
              return;
            }
            const payload = toObject(frame.payload);
            const status = toString(payload.status).trim().toLowerCase();
            const payloadRunId = toString(payload.runId).trim();
            if (payloadRunId) {
              runId = payloadRunId;
            }
            if (status === "error") {
              const summary = toString(payload.summary).trim() || "unknown chat.send error";
              fail(`openclaw chat.send error: ${summary}`);
              return;
            }
            if (status === "ok" && !runId) {
              const summary = toString(payload.summary).trim();
              done({
                text: summary || "(openclaw run completed)",
                media: [],
              });
            }
          }
          return;
        }

        if (frameType !== "event") {
          return;
        }

        const eventName = toString(frame.event).trim().toLowerCase();
        if (eventName === "agent") {
          const payload = toObject(frame.payload);
          const payloadRunId = toString(payload.runId).trim();
          if (runId && payloadRunId && payloadRunId !== runId) {
            return;
          }
          if (!runId && payloadRunId) {
            runId = payloadRunId;
          }

          const data = toObject(payload.data);
          const dataText = toString(data.text).trim();
          if (dataText) {
            const parsedDataText = this.parseMediaDirectivesFromText(dataText);
            if (parsedDataText.text) {
              lastAssistantText = parsedDataText.text;
            }
            if (parsedDataText.mediaRefs.length > 0) {
              lastMediaRefs = Array.from(new Set([
                ...lastMediaRefs,
                ...parsedDataText.mediaRefs,
              ]));
            }
          }
          lastMediaRefs = Array.from(new Set([
            ...lastMediaRefs,
            ...this.extractMediaReferencesFromMessage(payload),
            ...this.extractMediaReferencesFromMessage(data),
          ]));
          return;
        }

        if (eventName !== "chat") {
          return;
        }

        const payload = toObject(frame.payload);
        const payloadRunId = toString(payload.runId).trim();
        if (runId && payloadRunId && payloadRunId !== runId) {
          return;
        }
        if (!runId && payloadRunId) {
          runId = payloadRunId;
        }

        const state = toString(payload.state).trim().toLowerCase();
        if (state === "delta") {
          const messageObj = toObject(payload.message);
          const deltaRaw = this.extractChatText(messageObj);
          if (deltaRaw) {
            const parsedDelta = this.parseMediaDirectivesFromText(deltaRaw);
            if (parsedDelta.text) {
              lastDelta = parsedDelta.text;
            }
            if (parsedDelta.mediaRefs.length > 0) {
              lastMediaRefs = Array.from(new Set([
                ...lastMediaRefs,
                ...parsedDelta.mediaRefs,
              ]));
            }
          }
          lastMediaRefs = Array.from(new Set([
            ...lastMediaRefs,
            ...this.extractMediaReferencesFromMessage(messageObj),
          ]));
          lastDirectMedia = this.dedupeMediaItems([
            ...lastDirectMedia,
            ...this.extractDirectMediaFromMessage(messageObj),
          ]);
          return;
        }
        if (state === "final") {
          const messageObj = toObject(payload.message);
          const finalTextRaw = this.extractChatText(messageObj) || lastDelta || lastAssistantText;
          const parsedText = this.parseMediaDirectivesFromText(finalTextRaw);
          const payloadRefs = [
            ...this.extractMediaReferencesFromMessage(payload),
            ...this.extractMediaReferencesFromMessage(messageObj),
            ...parsedText.mediaRefs,
            ...lastMediaRefs,
          ];
          const directMedia = [
            ...this.extractDirectMediaFromMessage(messageObj),
            ...lastDirectMedia,
          ];
          void this.resolveMediaReferences(payloadRefs, {
            workspaceDir: params.workspaceDir,
            homeDir: params.homeDir,
          }).then(async (resolvedMedia) => {
            let mergedMedia = this.dedupeMediaItems([...directMedia, ...resolvedMedia]);
            if (mergedMedia.length === 0) {
              const placeholderFallback = await this.resolveMediaPlaceholderFallback(finalTextRaw, {
                workspaceDir: params.workspaceDir,
                homeDir: params.homeDir,
                runStartedAtMs,
              });
              if (placeholderFallback.length > 0) {
                mergedMedia = this.dedupeMediaItems([...mergedMedia, ...placeholderFallback]);
              }
            }
            const fallbackText = (!parsedText.text && mergedMedia.length === 0 && /^\s*MEDIA\b/i.test(finalTextRaw))
              ? "(openclaw returned MEDIA placeholder without resolvable file)"
              : parsedText.text;
            done({
              text: fallbackText,
              media: mergedMedia,
            });
          }).catch((error) => {
            const msg = error instanceof Error ? error.message : String(error);
            fail(`openclaw media parse failed: ${msg}`);
          });
          return;
        }
        if (state === "error") {
          const errText = toString(payload.errorMessage).trim() || "unknown error";
          fail(`openclaw run failed: ${errText}`);
          return;
        }
        if (state === "aborted") {
          const reason = toString(payload.stopReason).trim() || "aborted";
          fail(`openclaw run aborted: ${reason}`);
        }
      });

      ws.once("error", (error) => {
        fail(`openclaw gateway websocket error: ${error.message}`);
      });
      ws.once("close", (code, reason) => {
        if (closed) {
          return;
        }
        const detail = reason.toString().trim();
        fail(`openclaw gateway closed (${code})${detail ? `: ${detail}` : ""}`);
      });
    });
  }

  private async ensureOpenClawEntry(): Promise<void> {
    if (this.distChecked) {
      return;
    }

    if (!fs.existsSync(this.config.openclawRoot)) {
      throw new Error(`openclaw root not found: ${this.config.openclawRoot}`);
    }
    if (!fs.existsSync(this.openclawEntryPath)) {
      throw new Error(`openclaw entry not found: ${this.openclawEntryPath}`);
    }

    let hasDist = this.distEntryCandidates.some((candidate) => fs.existsSync(candidate));
    if (!hasDist && this.config.autoBuildDist) {
      console.log("[gateway] openclaw dist missing. building dist with `pnpm exec tsdown --no-clean` ...");
      const build = await this.runCommand("pnpm", ["exec", "tsdown", "--no-clean"], {
        cwd: this.config.openclawRoot,
        timeoutMs: 20 * 60 * 1000,
      });
      if (build.code !== 0) {
        throw new Error(
          `failed to build openclaw dist: ${build.stderr.trim() || build.stdout.trim() || "unknown error"}`,
        );
      }
      hasDist = this.distEntryCandidates.some((candidate) => fs.existsSync(candidate));
    }

    if (!hasDist) {
      throw new Error(
        `openclaw dist is missing under ${path.join(this.config.openclawRoot, "dist")}. run "pnpm install && pnpm build:strict-smoke" in openclaw first.`,
      );
    }

    this.distChecked = true;
  }

  private async runCommand(
    command: string,
    args: string[],
    options?: {
      cwd?: string;
      env?: NodeJS.ProcessEnv;
      timeoutMs?: number;
    },
  ): Promise<CommandRunResult> {
    return await new Promise<CommandRunResult>((resolve) => {
      const child = spawn(command, args, {
        cwd: options?.cwd,
        env: options?.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let settled = false;
      const timeoutMs = options?.timeoutMs ?? 0;
      let timer: NodeJS.Timeout | undefined;

      const finalize = (result: CommandRunResult): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer) {
          clearTimeout(timer);
        }
        resolve(result);
      };

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          child.kill("SIGKILL");
          finalize({
            code: -1,
            stdout,
            stderr: `${stderr}\ncommand timeout after ${timeoutMs}ms`.trim(),
          });
        }, timeoutMs);
      }

      child.stdout.on("data", (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });
      child.once("error", (error) => {
        finalize({
          code: -1,
          stdout,
          stderr,
          spawnError: error,
        });
      });
      child.once("close", (code) => {
        finalize({
          code: typeof code === "number" ? code : -1,
          stdout,
          stderr,
        });
      });
    });
  }
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
  const rawNexChatBot = toObject(rawConfig.nexchatbot);
  const rawOpenClawBridge = toObject(rawConfig.openclawBridge);
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

  const nexChatBotEnabledFallback = toBoolean(process.env.TFCLAW_NEXCHATBOT_ENABLED, false);
  const nexChatBotBaseUrl = toString(rawNexChatBot.baseUrl, process.env.TFCLAW_NEXCHATBOT_BASE_URL ?? "http://127.0.0.1:8094");
  const nexChatBotRunPath = toString(rawNexChatBot.runPath, process.env.TFCLAW_NEXCHATBOT_RUN_PATH ?? "/v1/main-agent/feishu-bridge");
  const nexChatBotApiKey = toString(rawNexChatBot.apiKey, process.env.TFCLAW_NEXCHATBOT_API_KEY ?? "");
  const nexChatBotTimeoutMs = Math.max(
    1000,
    Math.min(10 * 60 * 1000, toNumber(rawNexChatBot.timeoutMs, toNumber(process.env.TFCLAW_NEXCHATBOT_TIMEOUT_MS, 90_000))),
  );

  const openclawRootFallback = path.resolve(
    toString(rawOpenClawBridge.openclawRoot, process.env.TFCLAW_OPENCLAW_ROOT ?? path.join(process.cwd(), "..", "openclaw")),
  );
  const openclawBridgeEnabledFallback = toBoolean(process.env.TFCLAW_OPENCLAW_ENABLED, false);
  const openclawSharedSkillsDirFallback = path.resolve(
    toString(
      rawOpenClawBridge.sharedSkillsDir,
      process.env.TFCLAW_OPENCLAW_SHARED_SKILLS_DIR ?? path.join(openclawRootFallback, "skills"),
    ),
  );
  const openclawUserHomeRootFallback = path.resolve(
    toString(
      rawOpenClawBridge.userHomeRoot,
      process.env.TFCLAW_OPENCLAW_USER_HOME_ROOT ??
        "/inspire/hdd/project/cq-scientific-cooperation-zone/ky26016/.home",
    ),
  );
  const openclawGatewayPortBase = Math.max(
    1025,
    Math.min(65535, toNumber(rawOpenClawBridge.gatewayPortBase, toNumber(process.env.TFCLAW_OPENCLAW_GATEWAY_PORT_BASE, 19000))),
  );
  const openclawGatewayPortMax = Math.max(
    openclawGatewayPortBase,
    Math.min(65535, toNumber(rawOpenClawBridge.gatewayPortMax, toNumber(process.env.TFCLAW_OPENCLAW_GATEWAY_PORT_MAX, 19999))),
  );
  const openclawStartupTimeoutMs = Math.max(
    1000,
    Math.min(10 * 60 * 1000, toNumber(rawOpenClawBridge.startupTimeoutMs, toNumber(process.env.TFCLAW_OPENCLAW_STARTUP_TIMEOUT_MS, 45_000))),
  );
  const openclawRequestTimeoutMs = Math.max(
    1000,
    Math.min(30 * 60 * 1000, toNumber(rawOpenClawBridge.requestTimeoutMs, toNumber(process.env.TFCLAW_OPENCLAW_REQUEST_TIMEOUT_MS, 180_000))),
  );

  const relayToken = toString(rawRelay.token, process.env.TFCLAW_TOKEN ?? "");
  if (!relayToken) {
    throw new Error("missing relay token. set relay.token in config.json or TFCLAW_TOKEN in env.");
  }

  const config: GatewayConfig = {
    relay: {
      token: relayToken,
      url: toString(rawRelay.url, process.env.TFCLAW_RELAY_URL ?? "ws://127.0.0.1:8787"),
    },
    nexchatbot: {
      enabled: toBoolean(rawNexChatBot.enabled, nexChatBotEnabledFallback),
      baseUrl: nexChatBotBaseUrl,
      runPath: nexChatBotRunPath,
      apiKey: nexChatBotApiKey,
      timeoutMs: nexChatBotTimeoutMs,
    },
    openclawBridge: {
      enabled: toBoolean(rawOpenClawBridge.enabled, openclawBridgeEnabledFallback),
      openclawRoot: openclawRootFallback,
      stateDir: path.resolve(
        toString(
          rawOpenClawBridge.stateDir,
          process.env.TFCLAW_OPENCLAW_STATE_DIR ?? path.join(process.cwd(), ".runtime", "openclaw_bridge"),
        ),
      ),
      sharedSkillsDir: openclawSharedSkillsDirFallback,
      userHomeRoot: openclawUserHomeRootFallback,
      userPrefix: toString(rawOpenClawBridge.userPrefix, process.env.TFCLAW_OPENCLAW_USER_PREFIX ?? "tfoc_"),
      tmuxSessionPrefix: toString(
        rawOpenClawBridge.tmuxSessionPrefix,
        process.env.TFCLAW_OPENCLAW_TMUX_SESSION_PREFIX ?? "tfoc-",
      ),
      gatewayHost: toString(rawOpenClawBridge.gatewayHost, process.env.TFCLAW_OPENCLAW_GATEWAY_HOST ?? "127.0.0.1"),
      gatewayPortBase: openclawGatewayPortBase,
      gatewayPortMax: openclawGatewayPortMax,
      startupTimeoutMs: openclawStartupTimeoutMs,
      requestTimeoutMs: openclawRequestTimeoutMs,
      sessionKey: toString(rawOpenClawBridge.sessionKey, process.env.TFCLAW_OPENCLAW_SESSION_KEY ?? "main"),
      nodePath: toString(rawOpenClawBridge.nodePath, process.env.TFCLAW_OPENCLAW_NODE_PATH ?? process.execPath),
      configTemplatePath: toString(
        rawOpenClawBridge.configTemplatePath,
        process.env.TFCLAW_OPENCLAW_CONFIG_TEMPLATE_PATH ?? "",
      ),
      autoBuildDist: toBoolean(
        rawOpenClawBridge.autoBuildDist,
        toBoolean(process.env.TFCLAW_OPENCLAW_AUTO_BUILD_DIST, false),
      ),
      allowAutoCreateUser: toBoolean(
        rawOpenClawBridge.allowAutoCreateUser,
        toBoolean(process.env.TFCLAW_OPENCLAW_ALLOW_AUTO_CREATE_USER, true),
      ),
      feishuAppId: toString(rawOpenClawBridge.feishuAppId, feishuAppId),
      feishuAppSecret: toString(rawOpenClawBridge.feishuAppSecret, feishuAppSecret),
      feishuVerificationToken: toString(
        rawOpenClawBridge.feishuVerificationToken,
        toString(rawFeishu.verificationToken, ""),
      ),
      feishuWebhookPortOffset: Math.max(
        100,
        Math.min(
          50000,
          toNumber(
            rawOpenClawBridge.feishuWebhookPortOffset,
            toNumber(process.env.TFCLAW_OPENCLAW_FEISHU_WEBHOOK_PORT_OFFSET, 20000),
          ),
        ),
      ),
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
class TfclawAccessManager {
  private readonly stateFilePath: string;
  private readonly superRootConfigPath: string;
  private readonly groupWorkspaceRoot: string;
  private lock: Promise<void> = Promise.resolve();

  constructor(stateDir: string) {
    const resolvedStateDir = path.resolve(stateDir);
    fs.mkdirSync(resolvedStateDir, { recursive: true });
    this.stateFilePath = path.join(resolvedStateDir, "access-control.json");
    this.superRootConfigPath = path.join(resolvedStateDir, "super-root.local.json");
    this.groupWorkspaceRoot = path.join(resolvedStateDir, "group_workspaces");
    fs.mkdirSync(this.groupWorkspaceRoot, { recursive: true });
  }

  private defaultState(): TfclawAccessStateFile {
    return {
      version: 1,
      admins: [],
      groups: {},
      aliases: {},
      userProfiles: {},
    };
  }

  private normalizeUserKey(value: string): string {
    return value.trim();
  }

  private normalizeGroupName(value: string): string {
    return value.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^\p{L}\p{N}_-]/gu, "");
  }

  private normalizeAlias(value: string): string {
    return value.trim().toLowerCase();
  }

  private normalizeDisplayName(value: string): string {
    return value.trim().replace(/\s+/g, " ");
  }

  private looksLikeFeishuUserIdentifier(value: string): boolean {
    return /^(?:ou|on|od|u)_[A-Za-z0-9]+$/i.test(value.trim());
  }

  private looksLikeLinuxUser(value: string): boolean {
    return /^tfoc_[a-f0-9]+$/i.test(value.trim());
  }

  private isDisplayNameAliasCandidate(value: string): boolean {
    const normalized = this.normalizeDisplayName(value);
    if (!normalized) {
      return false;
    }
    if (this.looksLikeFeishuUserIdentifier(normalized) || this.looksLikeLinuxUser(normalized)) {
      return false;
    }
    // Prefer true human-readable names as fallback display labels.
    if (/\p{Script=Han}/u.test(normalized)) {
      return true;
    }
    if (/[^\x00-\x7F]/.test(normalized)) {
      return true;
    }
    if (/\s/.test(normalized) && /[A-Za-z]/.test(normalized)) {
      return true;
    }
    // Allow simple English names like "fang", while still excluding opaque ids.
    if (/^[A-Za-z][A-Za-z'.-]{1,31}$/.test(normalized)) {
      return true;
    }
    return false;
  }

  private guessDisplayNameFromAliases(state: TfclawAccessStateFile, userKey: string): string | undefined {
    const normalizedUserKey = this.normalizeUserKey(userKey);
    if (!normalizedUserKey) {
      return undefined;
    }
    let best: string | undefined;
    for (const [alias, mappedUserKey] of Object.entries(state.aliases)) {
      if (this.normalizeUserKey(mappedUserKey) !== normalizedUserKey) {
        continue;
      }
      if (!this.isDisplayNameAliasCandidate(alias)) {
        continue;
      }
      const candidate = this.normalizeDisplayName(alias);
      if (!candidate) {
        continue;
      }
      if (!best || candidate.length < best.length) {
        best = candidate;
      }
    }
    return best;
  }

  private roleOf(state: TfclawAccessStateFile, userKey: string): TfclawUserRole {
    const normalized = this.normalizeUserKey(userKey);
    if (!normalized) {
      return "user";
    }
    if (state.superRootUserKey === normalized) {
      return "super_root";
    }
    if (state.admins.includes(normalized)) {
      return "admin";
    }
    return "user";
  }

  private ensureAbsoluteWorkspacePath(rawPath: string): string {
    const trimmed = rawPath.trim();
    if (!trimmed) {
      throw new Error("workspace path is required");
    }
    const resolved = path.resolve(trimmed);
    fs.mkdirSync(resolved, { recursive: true });
    return resolved;
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.lock;
    let release: (() => void) | undefined;
    this.lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release?.();
    }
  }

  private async loadState(): Promise<TfclawAccessStateFile> {
    if (!fs.existsSync(this.stateFilePath)) {
      return this.defaultState();
    }
    try {
      const parsed = toObject(JSON.parse(fs.readFileSync(this.stateFilePath, "utf8")));
      const admins = Array.isArray(parsed.admins)
        ? Array.from(new Set(parsed.admins.map((item) => this.normalizeUserKey(toString(item))).filter(Boolean)))
        : [];
      const aliasesObj = toObject(parsed.aliases);
      const aliases: Record<string, string> = {};
      for (const [rawAlias, rawUserKey] of Object.entries(aliasesObj)) {
        const alias = this.normalizeAlias(rawAlias);
        const userKey = this.normalizeUserKey(toString(rawUserKey));
        if (!alias || !userKey) {
          continue;
        }
        aliases[alias] = userKey;
      }
      const groupsObj = toObject(parsed.groups);
      const groups: Record<string, TfclawAccessGroup> = {};
      for (const [rawKey, rawValue] of Object.entries(groupsObj)) {
        const key = this.normalizeGroupName(rawKey);
        if (!key) {
          continue;
        }
        const value = toObject(rawValue);
        const members = Array.isArray(value.members)
          ? Array.from(new Set(value.members.map((item) => this.normalizeUserKey(toString(item))).filter(Boolean)))
          : [];
        const displayName = toString(value.displayName, key).trim() || key;
        const workspaceDir = this.ensureAbsoluteWorkspacePath(
          toString(value.workspaceDir, path.join(this.groupWorkspaceRoot, key)),
        );
        groups[key] = {
          name: key,
          displayName,
          scopeUserKey: toString(value.scopeUserKey, `group:${key}`).trim() || `group:${key}`,
          workspaceDir,
          members,
          createdAt: toString(value.createdAt, new Date().toISOString()),
          updatedAt: toString(value.updatedAt, new Date().toISOString()),
        };
      }
      const userProfilesObj = toObject(parsed.userProfiles);
      const userProfiles: Record<string, TfclawUserProfile> = {};
      for (const [rawUserKey, rawProfile] of Object.entries(userProfilesObj)) {
        const userKey = this.normalizeUserKey(rawUserKey);
        if (!userKey) {
          continue;
        }
        const profile = toObject(rawProfile);
        const displayName = this.normalizeDisplayName(toString(profile.displayName, toString(profile.name)));
        if (!displayName) {
          continue;
        }
        userProfiles[userKey] = {
          displayName,
          updatedAt: toString(profile.updatedAt, new Date().toISOString()),
        };
      }
      const state: TfclawAccessStateFile = {
        version: 1,
        superRootUserKey: this.normalizeUserKey(toString(parsed.superRootUserKey)),
        admins,
        groups,
        aliases,
        userProfiles,
      };
      if (state.superRootUserKey && state.admins.includes(state.superRootUserKey)) {
        state.admins = state.admins.filter((item) => item !== state.superRootUserKey);
      }
      return state;
    } catch {
      return this.defaultState();
    }
  }

  private async saveState(state: TfclawAccessStateFile): Promise<void> {
    fs.mkdirSync(path.dirname(this.stateFilePath), { recursive: true });
    fs.writeFileSync(this.stateFilePath, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  async getRole(userKey: string): Promise<TfclawUserRole> {
    const state = await this.loadState();
    return this.roleOf(state, userKey);
  }

  async getSuperRootUserKey(): Promise<string | undefined> {
    const state = await this.loadState();
    return state.superRootUserKey;
  }

  readConfiguredSuperRootIdentifier(): string | undefined {
    if (!fs.existsSync(this.superRootConfigPath)) {
      return undefined;
    }
    try {
      const parsed = toObject(JSON.parse(fs.readFileSync(this.superRootConfigPath, "utf8")));
      const configured = toString(parsed.superRoot, toString(parsed.super_root, toString(parsed.user))).trim();
      return configured || undefined;
    } catch {
      return undefined;
    }
  }

  async setSuperRootFromConfig(targetUserKey: string): Promise<void> {
    const target = this.normalizeUserKey(targetUserKey);
    if (!target) {
      return;
    }
    await this.withLock(async () => {
      const state = await this.loadState();
      state.superRootUserKey = target;
      state.admins = state.admins.filter((item) => item !== target);
      await this.saveState(state);
    });
  }

  async registerUserAliases(userKey: string, aliases: string[]): Promise<void> {
    const normalizedUserKey = this.normalizeUserKey(userKey);
    if (!normalizedUserKey) {
      return;
    }
    const normalizedAliases = Array.from(
      new Set(
        aliases
          .map((item) => this.normalizeAlias(item))
          .filter((item) => item.length > 0),
      ),
    );
    if (normalizedAliases.length === 0) {
      return;
    }
    await this.withLock(async () => {
      const state = await this.loadState();
      for (const alias of normalizedAliases) {
        state.aliases[alias] = normalizedUserKey;
      }
      await this.saveState(state);
    });
  }

  async registerUserDisplayName(userKey: string, displayName: string): Promise<void> {
    const normalizedUserKey = this.normalizeUserKey(userKey);
    const normalizedDisplayName = this.normalizeDisplayName(displayName);
    if (!normalizedUserKey || !normalizedDisplayName) {
      return;
    }
    await this.withLock(async () => {
      const state = await this.loadState();
      const existing = state.userProfiles[normalizedUserKey];
      if (existing?.displayName === normalizedDisplayName) {
        return;
      }
      state.userProfiles[normalizedUserKey] = {
        displayName: normalizedDisplayName,
        updatedAt: new Date().toISOString(),
      };
      await this.saveState(state);
    });
  }

  async getUserDisplayName(userKey: string): Promise<string | undefined> {
    const normalizedUserKey = this.normalizeUserKey(userKey);
    if (!normalizedUserKey) {
      return undefined;
    }
    const state = await this.loadState();
    return state.userProfiles[normalizedUserKey]?.displayName || this.guessDisplayNameFromAliases(state, normalizedUserKey);
  }

  async getUserDisplayNames(userKeys: string[]): Promise<Map<string, string>> {
    const state = await this.loadState();
    const output = new Map<string, string>();
    for (const rawUserKey of userKeys) {
      const userKey = this.normalizeUserKey(rawUserKey);
      if (!userKey) {
        continue;
      }
      const displayName = state.userProfiles[userKey]?.displayName || this.guessDisplayNameFromAliases(state, userKey);
      if (!displayName) {
        continue;
      }
      output.set(userKey, displayName);
    }
    return output;
  }

  async resolveUserAlias(input: string): Promise<string | undefined> {
    const alias = this.normalizeAlias(input);
    if (!alias) {
      return undefined;
    }
    const state = await this.loadState();
    return state.aliases[alias];
  }

  async setSuperRoot(requesterUserKey: string, targetUserKey: string): Promise<{ previous?: string; current: string }> {
    const requester = this.normalizeUserKey(requesterUserKey);
    const target = this.normalizeUserKey(targetUserKey);
    if (!target) {
      throw new Error("target user is required");
    }
    return await this.withLock(async () => {
      const state = await this.loadState();
      if (state.superRootUserKey && state.superRootUserKey !== requester) {
        throw new Error("only current super_root can change super_root");
      }
      const previous = state.superRootUserKey;
      state.superRootUserKey = target;
      state.admins = state.admins.filter((item) => item !== target);
      await this.saveState(state);
      return { previous, current: target };
    });
  }

  async setAdmin(requesterUserKey: string, targetUserKey: string, enabled: boolean): Promise<void> {
    const requester = this.normalizeUserKey(requesterUserKey);
    const target = this.normalizeUserKey(targetUserKey);
    if (!target) {
      throw new Error("target user is required");
    }
    return await this.withLock(async () => {
      const state = await this.loadState();
      if (state.superRootUserKey !== requester) {
        throw new Error("only super_root can manage admins");
      }
      if (target === state.superRootUserKey) {
        return;
      }
      if (enabled) {
        if (!state.admins.includes(target)) {
          state.admins.push(target);
        }
      } else {
        state.admins = state.admins.filter((item) => item !== target);
      }
      await this.saveState(state);
    });
  }

  async createGroup(
    requesterUserKey: string,
    displayName: string,
    workspacePath?: string,
  ): Promise<TfclawAccessGroup> {
    const requester = this.normalizeUserKey(requesterUserKey);
    const normalizedName = this.normalizeGroupName(displayName);
    if (!normalizedName) {
      throw new Error("group name is required");
    }
    return await this.withLock(async () => {
      const state = await this.loadState();
      const role = this.roleOf(state, requester);
      if (role === "user") {
        throw new Error("only admin/super_root can create groups");
      }
      if (state.groups[normalizedName]) {
        throw new Error(`group already exists: ${normalizedName}`);
      }
      const workspaceDir = this.ensureAbsoluteWorkspacePath(
        workspacePath?.trim() || path.join(this.groupWorkspaceRoot, normalizedName, "workspace"),
      );
      const now = new Date().toISOString();
      const group: TfclawAccessGroup = {
        name: normalizedName,
        displayName: displayName.trim() || normalizedName,
        scopeUserKey: `group:${normalizedName}`,
        workspaceDir,
        members: [requester],
        createdAt: now,
        updatedAt: now,
      };
      state.groups[normalizedName] = group;
      await this.saveState(state);
      return group;
    });
  }

  async setGroupWorkspace(
    requesterUserKey: string,
    groupName: string,
    workspacePath: string,
  ): Promise<TfclawAccessGroup> {
    const requester = this.normalizeUserKey(requesterUserKey);
    const normalizedName = this.normalizeGroupName(groupName);
    return await this.withLock(async () => {
      const state = await this.loadState();
      const role = this.roleOf(state, requester);
      if (role === "user") {
        throw new Error("only admin/super_root can set group workspace");
      }
      const group = state.groups[normalizedName];
      if (!group) {
        throw new Error(`group not found: ${normalizedName}`);
      }
      group.workspaceDir = this.ensureAbsoluteWorkspacePath(workspacePath);
      group.updatedAt = new Date().toISOString();
      await this.saveState(state);
      return group;
    });
  }

  async addGroupMember(
    requesterUserKey: string,
    groupName: string,
    targetUserKey: string,
  ): Promise<TfclawAccessGroup> {
    const requester = this.normalizeUserKey(requesterUserKey);
    const target = this.normalizeUserKey(targetUserKey);
    if (!target) {
      throw new Error("target user is required");
    }
    const normalizedName = this.normalizeGroupName(groupName);
    return await this.withLock(async () => {
      const state = await this.loadState();
      const role = this.roleOf(state, requester);
      if (role === "user") {
        throw new Error("only admin/super_root can add group members");
      }
      const group = state.groups[normalizedName];
      if (!group) {
        throw new Error(`group not found: ${normalizedName}`);
      }
      if (!group.members.includes(target)) {
        group.members.push(target);
      }
      group.updatedAt = new Date().toISOString();
      await this.saveState(state);
      return group;
    });
  }

  async removeGroupMember(
    requesterUserKey: string,
    groupName: string,
    targetUserKey: string,
  ): Promise<TfclawAccessGroup> {
    const requester = this.normalizeUserKey(requesterUserKey);
    const target = this.normalizeUserKey(targetUserKey);
    const normalizedName = this.normalizeGroupName(groupName);
    return await this.withLock(async () => {
      const state = await this.loadState();
      const role = this.roleOf(state, requester);
      if (role === "user") {
        throw new Error("only admin/super_root can remove group members");
      }
      const group = state.groups[normalizedName];
      if (!group) {
        throw new Error(`group not found: ${normalizedName}`);
      }
      group.members = group.members.filter((item) => item !== target);
      group.updatedAt = new Date().toISOString();
      await this.saveState(state);
      return group;
    });
  }

  async getGroup(groupName: string): Promise<TfclawAccessGroup | undefined> {
    const state = await this.loadState();
    const key = this.normalizeGroupName(groupName);
    return key ? state.groups[key] : undefined;
  }

  async getGroupForMember(groupName: string, userKey: string): Promise<TfclawAccessGroup | undefined> {
    const group = await this.getGroup(groupName);
    if (!group) {
      return undefined;
    }
    const normalizedUser = this.normalizeUserKey(userKey);
    if (!group.members.includes(normalizedUser)) {
      return undefined;
    }
    return group;
  }

  async listGroups(): Promise<TfclawAccessGroup[]> {
    const state = await this.loadState();
    return Object.values(state.groups).sort((a, b) => a.name.localeCompare(b.name));
  }

  async listGroupsForUser(userKey: string): Promise<TfclawAccessGroup[]> {
    const normalized = this.normalizeUserKey(userKey);
    const state = await this.loadState();
    return Object.values(state.groups)
      .filter((group) => group.members.includes(normalized))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async listUsersWithRoles(extraUserKeys: string[]): Promise<Array<{ userKey: string; role: TfclawUserRole }>> {
    const state = await this.loadState();
    const keys = new Set<string>();
    for (const item of extraUserKeys) {
      const key = this.normalizeUserKey(item);
      if (key) {
        keys.add(key);
      }
    }
    if (state.superRootUserKey) {
      keys.add(state.superRootUserKey);
    }
    for (const admin of state.admins) {
      keys.add(admin);
    }
    for (const group of Object.values(state.groups)) {
      for (const member of group.members) {
        keys.add(member);
      }
    }
    return Array.from(keys)
      .sort((a, b) => a.localeCompare(b))
      .map((userKey) => ({
        userKey,
        role: this.roleOf(state, userKey),
      }));
  }
}

// SECTION: router
class TfclawCommandRouter {
  private chatTerminalSelection = new Map<string, string>();
  private chatTmuxTarget = new Map<string, string>();
  private chatPassthroughEnabled = new Map<string, boolean>();
  private chatCaptureSelections = new Map<string, ChatCaptureSelection>();
  private chatOpenClawRouteScopes = new Map<string, OpenClawRouteScope>();
  private chatModes = new Map<string, ChatInteractionMode>();
  private groupMessageBuffer = new Map<string, GroupBufferedMessage[]>();
  private progressSessions = new Map<string, TerminalProgressSession>();
  private commandProgressSessions = new Map<string, CommandProgressSession>();
  private activeCommandRequestBySelection = new Map<string, string>();
  private readonly progressPollMs = 1200;
  private readonly groupBufferTtlMs = 30_000;
  private readonly groupBufferMaxPerSender = 10;
  private readonly progressRecallDelayMs = Math.max(
    80,
    Math.min(2000, toNumber(process.env.TFCLAW_PROGRESS_RECALL_DELAY_MS, 350)),
  );
  private readonly progressIdleTimeoutMs = 10 * 60 * 1000;
  private readonly progressMaxLifetimeMs = 30 * 60 * 1000;

  constructor(
    private readonly relay: RelayBridge,
    private readonly nexChatBridge: NexChatBridgeClient,
    private readonly openclawBridge: OpenClawPerUserBridge,
    private readonly accessManager: TfclawAccessManager,
  ) {}

  private selectionKey(channel: ChannelName, chatId: string, userKey?: string): string {
    if (!userKey) {
      return `${channel}:${chatId}`;
    }
    const normalized = userKey.trim() || "unknown";
    return `${channel}:${chatId}:${normalized}`;
  }

  private buildTmuxSessionKey(linuxUser: string, homeDir: string): string {
    const encodedHome = Buffer.from(homeDir, "utf8").toString("base64url");
    return `tfu:${linuxUser}|h:${encodedHome}`;
  }

  private async resolveUserScope(ctx: InboundTextContext): Promise<RouterUserScope> {
    const senderKey = this.senderBufferKey(ctx);
    const resolvedUserKey = this.openclawBridge.resolveUserKeyFromRequest({
      senderId: ctx.senderId,
      senderOpenId: ctx.senderOpenId,
      senderUserId: ctx.senderUserId,
    }) || senderKey;
    const actorRole = await this.accessManager.getRole(resolvedUserKey);
    try {
      const scope = await this.openclawBridge.resolveExecutionScope({
        senderId: ctx.senderId,
        senderOpenId: ctx.senderOpenId,
        senderUserId: ctx.senderUserId,
      });
      const tmuxSessionKey = actorRole === "admin" || actorRole === "super_root"
        ? this.buildTmuxSessionKey("root", "/")
        : this.buildTmuxSessionKey(scope.linuxUser, scope.homeDir);
      return {
        senderKey,
        userKey: scope.userKey || senderKey,
        linuxUser: scope.linuxUser,
        actorRole,
        tmuxSessionKey,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (senderKey !== "unknown") {
        console.warn(`[gateway] failed to resolve user scope for tmux control: ${msg}`);
      }
      const senderHash = createHash("sha1").update(senderKey || "unknown").digest("hex").slice(0, 12);
      const fallbackHome = `/tmp/tfclaw-unresolved-${senderHash}`;
      return {
        senderKey,
        userKey: resolvedUserKey || senderKey,
        linuxUser: "unknown",
        actorRole,
        tmuxSessionKey: this.buildTmuxSessionKey("tfclaw_nouser", fallbackHome),
      };
    }
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

  private isTmuxMode(selectionKey: string): boolean {
    const mode = this.getMode(selectionKey);
    const passthroughEnabled = Boolean(this.chatPassthroughEnabled.get(selectionKey));
    return mode === "terminal" || passthroughEnabled;
  }

  private senderBufferKey(ctx: InboundTextContext): string {
    return (ctx.senderUserId || ctx.senderOpenId || ctx.senderId || "unknown").trim() || "unknown";
  }

  private isGroupChat(ctx: InboundTextContext): boolean {
    return ctx.chatType.trim().toLowerCase() === "group";
  }

  private hasPendingCaptureSelection(selectionKey: string): boolean {
    return this.chatCaptureSelections.has(selectionKey);
  }

  private isTmuxControlCommand(text: string): boolean {
    const trimmed = text.trim().toLowerCase();
    if (!trimmed) {
      return false;
    }
    if (trimmed.startsWith("/tmux") || trimmed.startsWith("/passthrough") || trimmed.startsWith("/pt")) {
      return true;
    }
    const firstToken = trimmed.split(/\s+/, 1)[0] ?? "";
    return TMUX_SHORT_ALIAS_COMMANDS.has(firstToken);
  }

  private pruneGroupBuffer(selectionKey: string): void {
    const current = this.groupMessageBuffer.get(selectionKey);
    if (!current || current.length === 0) {
      return;
    }
    const now = Date.now();
    const next = current.filter((item) => now - item.at <= this.groupBufferTtlMs);
    if (next.length === 0) {
      this.groupMessageBuffer.delete(selectionKey);
      return;
    }
    if (next.length !== current.length) {
      this.groupMessageBuffer.set(selectionKey, next);
    }
  }

  private bufferGroupMessage(selectionKey: string, senderId: string, text: string): void {
    const content = text.trim();
    if (!content) {
      return;
    }

    this.pruneGroupBuffer(selectionKey);
    const list = this.groupMessageBuffer.get(selectionKey) ?? [];
    const last = list[list.length - 1];
    if (last && last.senderId === senderId && last.text === content) {
      return;
    }
    list.push({
      senderId,
      text: content,
      at: Date.now(),
    });

    let senderCount = 0;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      if (list[i]?.senderId !== senderId) {
        continue;
      }
      senderCount += 1;
      if (senderCount > this.groupBufferMaxPerSender) {
        list.splice(i, 1);
      }
    }

    this.groupMessageBuffer.set(selectionKey, list);
  }

  private consumeGroupBufferedMessages(selectionKey: string, senderId: string): string[] {
    this.pruneGroupBuffer(selectionKey);
    const list = this.groupMessageBuffer.get(selectionKey);
    if (!list || list.length === 0) {
      return [];
    }

    const mine: string[] = [];
    const others: GroupBufferedMessage[] = [];
    for (const item of list) {
      if (item.senderId === senderId) {
        mine.push(item.text);
      } else {
        others.push(item);
      }
    }

    if (others.length > 0) {
      this.groupMessageBuffer.set(selectionKey, others);
    } else {
      this.groupMessageBuffer.delete(selectionKey);
    }

    return mine;
  }

  private toHistorySeed(texts: string[]): HistorySeedEntry[] | undefined {
    if (!texts || texts.length === 0) {
      return undefined;
    }
    return texts
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => ({
        role: "user" as const,
        content: item,
      }));
  }

  private isTfclawPresetCommand(text: string, selectionKey?: string): boolean {
    const trimmed = text.trim();
    if (!trimmed) {
      return false;
    }

    const lowered = trimmed.toLowerCase();
    if (lowered.startsWith("/tmux") || lowered.startsWith("/passthrough") || lowered.startsWith("/pt")) {
      return true;
    }

    const firstToken = lowered.split(/\s+/, 1)[0] ?? "";
    if (TMUX_SHORT_ALIAS_COMMANDS.has(firstToken)) {
      return true;
    }

    if (trimmed.startsWith("/")) {
      return /^\/(?:tfhelp|tfstate|tflist|tfnew|tfcapture|tfattach|tfkey|tfctrlc|tfctrld|tfuse|tfclose)(?:\s+|$)/i.test(trimmed);
    }

    if (["help", "state", "list", "new", "capture", "ctrlc", "ctrld"].includes(lowered)) {
      return true;
    }
    if (/^(?:attach|key|use|close)\s+\S+/i.test(trimmed)) {
      return true;
    }

    const colonIndex = trimmed.indexOf(":");
    if (colonIndex > 0) {
      const maybeTerminalRef = trimmed.slice(0, colonIndex).trim();
      if (maybeTerminalRef && this.resolveTerminal(maybeTerminalRef, selectionKey)) {
        return true;
      }
    }

    return false;
  }

  private rewriteTfclawSlashCommandToLegacy(text: string): string {
    const trimmed = text.trim();
    if (!trimmed.startsWith("/")) {
      return text;
    }
    const firstSpace = trimmed.indexOf(" ");
    const token = (firstSpace < 0 ? trimmed : trimmed.slice(0, firstSpace)).toLowerCase();
    const args = firstSpace < 0 ? "" : trimmed.slice(firstSpace + 1).trim();
    const mapped = TFCLAW_SLASH_COMMAND_ALIAS_TO_LEGACY[token];
    if (!mapped) {
      return text;
    }
    return args ? `${mapped} ${args}` : mapped;
  }

  private normalizeTfclawCommandAlias(cmd: string): string {
    const lowered = cmd.trim().toLowerCase();
    switch (lowered) {
      case "tfhelp":
        return "help";
      case "tfstate":
        return "state";
      case "tflist":
        return "list";
      case "tfnew":
        return "new";
      case "tfcapture":
        return "capture";
      case "tfattach":
        return "attach";
      case "tfkey":
        return "key";
      case "tfctrlc":
        return "ctrlc";
      case "tfctrld":
        return "ctrld";
      case "tfuse":
        return "use";
      case "tfclose":
        return "close";
      default:
        return lowered;
    }
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

  private updateModeFromResult(selectionKey: string, rawCommand: string, output: string): void {
    const command = this.normalizeCommandLine(rawCommand);
    const target = this.extractTmuxTarget(output);
    if (target) {
      this.chatTmuxTarget.set(selectionKey, target);
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
    return this.rewriteTfclawHelpAliases(source);
  }

  private rewriteTfclawHelpAliases(output: string): string {
    if (!/tfclaw commands:/i.test(output)) {
      return output;
    }
    return output
      .replace(/\/help\b/g, "/tfhelp")
      .replace(/\/new\b/g, "/tfnew");
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

  private resolveTerminal(input: string, _selectionKey?: string): TerminalSummary | undefined {
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

  private firstActiveTerminal(_selectionKey?: string): TerminalSummary | undefined {
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
      "1) /tflist (or list) - list terminals",
      "2) /tfnew (or new) - create terminal",
      "3) /tfuse <id|title|index> - select terminal",
      "4) /tfattach [id|title|index] - enter terminal mode",
      "5) /tfclose <id|title|index> - close terminal",
      "6) /tfcapture - list screens/windows and choose by number",
      "7) reply number after /tfcapture - capture selected source",
      "8) <terminal-id>: <command> - run one command in specified terminal",
      "9) /tfstate - show current mode",
      "10) /tfkey <enter|tab|esc|ctrl+c|ctrl+d|ctrl+z|ctrl+letter> - send one key to terminal",
      "11) in terminal mode, use .tf <command> to run tfclaw commands",
      "12) /tfroot show - display super_root (set via local file only, /tfroot set disabled)",
      "13) /tfadmin list|add|remove ... - manage admin users (add/remove: super_root only)",
      "14) /tfusers - list all users and roles (admin/super_root)",
      "15) /tfgroup list|create|workspace|add|remove ... - manage groups",
      "16) /tfmode status|list|personal|group <groupName> - switch personal/group openclaw",
      "17) user target in /tfadmin add/remove and /tfgroup add/remove supports: feishuId | feishuName | linuxUser | me",
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

  private normalizeDisplayUserName(value: string): string {
    const trimmed = value.trim().replace(/\s+/g, " ");
    if (!trimmed) {
      return "";
    }
    if (this.looksLikeFeishuUserIdentifier(trimmed)) {
      return "";
    }
    if (/^tfoc_[a-f0-9]+$/i.test(trimmed)) {
      return "";
    }
    return trimmed;
  }

  private displayUserNameFromMap(userKey: string, nameMap: Map<string, string>): string {
    const displayName = this.normalizeDisplayUserName(nameMap.get(userKey) || "");
    if (displayName) {
      return displayName;
    }
    return "未登记姓名用户";
  }

  private async displayUserName(userKey: string): Promise<string> {
    const displayName = this.normalizeDisplayUserName(await this.accessManager.getUserDisplayName(userKey) || "");
    if (displayName) {
      return displayName;
    }
    return "未登记姓名用户";
  }

  private formatRole(role: TfclawUserRole): string {
    switch (role) {
      case "super_root":
        return "最高root";
      case "admin":
        return "管理员";
      default:
        return "普通用户";
    }
  }

  private normalizeTargetUserArg(arg: string, userScope: RouterUserScope): string {
    const normalized = arg.trim();
    if (!normalized) {
      return "";
    }
    const lowered = normalized.toLowerCase();
    if (lowered === "me" || lowered === "self" || lowered === "@me") {
      return userScope.userKey;
    }
    return normalized;
  }

  private looksLikeFeishuUserIdentifier(value: string): boolean {
    return /^(?:ou|on|od|u)_[A-Za-z0-9]+$/i.test(value.trim());
  }

  private async resolveTargetUserKey(arg: string, userScope: RouterUserScope): Promise<string | undefined> {
    const normalized = this.normalizeTargetUserArg(arg, userScope);
    if (!normalized) {
      return undefined;
    }
    const bindings = await this.openclawBridge.listUserBindings();
    const exactBinding = bindings.find((item) => item.userKey === normalized);
    if (exactBinding) {
      return exactBinding.userKey;
    }
    const linuxBinding = bindings.find((item) => item.linuxUser === normalized);
    if (linuxBinding) {
      return linuxBinding.userKey;
    }
    const aliasResolved = await this.accessManager.resolveUserAlias(normalized);
    if (aliasResolved) {
      return aliasResolved;
    }
    if (this.looksLikeFeishuUserIdentifier(normalized)) {
      return normalized;
    }
    return undefined;
  }

  private async resolveOpenClawRouteScope(
    selectionKey: string,
    userScope: RouterUserScope,
  ): Promise<OpenClawRouteScope> {
    const selected = this.chatOpenClawRouteScopes.get(selectionKey);
    const personalLabel = await this.displayUserName(userScope.userKey);
    if (!selected || selected.kind === "personal") {
      return {
        kind: "personal",
        modeLabel: personalLabel,
        routingUserKey: userScope.userKey,
      };
    }
    const group = await this.accessManager.getGroupForMember(selected.modeLabel, userScope.userKey);
    if (!group) {
      this.chatOpenClawRouteScopes.delete(selectionKey);
      return {
        kind: "personal",
        modeLabel: personalLabel,
        routingUserKey: userScope.userKey,
      };
    }
    return {
      kind: "group",
      modeLabel: group.displayName,
      routingUserKey: group.scopeUserKey,
      workspaceOverrideDir: group.workspaceDir,
    };
  }

  private toAgentRouteOptions(route: OpenClawRouteScope): {
    routingUserKey?: string;
    workspaceOverrideDir?: string;
    modeLabel?: string;
  } {
    return {
      routingUserKey: route.routingUserKey,
      workspaceOverrideDir: route.workspaceOverrideDir,
      modeLabel: route.kind === "group" ? route.modeLabel : route.modeLabel,
    };
  }

  private async handleAccessControlCommand(
    ctx: InboundTextContext,
    selectionKey: string,
    userScope: RouterUserScope,
    text: string,
  ): Promise<boolean> {
    const trimmed = text.trim();
    if (!trimmed.startsWith("/")) {
      return false;
    }
    const body = trimmed.slice(1).trim();
    if (!body) {
      return false;
    }
    const [cmdRaw, ...rest] = body.split(/\s+/);
    const cmd = (cmdRaw ?? "").toLowerCase();
    const argsText = rest.join(" ").trim();

    if (cmd === "tfroot") {
      const [actionRaw] = argsText.split(/\s+/, 2);
      const action = (actionRaw ?? "show").toLowerCase();
      if (action === "show" || action === "who" || action === "status") {
        const rootUser = await this.accessManager.getSuperRootUserKey();
        const rootDisplayName = rootUser ? await this.displayUserName(rootUser) : "";
        await this.replyWithMode(
          ctx.chatId,
          ctx.responder,
          selectionKey,
          rootUser ? `super_root: ${rootDisplayName}` : "super_root: (unset)",
        );
        return true;
      }
      await this.replyWithMode(
        ctx.chatId,
        ctx.responder,
        selectionKey,
        "tfroot set is disabled. configure super_root in local file: <stateDir>/super-root.local.json",
      );
      return true;
    }

    if (cmd === "tfadmin") {
      const [actionRaw, targetRaw] = argsText.split(/\s+/, 2);
      const action = (actionRaw ?? "").toLowerCase();
      if (action === "list" || action === "users" || action === "status") {
        if (userScope.actorRole === "user") {
          await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, "permission denied: admin/super_root only");
          return true;
        }
        const bindings = await this.openclawBridge.listUserBindings();
        const roles = await this.accessManager.listUsersWithRoles(bindings.map((item) => item.userKey));
        const displayNames = await this.accessManager.getUserDisplayNames(roles.map((item) => item.userKey));
        const lines = roles.map((item) => `- ${this.displayUserNameFromMap(item.userKey, displayNames)} | ${this.formatRole(item.role)}`);
        await this.replyWithMode(
          ctx.chatId,
          ctx.responder,
          selectionKey,
          lines.length > 0 ? `system users:\n${lines.join("\n")}` : "system users: (none)",
        );
        return true;
      }
      if (action === "add" || action === "remove") {
        const targetUser = await this.resolveTargetUserKey(targetRaw ?? "", userScope);
        if (!targetUser) {
          await this.replyWithMode(
            ctx.chatId,
            ctx.responder,
            selectionKey,
            "usage: /tfadmin add|remove <feishuId|feishuName|linuxUser|me>",
          );
          return true;
        }
        try {
          await this.accessManager.setAdmin(userScope.userKey, targetUser, action === "add");
          const targetDisplayName = await this.displayUserName(targetUser);
          await this.replyWithMode(
            ctx.chatId,
            ctx.responder,
            selectionKey,
            `${action === "add" ? "admin granted" : "admin revoked"}: ${targetDisplayName}`,
          );
        } catch (error) {
          await this.replyWithMode(
            ctx.chatId,
            ctx.responder,
            selectionKey,
            `tfadmin failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return true;
      }
      await this.replyWithMode(
        ctx.chatId,
        ctx.responder,
        selectionKey,
        "usage: /tfadmin list | /tfadmin add <feishuId|feishuName|linuxUser> | /tfadmin remove <feishuId|feishuName|linuxUser>",
      );
      return true;
    }

    if (cmd === "tfusers") {
      if (userScope.actorRole === "user") {
        await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, "permission denied: admin/super_root only");
        return true;
      }
      const bindings = await this.openclawBridge.listUserBindings();
      const roles = await this.accessManager.listUsersWithRoles(bindings.map((item) => item.userKey));
      const displayNames = await this.accessManager.getUserDisplayNames(roles.map((item) => item.userKey));
      const rows = roles.map((item) =>
        `- ${this.displayUserNameFromMap(item.userKey, displayNames)} | ${this.formatRole(item.role)}`);
      await this.replyWithMode(
        ctx.chatId,
        ctx.responder,
        selectionKey,
        rows.length > 0 ? `system users:\n${rows.join("\n")}` : "system users: (none)",
      );
      return true;
    }

    if (cmd === "tfgroup") {
      const [actionRaw, ...restArgs] = argsText.split(/\s+/);
      const action = (actionRaw ?? "").toLowerCase();
      if (action === "list" || action === "ls") {
        const role = userScope.actorRole;
        const groups = role === "user"
          ? await this.accessManager.listGroupsForUser(userScope.userKey)
          : await this.accessManager.listGroups();
        if (groups.length === 0) {
          await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, "groups: (none)");
          return true;
        }
        const lines = groups.map((group) =>
          `- ${group.displayName} (${group.name}) | members=${group.members.length} | workspace=${group.workspaceDir}`);
        await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, `groups:\n${lines.join("\n")}`);
        return true;
      }

      if (action === "create") {
        const groupName = restArgs[0] ?? "";
        const workspacePath = restArgs.slice(1).join(" ").trim();
        if (!groupName) {
          await this.replyWithMode(
            ctx.chatId,
            ctx.responder,
            selectionKey,
            "usage: /tfgroup create <groupName> [workspacePath]",
          );
          return true;
        }
        try {
          const group = await this.accessManager.createGroup(userScope.userKey, groupName, workspacePath || undefined);
          await this.openclawBridge.resolveExecutionScope({
            routingUserKey: group.scopeUserKey,
            senderId: undefined,
            senderOpenId: undefined,
            senderUserId: undefined,
          });
          await this.replyWithMode(
            ctx.chatId,
            ctx.responder,
            selectionKey,
            `group created: ${group.displayName} (${group.name})\nworkspace: ${group.workspaceDir}`,
          );
        } catch (error) {
          await this.replyWithMode(
            ctx.chatId,
            ctx.responder,
            selectionKey,
            `tfgroup create failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return true;
      }

      if (action === "workspace" || action === "set-workspace") {
        const groupName = restArgs[0] ?? "";
        const workspacePath = restArgs.slice(1).join(" ").trim();
        if (!groupName || !workspacePath) {
          await this.replyWithMode(
            ctx.chatId,
            ctx.responder,
            selectionKey,
            "usage: /tfgroup workspace <groupName> <workspacePath>",
          );
          return true;
        }
        try {
          const group = await this.accessManager.setGroupWorkspace(userScope.userKey, groupName, workspacePath);
          await this.replyWithMode(
            ctx.chatId,
            ctx.responder,
            selectionKey,
            `group workspace updated: ${group.displayName}\nworkspace: ${group.workspaceDir}`,
          );
        } catch (error) {
          await this.replyWithMode(
            ctx.chatId,
            ctx.responder,
            selectionKey,
            `tfgroup workspace failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return true;
      }

      if (action === "add" || action === "remove") {
        const groupName = restArgs[0] ?? "";
        const targetUser = await this.resolveTargetUserKey(restArgs[1] ?? "", userScope);
        if (!groupName || !targetUser) {
          await this.replyWithMode(
            ctx.chatId,
            ctx.responder,
            selectionKey,
            "usage: /tfgroup add|remove <groupName> <feishuId|feishuName|linuxUser|me>",
          );
          return true;
        }
        try {
          const group = action === "add"
            ? await this.accessManager.addGroupMember(userScope.userKey, groupName, targetUser)
            : await this.accessManager.removeGroupMember(userScope.userKey, groupName, targetUser);
          const targetDisplayName = await this.displayUserName(targetUser);
          await this.replyWithMode(
            ctx.chatId,
            ctx.responder,
            selectionKey,
            `group ${action === "add" ? "member added" : "member removed"}: ${group.displayName}\nmember: ${targetDisplayName}`,
          );
        } catch (error) {
          await this.replyWithMode(
            ctx.chatId,
            ctx.responder,
            selectionKey,
            `tfgroup ${action} failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return true;
      }

      await this.replyWithMode(
        ctx.chatId,
        ctx.responder,
        selectionKey,
        [
          "usage:",
          "/tfgroup list",
          "/tfgroup create <groupName> [workspacePath]",
          "/tfgroup workspace <groupName> <workspacePath>",
          "/tfgroup add <groupName> <feishuId|feishuName|linuxUser>",
          "/tfgroup remove <groupName> <feishuId|feishuName|linuxUser>",
        ].join("\n"),
      );
      return true;
    }

    if (cmd === "tfmode") {
      const [actionRaw, ...restArgs] = argsText.split(/\s+/);
      const action = (actionRaw ?? "status").toLowerCase();
      if (action === "status" || action === "show") {
        const mode = await this.resolveOpenClawRouteScope(selectionKey, userScope);
        await this.replyWithMode(
          ctx.chatId,
          ctx.responder,
          selectionKey,
          `openclaw mode: ${mode.kind === "group" ? `group:${mode.modeLabel}` : `user:${mode.modeLabel}`}`,
        );
        return true;
      }
      if (action === "list") {
        const groups = await this.accessManager.listGroupsForUser(userScope.userKey);
        const lines = groups.map((group) => `- ${group.displayName} (${group.name})`);
        await this.replyWithMode(
          ctx.chatId,
          ctx.responder,
          selectionKey,
          lines.length > 0 ? `your groups:\n${lines.join("\n")}` : "your groups: (none)",
        );
        return true;
      }
      if (action === "personal" || action === "user") {
        this.chatOpenClawRouteScopes.delete(selectionKey);
        const selfDisplayName = await this.displayUserName(userScope.userKey);
        await this.replyWithMode(
          ctx.chatId,
          ctx.responder,
          selectionKey,
          `openclaw mode switched: user:${selfDisplayName}`,
        );
        return true;
      }
      if (action === "group") {
        const groupName = restArgs[0] ?? "";
        if (!groupName) {
          await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, "usage: /tfmode group <groupName>");
          return true;
        }
        const group = await this.accessManager.getGroupForMember(groupName, userScope.userKey);
        if (!group) {
          await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, `group unavailable: ${groupName}`);
          return true;
        }
        this.chatOpenClawRouteScopes.set(selectionKey, {
          kind: "group",
          modeLabel: group.name,
          routingUserKey: group.scopeUserKey,
          workspaceOverrideDir: group.workspaceDir,
        });
        await this.replyWithMode(
          ctx.chatId,
          ctx.responder,
          selectionKey,
          `openclaw mode switched: group:${group.displayName}`,
        );
        return true;
      }
      await this.replyWithMode(
        ctx.chatId,
        ctx.responder,
        selectionKey,
        "usage: /tfmode status|list|personal|group <groupName>",
      );
      return true;
    }

    return false;
  }

  private async handleTfclawCommand(
    ctx: InboundTextContext,
    selectionKey: string,
    cmd: string,
    args: string,
  ): Promise<boolean> {
    cmd = this.normalizeTfclawCommandAlias(cmd);
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
      await this.handleCaptureList(selectionKey, ctx.chatId, ctx.responder);
      return true;
    }

    if (cmd === "attach") {
      await this.enterTerminalMode(ctx, selectionKey, args || undefined);
      return true;
    }

    if (cmd === "key") {
      if (!args) {
        await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, this.keyUsageText("/tfkey"));
        return true;
      }
      const selected = this.selectedTerminal(selectionKey, true) ?? this.firstActiveTerminal(selectionKey);
      if (!selected) {
        await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, "no active terminal. use /tfnew then /tfattach.");
        return true;
      }
      this.chatTerminalSelection.set(selectionKey, selected.terminalId);
      await this.sendKeyToTerminal(ctx, selectionKey, selected, args, "/tfkey");
      return true;
    }

    if (cmd === "ctrlc" || cmd === "ctrld") {
      const selected = this.selectedTerminal(selectionKey, true);
      if (!selected) {
        await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, "no selected terminal. use /tflist then /tfuse <id>");
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
        await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, "usage: /tfuse <id|title|index>");
        return true;
      }
      const terminal = this.resolveTerminal(args, selectionKey);
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
        await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, "usage: /tfclose <id|title|index>");
        return true;
      }
      const terminal = this.resolveTerminal(key, selectionKey);
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
      terminal = this.resolveTerminal(requestedRef, selectionKey);
      if (!terminal) {
        await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, `terminal not found: ${requestedRef}`);
        return;
      }
      if (!terminal.isActive) {
        await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, `terminal is closed: ${terminal.title}`);
        return;
      }
    } else {
      terminal = this.selectedTerminal(selectionKey, true) ?? this.firstActiveTerminal(selectionKey);
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
        "no active terminal found. use /tfnew first, then /tfattach.",
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
    selectionKey: string,
    chatId: string,
    line: string,
    responder: MessageResponder,
  ): Promise<boolean> {
    const key = selectionKey;
    const selection = this.chatCaptureSelections.get(key);
    if (!selection) {
      return false;
    }

    const age = Date.now() - selection.createdAt;
    if (age > 2 * 60 * 1000) {
      this.chatCaptureSelections.delete(key);
      await this.replyWithMode(chatId, responder, key, "capture selection expired. send /tfcapture again.");
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

  private async handleCaptureList(selectionKey: string, chatId: string, responder: MessageResponder): Promise<void> {
    const requestId = this.relay.command({
      command: "capture.list",
    });

    let sources: CaptureSource[];
    try {
      sources = await this.relay.waitForCaptureSources(requestId, 15000);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await this.replyWithMode(chatId, responder, selectionKey, `failed to list capture sources: ${msg}`);
      return;
    }

    if (sources.length === 0) {
      await this.replyWithMode(chatId, responder, selectionKey, "no capture sources found.");
      return;
    }

    const key = selectionKey;
    this.chatCaptureSelections.set(key, {
      options: sources,
      terminalId: this.chatTerminalSelection.get(key),
      createdAt: Date.now(),
    });

    await this.replyWithMode(chatId, responder, key, this.formatCaptureOptions(sources));
  }

  private async executeTfclawCommandRequest(
    ctx: InboundTextContext,
    selectionKey: string,
    outboundText: string,
    tmuxSessionKey: string,
  ): Promise<void> {
    const requestId = this.relay.command({
      command: "tfclaw.command",
      text: outboundText,
      sessionKey: tmuxSessionKey,
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
    } finally {
      this.stopCommandProgressSession(requestId, false);
    }
  }

  private async routeToNexChatBot(
    ctx: InboundTextContext,
    selectionKey: string,
    options?: { text?: string; historySeed?: HistorySeedEntry[] },
  ): Promise<void> {
    if (!this.nexChatBridge.enabled) {
      await this.replyWithMode(
        ctx.chatId,
        ctx.responder,
        selectionKey,
        "nexchatbot bridge is disabled. set `nexchatbot.enabled=true` and `nexchatbot.baseUrl` in gateway config.",
      );
      return;
    }

    try {
      const text = (options?.text ?? ctx.llmText ?? ctx.text).trim();
      const reply = await this.nexChatBridge.run({
        source: "tfclaw_feishu_gateway",
        channel: ctx.channel,
        selectionKey,
        chatId: ctx.chatId,
        senderId: ctx.senderId,
        senderOpenId: ctx.senderOpenId,
        senderUserId: ctx.senderUserId,
        messageId: ctx.messageId,
        eventId: ctx.eventId,
        messageType: ctx.messageType,
        text,
        contentRaw: ctx.contentRaw,
        contentObj: ctx.contentObj,
        feishuEvent: ctx.rawEvent,
        historySeed: options?.historySeed,
      });
      await ctx.responder.replyText(ctx.chatId, reply);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, `nexchatbot bridge failed: ${message}`);
    }
  }

  private async routeToOpenClaw(
    ctx: InboundTextContext,
    selectionKey: string,
    options?: {
      text?: string;
      historySeed?: HistorySeedEntry[];
      routingUserKey?: string;
      workspaceOverrideDir?: string;
      modeLabel?: string;
    },
  ): Promise<void> {
    if (!this.openclawBridge.enabled) {
      await this.replyWithMode(
        ctx.chatId,
        ctx.responder,
        selectionKey,
        "openclaw bridge is disabled. set `openclawBridge.enabled=true` and `openclawBridge.openclawRoot` in gateway config.",
      );
      return;
    }

    try {
      const text = (options?.text ?? ctx.llmText ?? ctx.text).trim();
      const reply = await this.openclawBridge.run({
        source: "tfclaw_feishu_gateway",
        channel: ctx.channel,
        selectionKey,
        chatId: ctx.chatId,
        senderId: ctx.senderId,
        senderOpenId: ctx.senderOpenId,
        senderUserId: ctx.senderUserId,
        messageId: ctx.messageId,
        eventId: ctx.eventId,
        messageType: ctx.messageType,
        text,
        historySeed: options?.historySeed,
        attachments: ctx.attachments,
        routingUserKey: options?.routingUserKey,
        workspaceOverrideDir: options?.workspaceOverrideDir,
      });
      const normalizedText = reply.text.trim();
      const modeLabel = (options?.modeLabel || options?.routingUserKey || "user").trim();
      const modeHeader = `mode:${modeLabel}`;
      let sentModeHeader = false;
      if (normalizedText) {
        await ctx.responder.replyText(ctx.chatId, `${modeHeader}\n${normalizedText}`);
        sentModeHeader = true;
      } else if (reply.media.length > 0) {
        await ctx.responder.replyText(ctx.chatId, modeHeader);
        sentModeHeader = true;
      }

      for (const media of reply.media) {
        const mediaBase64 = media.contentBase64.trim();
        if (!mediaBase64) {
          continue;
        }
        const decoded = Buffer.from(mediaBase64, "base64");
        if (decoded.byteLength === 0) {
          continue;
        }

        const shouldSendAsImage = media.kind === "image" && decoded.byteLength <= FEISHU_MAX_IMAGE_BYTES;
        if (shouldSendAsImage) {
          await ctx.responder.replyImage(ctx.chatId, mediaBase64);
          continue;
        }

        if (typeof ctx.responder.replyFile === "function") {
          await ctx.responder.replyFile(
            ctx.chatId,
            mediaBase64,
            media.fileName || `openclaw-${Date.now()}.bin`,
            media.mimeType,
          );
          continue;
        }

        await ctx.responder.replyText(
          ctx.chatId,
          `[openclaw media] ${media.fileName || "attachment"} (${media.mimeType || "application/octet-stream"})`,
        );
      }

      if (!normalizedText && reply.media.length === 0) {
        await ctx.responder.replyText(
          ctx.chatId,
          sentModeHeader ? "(openclaw returned empty reply)" : `${modeHeader}\n(openclaw returned empty reply)`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.replyWithMode(ctx.chatId, ctx.responder, selectionKey, `openclaw bridge failed: ${message}`);
    }
  }

  private async routeToAgentBridge(
    ctx: InboundTextContext,
    selectionKey: string,
    options?: {
      text?: string;
      historySeed?: HistorySeedEntry[];
      routingUserKey?: string;
      workspaceOverrideDir?: string;
      modeLabel?: string;
    },
  ): Promise<void> {
    if (this.openclawBridge.enabled) {
      await this.routeToOpenClaw(ctx, selectionKey, options);
      return;
    }
    await this.routeToNexChatBot(ctx, selectionKey, options);
  }

  async handleInboundMessage(ctx: InboundTextContext): Promise<void> {
    if (ctx.allowFrom.length > 0 && (!ctx.senderId || !ctx.allowFrom.includes(ctx.senderId))) {
      await ctx.responder.replyText(ctx.chatId, "not allowed");
      return;
    }

    const userScope = await this.resolveUserScope(ctx);
    await this.accessManager.registerUserAliases(userScope.userKey, [
      ctx.senderOpenId || "",
      ctx.senderUserId || "",
      ctx.senderId || "",
      ctx.senderName || "",
      userScope.linuxUser || "",
    ]);
    await this.accessManager.registerUserDisplayName(userScope.userKey, ctx.senderName || "");
    for (const mention of ctx.mentions ?? []) {
      const mentionUserKey = (mention.openId || mention.userId || "").trim();
      if (!mentionUserKey) {
        continue;
      }
      await this.accessManager.registerUserAliases(mentionUserKey, [
        mention.name || "",
        mention.openId || "",
        mention.userId || "",
      ]);
      await this.accessManager.registerUserDisplayName(mentionUserKey, mention.name || "");
    }
    const selectionKey = this.selectionKey(ctx.channel, ctx.chatId, userScope.userKey);
    const isGroupChat = this.isGroupChat(ctx);
    const senderBufferKey = userScope.senderKey;
    const isTmuxMode = this.isTmuxMode(selectionKey);
    let text = ctx.text.replace(/\r/g, "").trim();
    let llmText = (ctx.llmText || text).replace(/\r/g, "").trim();

    const allowGroupMessageWithoutMention = this.hasPendingCaptureSelection(selectionKey);

    if (isGroupChat && !ctx.isMentioned && !allowGroupMessageWithoutMention) {
      const buffered = llmText || text;
      if (buffered) {
        this.bufferGroupMessage(selectionKey, senderBufferKey, buffered);
      }
      if (FEISHU_DEBUG_INBOUND) {
        console.log(
          `[gateway] group message buffered (not mentioned): chat_id=${ctx.chatId} sender=${senderBufferKey} mode=${isTmuxMode ? "tmux" : "tfclaw"} text=${JSON.stringify((buffered || "").slice(0, 160))}`,
        );
      }
      return;
    }

    if (isTmuxMode && ctx.messageType !== "text") {
      await this.replyWithMode(
        ctx.chatId,
        ctx.responder,
        selectionKey,
        `tmux mode only accepts text. current message_type=${ctx.messageType || "unknown"}`,
      );
      return;
    }

    if (ctx.messageType !== "text") {
      const routeScope = await this.resolveOpenClawRouteScope(selectionKey, userScope);
      await this.routeToAgentBridge(
        ctx,
        selectionKey,
        this.toAgentRouteOptions(routeScope),
      );
      return;
    }

    if (!text) {
      if (!isGroupChat || !ctx.isMentioned) {
        return;
      }
      const bufferedTexts = this.consumeGroupBufferedMessages(selectionKey, senderBufferKey);
      const fallbackText = (llmText || bufferedTexts[bufferedTexts.length - 1] || "").trim();
      if (!fallbackText) {
        await this.replyWithMode(
          ctx.chatId,
          ctx.responder,
          selectionKey,
          "我收到了 @，但没有识别到具体指令。请直接发送要执行的任务。",
        );
        return;
      }
      await this.routeToAgentBridge(
        {
          ...ctx,
          text: fallbackText,
          llmText: fallbackText,
        },
        selectionKey,
        {
          text: fallbackText,
          historySeed: this.toHistorySeed(bufferedTexts),
          ...this.toAgentRouteOptions(await this.resolveOpenClawRouteScope(selectionKey, userScope)),
        },
      );
      return;
    }

    const accessCommandConsumed = await this.handleAccessControlCommand(ctx, selectionKey, userScope, text);
    if (accessCommandConsumed) {
      return;
    }

    const captureSelectionConsumed = await this.handleCaptureSelection(
      selectionKey,
      ctx.chatId,
      text,
      ctx.responder,
    );
    if (captureSelectionConsumed) {
      return;
    }

    const lowered = text.toLowerCase();
    if (lowered === "/tfcapture" || lowered === "capture") {
      await this.handleCaptureList(selectionKey, ctx.chatId, ctx.responder);
      return;
    }

    if (!isTmuxMode && !this.isTfclawPresetCommand(text, selectionKey)) {
      const bufferedTexts = isGroupChat ? this.consumeGroupBufferedMessages(selectionKey, senderBufferKey) : [];
      const nexchatText = (llmText || text).trim();
      await this.routeToAgentBridge(
        {
          ...ctx,
          text: nexchatText,
          llmText: nexchatText,
        },
        selectionKey,
        {
          text: nexchatText,
          historySeed: this.toHistorySeed(bufferedTexts),
          ...this.toAgentRouteOptions(await this.resolveOpenClawRouteScope(selectionKey, userScope)),
        },
      );
      return;
    }

    const isSlashCommand = text.startsWith("/");
    const isDotControl = text.startsWith(".");
    const outboundTextRaw = isTmuxMode && !isSlashCommand && !isDotControl ? `/tmux send ${text}` : text;
    const outboundText = this.rewriteTfclawSlashCommandToLegacy(outboundTextRaw);
    await this.executeTfclawCommandRequest(ctx, selectionKey, outboundText, userScope.tmuxSessionKey);
  }
}
// SECTION: chat apps
class FeishuChatApp implements ChatApp, MessageResponder {
  readonly name = "feishu";
  readonly enabled: boolean;
  private wsClient: Lark.WSClient | undefined;
  private larkClient: Lark.Client | undefined;
  private botOpenId = "";
  private botName = "";
  private readonly recentInboundKeys = new Map<string, number>();
  private readonly inboundDedupTtlMs = 5 * 60 * 1000;
  private readonly userNameCache = new Map<string, { name: string; expiresAt: number }>();
  private readonly chatInfoCache = new Map<string, { displayName: string; userCount: number; expiresAt: number }>();
  private readonly systemSenderNameCache = new Map<string, { senderOpenId: string; displayName: string; expiresAt: number }>();
  private readonly ownerDisplayNameByOpenId = new Map<string, string>();
  private ownerDisplayNameIndexExpiresAt = 0;
  private readonly userNameCacheHitTtlMs = 24 * 60 * 60 * 1000;
  private readonly userNameCacheMissTtlMs = 5 * 60 * 1000;
  private readonly chatInfoCacheTtlMs = 10 * 60 * 1000;
  private readonly ownerDisplayNameIndexTtlMs = 10 * 60 * 1000;
  private readonly systemSenderNameCacheTtlMs = 10 * 60 * 1000;

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
    await this.initBotIdentity();

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
          await this.handleInboundEvent(data);
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

  private async parseJsonResponse(response: { text: () => Promise<string> }): Promise<Record<string, unknown>> {
    const raw = await response.text();
    if (!raw) {
      return {};
    }
    try {
      return toObject(JSON.parse(raw));
    } catch {
      return {};
    }
  }

  private async initBotIdentity(): Promise<void> {
    const envOpenId = toString(process.env.BOT_OPEN_ID).trim();
    const envName = toString(process.env.BOT_NAME).trim();
    if (envOpenId) {
      this.botOpenId = envOpenId;
    }
    if (envName) {
      this.botName = envName;
    }

    try {
      const authResponse = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          app_id: this.config.appId,
          app_secret: this.config.appSecret,
        }),
      });
      const authPayload = await this.parseJsonResponse(authResponse);
      if (!authResponse.ok || toNumber(authPayload.code, -1) !== 0) {
        throw new Error(`auth failed: code=${toString(authPayload.code, "unknown")} msg=${toString(authPayload.msg, "")}`);
      }
      const tenantToken = toString(authPayload.tenant_access_token).trim();
      if (!tenantToken) {
        throw new Error("tenant_access_token is empty");
      }

      const botResponse = await fetch("https://open.feishu.cn/open-apis/bot/v3/info", {
        method: "GET",
        headers: {
          authorization: `Bearer ${tenantToken}`,
        },
      });
      const botPayload = await this.parseJsonResponse(botResponse);
      if (!botResponse.ok || toNumber(botPayload.code, -1) !== 0) {
        throw new Error(`bot info failed: code=${toString(botPayload.code, "unknown")} msg=${toString(botPayload.msg, "")}`);
      }
      const botObj = toObject(botPayload.bot);
      const openId = toString(botObj.open_id).trim();
      const name = toString(botObj.app_name, toString(botObj.name)).trim();
      if (openId) {
        this.botOpenId = openId;
      }
      if (name) {
        this.botName = name;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn(`[gateway] failed to init bot identity via api: ${msg}`);
    }

    if (this.botOpenId || this.botName) {
      console.log(`[gateway] bot identity: open_id=${this.botOpenId || "unknown"} name=${this.botName || "unknown"}`);
    } else {
      console.warn("[gateway] bot identity unavailable, group mention detection may be less accurate");
    }
  }

  private isOtherBotSender(senderUserId: string, senderOpenId: string): boolean {
    const userId = senderUserId.trim();
    const openId = senderOpenId.trim();
    if (!userId && !openId) {
      return false;
    }
    if (this.botOpenId && (userId === this.botOpenId || openId === this.botOpenId)) {
      return false;
    }
    if (userId === this.config.appId || openId === this.config.appId) {
      return false;
    }
    if (userId.startsWith("cli_") || openId.startsWith("cli_")) {
      return true;
    }
    return false;
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

  private looksLikeFeishuIdentifier(value: string): boolean {
    return /^(?:ou|on|od|u)_[A-Za-z0-9]+$/i.test(value.trim());
  }

  private looksLikeLinuxUser(value: string): boolean {
    return /^tfoc_[a-f0-9]+$/i.test(value.trim());
  }

  private normalizeDisplayNameCandidate(value: string): string {
    return value.trim().replace(/\s+/g, " ");
  }

  private isLikelyHumanName(value: string): boolean {
    const normalized = this.normalizeDisplayNameCandidate(value);
    if (!normalized) {
      return false;
    }
    if (this.looksLikeFeishuIdentifier(normalized) || this.looksLikeLinuxUser(normalized)) {
      return false;
    }
    if (/\p{Script=Han}/u.test(normalized)) {
      return true;
    }
    if (/^[A-Za-z][A-Za-z '.-]{0,39}$/.test(normalized)) {
      return true;
    }
    return false;
  }

  private selectLikelyHumanName(...values: string[]): string {
    for (const value of values) {
      const normalized = this.normalizeDisplayNameCandidate(value);
      if (!this.isLikelyHumanName(normalized)) {
        continue;
      }
      return normalized;
    }
    return "";
  }

  private selectDisplayNameCandidate(...values: string[]): string {
    for (const value of values) {
      const normalized = this.normalizeDisplayNameCandidate(value);
      if (!normalized) {
        continue;
      }
      if (this.looksLikeFeishuIdentifier(normalized) || this.looksLikeLinuxUser(normalized)) {
        continue;
      }
      return normalized;
    }
    return "";
  }

  private getCachedUserDisplayName(cacheKey: string): string | undefined {
    const hit = this.userNameCache.get(cacheKey);
    if (!hit) {
      return undefined;
    }
    if (Date.now() > hit.expiresAt) {
      this.userNameCache.delete(cacheKey);
      return undefined;
    }
    if (!hit.name) {
      this.userNameCache.delete(cacheKey);
      return undefined;
    }
    return hit.name;
  }

  private setCachedUserDisplayName(cacheKey: string, name: string): void {
    const normalized = this.normalizeDisplayNameCandidate(name);
    this.userNameCache.set(cacheKey, {
      name: normalized,
      expiresAt: Date.now() + (normalized ? this.userNameCacheHitTtlMs : this.userNameCacheMissTtlMs),
    });
  }

  private extractUserNameFromContactResponse(response: unknown): string {
    const obj = toObject(response);
    const dataObj = toObject(obj.data);
    const userObj = toObject(dataObj.user);
    return this.selectDisplayNameCandidate(
      toString(userObj.name),
      toString(userObj.en_name),
      toString(userObj.nickname),
      toString(userObj.employee_name),
    );
  }

  private getCachedChatInfo(chatId: string): { displayName: string; userCount: number } | undefined {
    const hit = this.chatInfoCache.get(chatId);
    if (!hit) {
      return undefined;
    }
    if (Date.now() > hit.expiresAt) {
      this.chatInfoCache.delete(chatId);
      return undefined;
    }
    return {
      displayName: hit.displayName,
      userCount: hit.userCount,
    };
  }

  private async fetchChatInfo(chatId: string): Promise<{ displayName: string; userCount: number } | undefined> {
    const normalizedChatId = chatId.trim();
    if (!this.larkClient || !normalizedChatId) {
      return undefined;
    }
    const cached = this.getCachedChatInfo(normalizedChatId);
    if (cached) {
      return cached;
    }
    try {
      const response = await this.larkClient.im.v1.chat.get({
        path: {
          chat_id: normalizedChatId,
        },
        params: {
          user_id_type: "open_id",
        },
      });
      const obj = toObject(response);
      const dataObj = toObject(obj.data);
      const i18nObj = toObject(dataObj.i18n_names);
      const displayName = this.selectLikelyHumanName(
        toString(dataObj.name),
        toString(i18nObj.zh_cn),
        toString(i18nObj.en_us),
      );
      const userCount = Math.max(0, toNumber(dataObj.user_count, 0));
      this.chatInfoCache.set(normalizedChatId, {
        displayName,
        userCount,
        expiresAt: Date.now() + this.chatInfoCacheTtlMs,
      });
      return {
        displayName,
        userCount,
      };
    } catch {
      return undefined;
    }
  }

  private async fetchUserDisplayNameById(
    idValue: string,
    idType: "open_id" | "user_id",
  ): Promise<string> {
    const normalizedId = idValue.trim();
    if (!this.larkClient || !normalizedId) {
      return "";
    }
    const cacheKey = `${idType}:${normalizedId}`;
    const cached = this.getCachedUserDisplayName(cacheKey);
    if (cached !== undefined) {
      return cached;
    }
    try {
      const response = await this.larkClient.contact.v3.user.get({
        path: {
          user_id: normalizedId,
        },
        params: {
          user_id_type: idType,
        },
      });
      const name = this.extractUserNameFromContactResponse(response);
      if (!name && FEISHU_DEBUG_INBOUND) {
        const obj = toObject(response);
        const userObj = toObject(toObject(obj.data).user);
        const userKeys = Object.keys(userObj).sort().join(",");
        console.warn(`[gateway] feishu contact user has no name fields: ${cacheKey} keys=[${userKeys}]`);
      }
      this.setCachedUserDisplayName(cacheKey, name);
      return name;
    } catch (error) {
      this.setCachedUserDisplayName(cacheKey, "");
      if (FEISHU_DEBUG_INBOUND) {
        console.warn(`[gateway] feishu fetch user profile failed: ${describeSdkError(error)} | ${cacheKey}`);
      }
      return "";
    }
  }

  private async refreshOwnerDisplayNameIndex(): Promise<void> {
    const now = Date.now();
    if (!this.larkClient || now < this.ownerDisplayNameIndexExpiresAt) {
      return;
    }
    const next = new Map<string, string>();
    let pageToken = "";
    for (let i = 0; i < 20; i += 1) {
      const response = await this.larkClient.im.v1.chat.list({
        params: {
          page_size: 50,
          user_id_type: "open_id",
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      });
      const obj = toObject(response);
      if (obj.code !== undefined && toNumber(obj.code, 0) !== 0) {
        break;
      }
      const dataObj = toObject(obj.data);
      const items = Array.isArray(dataObj.items) ? dataObj.items : [];
      for (const rawItem of items) {
        const item = toObject(rawItem);
        const ownerOpenId = toString(item.owner_id).trim();
        if (!ownerOpenId) {
          continue;
        }
        const i18n = toObject(item.i18n_names);
        const displayName = this.selectLikelyHumanName(
          toString(item.name),
          toString(i18n.zh_cn),
          toString(i18n.en_us),
        );
        if (!displayName) {
          continue;
        }
        if (this.botName && displayName.trim().toLowerCase() === this.botName.trim().toLowerCase()) {
          continue;
        }
        if (/[，,]/.test(displayName)) {
          continue;
        }
        if (/bot/i.test(displayName) && !/\p{Script=Han}/u.test(displayName)) {
          continue;
        }
        const previous = next.get(ownerOpenId);
        if (!previous || displayName.length < previous.length) {
          next.set(ownerOpenId, displayName);
        }
      }
      if (!Boolean(dataObj.has_more)) {
        break;
      }
      pageToken = toString(dataObj.page_token).trim();
      if (!pageToken) {
        break;
      }
    }
    this.ownerDisplayNameByOpenId.clear();
    for (const [key, value] of next.entries()) {
      this.ownerDisplayNameByOpenId.set(key, value);
    }
    this.ownerDisplayNameIndexExpiresAt = now + this.ownerDisplayNameIndexTtlMs;
  }

  private async fetchOwnerDisplayNameByOpenId(openId: string): Promise<string> {
    const normalizedOpenId = openId.trim();
    if (!normalizedOpenId) {
      return "";
    }
    await this.refreshOwnerDisplayNameIndex();
    return this.ownerDisplayNameByOpenId.get(normalizedOpenId) || "";
  }

  private getCachedSystemSenderName(chatId: string, senderOpenId: string): string | undefined {
    const hit = this.systemSenderNameCache.get(chatId);
    if (!hit) {
      return undefined;
    }
    if (Date.now() > hit.expiresAt) {
      this.systemSenderNameCache.delete(chatId);
      return undefined;
    }
    if (hit.senderOpenId !== senderOpenId) {
      return undefined;
    }
    return hit.displayName;
  }

  private async fetchSenderDisplayNameFromSystemMessages(chatId: string, senderOpenId: string): Promise<string> {
    const normalizedChatId = chatId.trim();
    const normalizedSenderOpenId = senderOpenId.trim();
    if (!this.larkClient || !normalizedChatId || !normalizedSenderOpenId) {
      return "";
    }
    const cached = this.getCachedSystemSenderName(normalizedChatId, normalizedSenderOpenId);
    if (cached) {
      return cached;
    }
    try {
      const response = await this.larkClient.im.v1.message.list({
        params: {
          container_id_type: "chat",
          container_id: normalizedChatId,
          page_size: 50,
          sort_type: "ByCreateTimeAsc",
        },
      });
      const obj = toObject(response);
      if (obj.code !== undefined && toNumber(obj.code, 0) !== 0) {
        return "";
      }
      const dataObj = toObject(obj.data);
      const items = Array.isArray(dataObj.items) ? dataObj.items : [];
      const userSenders = new Set<string>();
      const systemNames: string[] = [];
      for (const rawItem of items) {
        const item = toObject(rawItem);
        const senderObj = toObject(item.sender);
        const senderType = toString(senderObj.sender_type).trim().toLowerCase();
        const senderId = toString(senderObj.id).trim();
        if (senderType === "user" && senderId) {
          userSenders.add(senderId);
        }
        const messageType = toString(item.msg_type).trim().toLowerCase();
        if (messageType !== "system") {
          continue;
        }
        const bodyObj = toObject(item.body);
        const contentText = toString(bodyObj.content).trim();
        if (!contentText) {
          continue;
        }
        let contentObj: Record<string, unknown> = {};
        try {
          contentObj = toObject(JSON.parse(contentText));
        } catch {
          contentObj = {};
        }
        const fromUsers = Array.isArray(contentObj.from_user) ? contentObj.from_user : [];
        for (const fromUser of fromUsers) {
          systemNames.push(toString(fromUser));
        }
      }
      if (!(userSenders.size === 1 && userSenders.has(normalizedSenderOpenId))) {
        return "";
      }
      const displayName = this.selectLikelyHumanName(...systemNames);
      if (!displayName) {
        return "";
      }
      this.systemSenderNameCache.set(normalizedChatId, {
        senderOpenId: normalizedSenderOpenId,
        displayName,
        expiresAt: Date.now() + this.systemSenderNameCacheTtlMs,
      });
      return displayName;
    } catch {
      return "";
    }
  }

  private async resolveSenderDisplayName(
    senderObj: Record<string, unknown>,
    senderOpenId: string,
    senderUserId: string,
    contentObj: Record<string, unknown>,
    chatId: string,
    chatType: string,
  ): Promise<string> {
    const fromPayload = this.selectDisplayNameCandidate(
      toString(senderObj.name),
      toString(senderObj.sender_name),
      toString(senderObj.user_name),
      toString(senderObj.nickname),
      toString(senderObj.display_name),
      toString(toObject(senderObj.sender).name),
      toString(toObject(toObject(senderObj.sender).sender).name),
      toString(contentObj.user_name),
      toString(contentObj.name),
    );
    if (fromPayload) {
      return fromPayload;
    }
    const fromOpenId = await this.fetchUserDisplayNameById(senderOpenId, "open_id");
    if (fromOpenId) {
      if (senderUserId.trim()) {
        this.setCachedUserDisplayName(`user_id:${senderUserId.trim()}`, fromOpenId);
      }
      return fromOpenId;
    }
    const fromUserId = await this.fetchUserDisplayNameById(senderUserId, "user_id");
    if (fromUserId) {
      if (senderOpenId.trim()) {
        this.setCachedUserDisplayName(`open_id:${senderOpenId.trim()}`, fromUserId);
      }
      return fromUserId;
    }
    const fromSystem = await this.fetchSenderDisplayNameFromSystemMessages(chatId, senderOpenId);
    if (fromSystem) {
      this.setCachedUserDisplayName(`open_id:${senderOpenId.trim()}`, fromSystem);
      if (senderUserId.trim()) {
        this.setCachedUserDisplayName(`user_id:${senderUserId.trim()}`, fromSystem);
      }
      return fromSystem;
    }
    const chatInfo = await this.fetchChatInfo(chatId);
    const normalizedChatType = chatType.trim().toLowerCase();
    if (chatInfo?.displayName
      && (chatInfo.userCount === 1
        || normalizedChatType === "p2p"
        || normalizedChatType === "single")) {
      if (senderOpenId.trim()) {
        this.setCachedUserDisplayName(`open_id:${senderOpenId.trim()}`, chatInfo.displayName);
      }
      if (senderUserId.trim()) {
        this.setCachedUserDisplayName(`user_id:${senderUserId.trim()}`, chatInfo.displayName);
      }
      return chatInfo.displayName;
    }
    const fromOwner = await this.fetchOwnerDisplayNameByOpenId(senderOpenId);
    if (fromOwner) {
      this.setCachedUserDisplayName(`open_id:${senderOpenId.trim()}`, fromOwner);
      if (senderUserId.trim()) {
        this.setCachedUserDisplayName(`user_id:${senderUserId.trim()}`, fromOwner);
      }
      return fromOwner;
    }
    console.warn(
      `[gateway] sender name unresolved: chat_id=${chatId} chat_type=${normalizedChatType || "unknown"} sender_open_id=${senderOpenId || "unknown"} sender_user_id=${senderUserId || "unknown"} chat_name=${chatInfo?.displayName || "(none)"} chat_user_count=${chatInfo?.userCount ?? -1}`,
    );
    return "";
  }

  private async sendTextMessage(
    chatId: string,
    text: string,
    options?: {
      chatType?: string;
      replyToMessageId?: string;
    },
  ): Promise<{ messageId?: string }> {
    if (!this.larkClient) {
      throw new Error("feishu client not initialized");
    }

    const normalizedChatType = toString(options?.chatType).trim().toLowerCase();
    const replyToMessageId = toString(options?.replyToMessageId).trim();
    if (normalizedChatType === "group" && replyToMessageId) {
      try {
        const replyResult = await this.larkClient.im.v1.message.reply({
          path: {
            message_id: replyToMessageId,
          },
          data: {
            msg_type: "text",
            content: JSON.stringify({ text }),
          },
        });
        const replyObj = toObject(replyResult);
        const replyDataObj = toObject(replyObj.data);
        return {
          messageId: toString(replyDataObj.message_id) || toString(replyObj.message_id),
        };
      } catch (error) {
        console.warn(
          `[gateway] feishu group reply failed, fallback to chat send: ${describeSdkError(error)} | chat_id=${chatId} source_message_id=${replyToMessageId}`,
        );
      }
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

  private buildInboundResponder(chatType: string, sourceMessageId?: string): MessageResponder {
    return {
      replyText: async (chatId: string, text: string): Promise<void> => {
        await this.sendTextMessage(chatId, text, {
          chatType,
          replyToMessageId: sourceMessageId,
        });
      },
      replyTextWithMeta: async (chatId: string, text: string): Promise<{ messageId?: string }> => {
        return this.sendTextMessage(chatId, text, {
          chatType,
          replyToMessageId: sourceMessageId,
        });
      },
      replyImage: async (chatId: string, imageBase64: string): Promise<void> => {
        await this.replyImage(chatId, imageBase64);
      },
      replyFile: async (chatId: string, fileBase64: string, fileName: string, mimeType?: string): Promise<void> => {
        await this.replyFile(chatId, fileBase64, fileName, mimeType);
      },
      deleteMessage: async (messageId: string): Promise<void> => {
        await this.deleteMessage(messageId);
      },
    };
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
    if (imageBuffer.byteLength > FEISHU_MAX_IMAGE_BYTES) {
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

  async replyFile(
    chatId: string,
    fileBase64: string,
    fileName: string,
    _mimeType?: string,
  ): Promise<void> {
    if (!this.larkClient) {
      throw new Error("feishu client not initialized");
    }

    const fileBuffer = Buffer.from(fileBase64, "base64");
    if (fileBuffer.byteLength === 0) {
      throw new Error("empty file");
    }
    if (fileBuffer.byteLength > FEISHU_MAX_FILE_BYTES) {
      throw new Error("file too large (>30MB)");
    }

    const safeFileName = path.basename(fileName || `openclaw-${Date.now()}.bin`)
      .replace(/[\/\\]/g, "_")
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .trim() || `openclaw-${Date.now()}.bin`;
    const uploadFileName = safeFileName.slice(0, 120) || `openclaw-${Date.now()}.bin`;
    const tmpExt = path.extname(uploadFileName).trim() || ".bin";
    const tmpPath = path.join(
      os.tmpdir(),
      `tfclaw-feishu-${Date.now()}-${Math.random().toString(16).slice(2)}${tmpExt}`,
    );
    fs.writeFileSync(tmpPath, fileBuffer);

    let uploadResult: unknown;
    let fileStream: fs.ReadStream | undefined;
    try {
      fileStream = fs.createReadStream(tmpPath);
      uploadResult = await this.larkClient.im.v1.file.create({
        data: {
          file_type: "stream",
          file_name: uploadFileName,
          file: fileStream,
        },
      });
    } catch (error) {
      throw new Error(`feishu file upload failed: ${describeSdkError(error)}`);
    } finally {
      try {
        fileStream?.destroy();
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
    const fileKey = toString(uploadObj.file_key) || toString(uploadData.file_key);
    if (!fileKey) {
      const code = toString(uploadObj.code);
      const msg = toString(uploadObj.msg);
      throw new Error(`failed to upload file${code || msg ? `: code=${code || "unknown"} msg=${msg || "unknown"}` : ""}`);
    }

    try {
      await this.larkClient.im.v1.message.create({
        params: {
          receive_id_type: "chat_id",
        },
        data: {
          receive_id: chatId,
          msg_type: "file",
          content: JSON.stringify({ file_key: fileKey }),
        },
      });
    } catch (error) {
      throw new Error(`feishu file message send failed: ${describeSdkError(error)} | file_key=${fileKey}`);
    }
  }

  private shouldDownloadInboundAttachment(messageType: string): boolean {
    return ["image", "file", "media", "video", "audio", "sticker", "post"].includes(messageType);
  }

  private inferInboundAttachmentFileName(
    messageType: string,
    contentObj: Record<string, unknown>,
    messageId: string,
  ): string {
    const normalizedType = messageType.trim().toLowerCase();
    if (normalizedType === "image") {
      const fromPayload = toString(contentObj.image_name, toString(contentObj.file_name)).trim();
      return path.basename(fromPayload || `image_${messageId || Date.now()}.png`);
    }
    const fromPayload = toString(contentObj.file_name, toString(contentObj.file, toString(contentObj.title))).trim();
    if (fromPayload) {
      return path.basename(fromPayload);
    }
    switch (normalizedType) {
      case "audio":
        return `audio_${messageId || Date.now()}.opus`;
      case "video":
      case "media":
        return `video_${messageId || Date.now()}.mp4`;
      case "sticker":
        return `sticker_${messageId || Date.now()}.webp`;
      default:
        return `${normalizedType || "file"}_${messageId || Date.now()}.bin`;
    }
  }

  private inferInboundAttachmentMimeType(messageType: string, fileName: string): string {
    const ext = path.extname(fileName).trim().toLowerCase();
    if (ext) {
      switch (ext) {
        case ".png":
          return "image/png";
        case ".jpg":
        case ".jpeg":
          return "image/jpeg";
        case ".webp":
          return "image/webp";
        case ".gif":
          return "image/gif";
        case ".pdf":
          return "application/pdf";
        case ".txt":
          return "text/plain";
        case ".csv":
          return "text/csv";
        case ".json":
          return "application/json";
        case ".mp3":
          return "audio/mpeg";
        case ".wav":
          return "audio/wav";
        case ".ogg":
        case ".opus":
          return "audio/ogg";
        case ".mp4":
          return "video/mp4";
        default:
          return "application/octet-stream";
      }
    }
    switch (messageType) {
      case "image":
        return "image/png";
      case "audio":
        return "audio/ogg";
      case "video":
      case "media":
        return "video/mp4";
      case "sticker":
        return "image/webp";
      default:
        return "application/octet-stream";
    }
  }

  private buildInboundAttachmentTargets(
    messageType: string,
    contentObj: Record<string, unknown>,
    messageId: string,
  ): Array<{
    logicalType: string;
    resourceType: "image" | "file";
    fileKey: string;
    fileName: string;
    mimeType: string;
  }> {
    const normalizedType = messageType.trim().toLowerCase();
    if (!this.shouldDownloadInboundAttachment(normalizedType)) {
      return [];
    }

    if (normalizedType === "post") {
      const parsedPost = parseFeishuPostContent(contentObj);
      const targets: Array<{
        logicalType: string;
        resourceType: "image" | "file";
        fileKey: string;
        fileName: string;
        mimeType: string;
      }> = [];
      for (let idx = 0; idx < parsedPost.imageKeys.length; idx += 1) {
        const key = parsedPost.imageKeys[idx]!;
        const fileName = `post_image_${idx + 1}_${messageId || Date.now()}.png`;
        targets.push({
          logicalType: "image",
          resourceType: "image",
          fileKey: key,
          fileName,
          mimeType: this.inferInboundAttachmentMimeType("image", fileName),
        });
      }
      for (let idx = 0; idx < parsedPost.mediaKeys.length; idx += 1) {
        const media = parsedPost.mediaKeys[idx]!;
        const fallbackName = `post_media_${idx + 1}_${messageId || Date.now()}.bin`;
        const fileName = path.basename(media.fileName || fallbackName);
        targets.push({
          logicalType: "file",
          resourceType: "file",
          fileKey: media.fileKey,
          fileName,
          mimeType: this.inferInboundAttachmentMimeType("file", fileName),
        });
      }
      return targets;
    }

    const fileKey = normalizedType === "image"
      ? toString(contentObj.image_key).trim()
      : toString(contentObj.file_key, toString(contentObj.media_id)).trim();
    if (!fileKey) {
      return [];
    }
    const fileName = this.inferInboundAttachmentFileName(normalizedType, contentObj, messageId);
    return [
      {
        logicalType: normalizedType === "sticker" ? "image" : normalizedType,
        resourceType: normalizedType === "image" ? "image" : "file",
        fileKey,
        fileName,
        mimeType: this.inferInboundAttachmentMimeType(normalizedType, fileName),
      },
    ];
  }

  private async readFeishuBinaryResponse(response: unknown): Promise<Buffer> {
    if (Buffer.isBuffer(response)) {
      return response;
    }
    if (response instanceof ArrayBuffer) {
      return Buffer.from(response);
    }
    const responseObj = response as {
      code?: unknown;
      msg?: unknown;
      data?: unknown;
      getReadableStream?: () => AsyncIterable<Uint8Array | Buffer>;
      writeFile?: (pathValue: string) => Promise<void>;
      [Symbol.asyncIterator]?: () => AsyncIterable<Uint8Array | Buffer>;
    };
    const code = toNumber(responseObj.code, 0);
    if (responseObj.code !== undefined && code !== 0) {
      throw new Error(`code=${code} msg=${toString(responseObj.msg, "unknown")}`);
    }
    if (Buffer.isBuffer(responseObj.data)) {
      return responseObj.data;
    }
    if (responseObj.data instanceof ArrayBuffer) {
      return Buffer.from(responseObj.data);
    }
    if (typeof responseObj.getReadableStream === "function") {
      const chunks: Buffer[] = [];
      for await (const chunk of responseObj.getReadableStream()) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    }
    if (typeof responseObj[Symbol.asyncIterator] === "function") {
      const chunks: Buffer[] = [];
      for await (const chunk of responseObj as unknown as AsyncIterable<Uint8Array | Buffer>) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    }
    if (typeof responseObj.writeFile === "function") {
      const tmpPath = path.join(
        os.tmpdir(),
        `tfclaw-feishu-download-${Date.now()}-${Math.random().toString(16).slice(2)}.bin`,
      );
      try {
        await responseObj.writeFile(tmpPath);
        return fs.readFileSync(tmpPath);
      } finally {
        try {
          fs.unlinkSync(tmpPath);
        } catch {
          // no-op
        }
      }
    }
    throw new Error("unexpected feishu binary response format");
  }

  private async downloadInboundAttachments(
    messageType: string,
    contentObj: Record<string, unknown>,
    messageId: string,
  ): Promise<BridgeInboundAttachment[]> {
    if (!this.larkClient || !messageId || !this.shouldDownloadInboundAttachment(messageType)) {
      return [];
    }
    const normalizedType = messageType.trim().toLowerCase();
    const targets = this.buildInboundAttachmentTargets(normalizedType, contentObj, messageId);
    if (targets.length === 0) {
      return [];
    }
    const results: BridgeInboundAttachment[] = [];
    const seen = new Set<string>();

    for (const target of targets) {
      const dedupKey = `${target.resourceType}:${target.fileKey}`;
      if (seen.has(dedupKey)) {
        continue;
      }
      seen.add(dedupKey);
      try {
        const response = await this.larkClient.im.v1.messageResource.get({
          path: {
            message_id: messageId,
            file_key: target.fileKey,
          },
          params: {
            type: target.resourceType,
          },
        });
        const buffer = await this.readFeishuBinaryResponse(response);
        if (buffer.byteLength === 0) {
          continue;
        }
        if (buffer.byteLength > OPENCLAW_BRIDGE_INBOUND_MAX_FILE_BYTES) {
          throw new Error(`attachment too large (${buffer.byteLength} bytes)`);
        }
        results.push({
          messageType: target.logicalType,
          fileName: target.fileName,
          mimeType: target.mimeType,
          contentBase64: buffer.toString("base64"),
          sourceFileKey: target.fileKey,
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.warn(
          `[gateway] feishu inbound attachment download failed: ${msg} | message_id=${messageId} type=${normalizedType} file_key=${target.fileKey}`,
        );
      }
    }
    return results;
  }

  private async handleInboundEvent(data: unknown): Promise<void> {
    const root = toObject(data);
    const eventPayload = toObject(root.event);
    const inboundPayload = Object.keys(eventPayload).length > 0 ? eventPayload : root;
    const message = toObject(inboundPayload.message);
    const messageType = toString(message.message_type).trim().toLowerCase();
    if (!messageType) {
      return;
    }

    const rootHeader = toObject(root.header);
    const payloadHeader = toObject(inboundPayload.header);
    const eventHeader = Object.keys(rootHeader).length > 0 ? rootHeader : payloadHeader;
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

    const chatType = toString(message.chat_type).trim().toLowerCase() || "unknown";
    const senderObj = toObject(inboundPayload.sender);
    const senderIdObj = toObject(senderObj.sender_id);
    const senderOpenId = toString(senderIdObj.open_id);
    const senderUserId = toString(senderIdObj.user_id);
    const normalizedSenderId = senderOpenId || senderUserId;
    if (chatType === "group" && this.isOtherBotSender(senderUserId, senderOpenId)) {
      if (FEISHU_DEBUG_INBOUND) {
        console.log(
          `[gateway] feishu group message ignored (other bot sender): chat_id=${chatId} sender_open_id=${senderOpenId || "unknown"} sender_user_id=${senderUserId || "unknown"}`,
        );
      }
      return;
    }

    const rawContent = toString(message.content);
    let contentObj: Record<string, unknown> = {};
    if (rawContent) {
      try {
        contentObj = toObject(JSON.parse(rawContent));
      } catch {
        contentObj = {};
      }
    }
    const senderName = await this.resolveSenderDisplayName(
      senderObj,
      senderOpenId,
      senderUserId,
      contentObj,
      chatId,
      chatType,
    );
    const rawText = messageType === "text" ? toString(contentObj.text, rawContent) : "";
    const attachments = await this.downloadInboundAttachments(messageType, contentObj, messageId);
    const mentions = extractFeishuMentions(message, contentObj);
    const postParsed = messageType === "post" ? parseFeishuPostContent(contentObj) : undefined;
    if (postParsed?.mentionedIds.length) {
      for (const mentionedId of postParsed.mentionedIds) {
        mentions.push({
          key: "",
          name: "",
          openId: mentionedId,
          userId: mentionedId,
        });
      }
    }
    const inlineMentionKeys = messageType === "text" ? extractFeishuInlineMentionKeys(rawText) : [];
    const mentionKeyList = Array.from(new Set([...mentionKeys(mentions), ...inlineMentionKeys]));
    const atTags = messageType === "text" ? extractFeishuAtTags(rawText) : [];
    const text = messageType === "text" ? normalizeFeishuInboundText(rawText, mentionKeyList) : "";
    const llmBaseText = messageType === "text"
      ? normalizeFeishuInboundText(
        replaceFeishuMentionTokens(rawText, mentions, this.botOpenId, this.botName),
        mentionKeyList,
      )
      : buildFeishuNonTextBaseText(messageType, contentObj, messageId);
    const feishuDocHint = buildFeishuDocToolHint(llmBaseText);
    const llmText = feishuDocHint ? `${llmBaseText}\n\n${feishuDocHint}` : llmBaseText;
    const isMentioned = chatType !== "group"
      ? true
      : isFeishuMessageMentionedToBot(mentions, this.botOpenId, this.botName, this.config.appId, {
        atTags,
        mentionKeys: mentionKeyList,
      });

    if (FEISHU_DEBUG_INBOUND) {
      console.log(
        `[gateway] feishu inbound: message_id=${messageId || "unknown"} chat_id=${chatId} chat_type=${chatType} message_type=${messageType} mentioned=${isMentioned} mentions=${mentionKeyList.length} at_tags=${atTags.length} text=${JSON.stringify(text).slice(0, 220)}`,
      );
    }

    const shouldAckReaction = FEISHU_ACK_REACTION_ENABLED
      && Boolean(messageId)
      && (chatType !== "group" || isMentioned);
    if (shouldAckReaction) {
      void this.addReaction(messageId).catch((error) => {
        const msg = error instanceof Error ? error.message : String(error);
        console.warn(`[gateway] feishu add reaction failed: ${msg}`);
      });
    }

    const responder = this.buildInboundResponder(chatType, messageId || undefined);
    try {
      await this.router.handleInboundMessage({
        channel: "feishu",
        chatId,
        chatType,
        isMentioned,
        senderId: normalizedSenderId || undefined,
        senderOpenId: senderOpenId || undefined,
        senderUserId: senderUserId || undefined,
        senderName: senderName || undefined,
        mentions,
        messageId: messageId || undefined,
        eventId: eventId || undefined,
        messageType,
        contentRaw: rawContent,
        contentObj,
        attachments,
        text,
        llmText: llmText || text,
        rawEvent: inboundPayload,
        allowFrom: this.config.allowFrom,
        responder,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      try {
        await responder.replyText(chatId, `failed to process message: ${msg}`);
      } catch (replyError) {
        const fallbackMsg = replyError instanceof Error ? replyError.message : String(replyError);
        console.error(`[gateway] feishu failed to send error reply: ${fallbackMsg}`);
      }
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

  const bridgeHost = hostFromUrl(loaded.config.nexchatbot.baseUrl);
  const relayHost = hostFromUrl(loaded.config.relay.url);
  const openclawHost = hostFromUrl(`http://${loaded.config.openclawBridge.gatewayHost}`);
  const localNoProxyHosts = [
    "127.0.0.1",
    "localhost",
    "::1",
    bridgeHost,
    relayHost,
    openclawHost,
  ].filter((item) => isLocalNoProxyHost(item));
  if (localNoProxyHosts.length > 0) {
    mergeNoProxyHosts(localNoProxyHosts);
    console.log(`[gateway] local no_proxy applied: ${(process.env.NO_PROXY ?? "").trim()}`);
  }

  const relay = new RelayBridge(loaded.config.relay.url, loaded.config.relay.token, "feishu");
  const nexChatBridge = new NexChatBridgeClient(loaded.config.nexchatbot);
  const openclawBridge = new OpenClawPerUserBridge(loaded.config.openclawBridge);
  const accessManager = new TfclawAccessManager(loaded.config.openclawBridge.stateDir);
  const configuredSuperRoot = accessManager.readConfiguredSuperRootIdentifier();
  if (configuredSuperRoot) {
    const bindings = await openclawBridge.listUserBindings();
    let resolvedSuperRoot = "";
    const byUserKey = bindings.find((item) => item.userKey === configuredSuperRoot);
    if (byUserKey) {
      resolvedSuperRoot = byUserKey.userKey;
    } else {
      const byLinuxUser = bindings.find((item) => item.linuxUser === configuredSuperRoot);
      if (byLinuxUser) {
        resolvedSuperRoot = byLinuxUser.userKey;
      }
    }
    if (!resolvedSuperRoot) {
      resolvedSuperRoot = (await accessManager.resolveUserAlias(configuredSuperRoot)) || "";
    }
    if (!resolvedSuperRoot && /^(?:ou|on|od|u)_[A-Za-z0-9]+$/i.test(configuredSuperRoot)) {
      resolvedSuperRoot = configuredSuperRoot;
    }
    if (resolvedSuperRoot) {
      await accessManager.setSuperRootFromConfig(resolvedSuperRoot);
      console.log(`[gateway] super_root loaded from local config: ${resolvedSuperRoot}`);
    } else {
      console.warn(
        `[gateway] super_root local config unresolved: ${configuredSuperRoot}. Use feishu user key, known name, or mapped linux user.`,
      );
    }
  }
  const router = new TfclawCommandRouter(relay, nexChatBridge, openclawBridge, accessManager);
  const chatApps = new ChatAppManager(loaded.config, router);

  relay.connect();
  await chatApps.startAll();

  const enabledChannels = chatApps.enabledChannels;
  console.log("[gateway] TFClaw gateway started");
  console.log(`[gateway] config: ${loaded.configPath}${loaded.fromFile ? "" : " (env fallback)"}`);
  console.log(`[gateway] enabled channels: ${enabledChannels.length > 0 ? enabledChannels.join(", ") : "(none)"}`);
  if (nexChatBridge.enabled) {
    console.log(
      `[gateway] nexchatbot bridge: enabled -> ${joinHttpUrl(loaded.config.nexchatbot.baseUrl, loaded.config.nexchatbot.runPath)}`,
    );
  } else {
    console.log("[gateway] nexchatbot bridge: disabled");
  }
  if (openclawBridge.enabled) {
    console.log(
      `[gateway] openclaw bridge: enabled -> root=${loaded.config.openclawBridge.openclawRoot}, stateDir=${loaded.config.openclawBridge.stateDir}, sharedSkillsDir=${loaded.config.openclawBridge.sharedSkillsDir}, userHomeRoot=${loaded.config.openclawBridge.userHomeRoot}, userPrefix=${loaded.config.openclawBridge.userPrefix}, portRange=${loaded.config.openclawBridge.gatewayPortBase}-${loaded.config.openclawBridge.gatewayPortMax}`,
    );
  } else {
    console.log("[gateway] openclaw bridge: disabled");
  }

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
