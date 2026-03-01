import { StatusBar as ExpoStatusBar } from "expo-status-bar";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AppState,
  Clipboard,
  Dimensions,
  GestureResponderEvent,
  KeyboardAvoidingView,
  Keyboard,
  LayoutChangeEvent,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar as NativeStatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";

type PlatformName = "windows" | "macos" | "linux" | "unknown";
type AppStage = "login" | "chat";
type MessageRole = "user" | "assistant" | "system";
type ConnectionState = "offline" | "connecting" | "online";
type WorkMode = "tfclaw" | "tmux";

const TMUX_LINES_MIN = 10;
const TMUX_LINES_MAX = 300;
const TMUX_LINES_SLIDER_THUMB_SIZE = 18;
const TERMINAL_RENDER_MAX_CHARS = 120000;
const TMUX_RENDER_DEFAULT_KEY = "__default__";
const DEFAULT_RELAY_URL = process.env.EXPO_PUBLIC_TFCLAW_RELAY_URL ?? "ws://127.0.0.1:8787";
const DEFAULT_TOKEN = process.env.EXPO_PUBLIC_TFCLAW_TOKEN ?? "demo-token";
const LOGIN_PREFS_STORAGE_KEY = "@tfclaw/mobile/login-prefs";
const UI_SCALE_DEFAULT_PERCENT = 50;
const CONTENT_FONT_SCALES = [1, 1.2, 1.4] as const;
const CONTENT_FONT_LABELS = ["M", "L", "XL"] as const;
const UI_SCALE_MIN_PERCENT = 10;
const UI_SCALE_MAX_PERCENT = 300;
const UI_SCALE_STEPS = [10, 25, 50, 75, 100, 115, 130, 160, 200] as const;
const TMUX_KEY_SHORTCUTS: Array<{ label: string; token: string }> = [
  { label: "^C", token: "^C" },
  { label: "Enter", token: "enter" },
  { label: "Esc", token: "esc" },
  { label: "Up", token: "up" },
  { label: "Down", token: "down" },
];
const TEXT_ACTION_MENU_BUTTONS = [
  { id: "copy", label: "Copy", enabled: true },
  { id: "save", label: "Save", enabled: false },
  { id: "delete", label: "Delete", enabled: false },
  { id: "quote", label: "Quote", enabled: false },
  { id: "remind", label: "Remind", enabled: false },
  { id: "translate", label: "Translate", enabled: false },
  { id: "search", label: "Search", enabled: false },
] as const;

interface AgentDescriptor {
  agentId: string;
  platform: PlatformName;
  hostname: string;
  connectedAt: string;
}

interface RelayStateMessage {
  type: "relay.state";
  payload: {
    agent?: AgentDescriptor;
    terminals: Array<unknown>;
    snapshots: Array<unknown>;
  };
}

interface RelayAckMessage {
  type: "relay.ack";
  payload: {
    ok: boolean;
    message?: string;
    requestId?: string;
  };
}

interface AgentCommandResultMessage {
  type: "agent.command_result";
  payload: {
    requestId?: string;
    output: string;
    progress?: boolean;
    progressSource?: string;
  };
}

interface AgentTerminalOutputMessage {
  type: "agent.terminal_output";
  payload: {
    terminalId: string;
    chunk: string;
    at: string;
  };
}

interface AgentErrorMessage {
  type: "agent.error";
  payload: {
    code: string;
    message: string;
    requestId?: string;
  };
}

type IncomingMessage =
  | RelayStateMessage
  | RelayAckMessage
  | AgentCommandResultMessage
  | AgentTerminalOutputMessage
  | AgentErrorMessage;

interface ChatMessage {
  id: string;
  role: MessageRole;
  text: string;
  progress?: boolean;
}

interface PendingCommandState {
  progressMessageId?: string;
  tmuxTargetKey?: string;
}

interface SavedLoginPrefs {
  remember: boolean;
  relayUrl?: string;
  token?: string;
}

interface TextActionMenuState {
  visible: boolean;
  text: string;
  x: number;
  y: number;
  sourceType: "message" | "tmux";
  sourceId?: string;
}

function randomId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

function cleanOutput(output: string): string {
  const text = String(output ?? "").trim();
  return text.length > 0 ? text : "(no output)";
}

function stripAnsi(input: string): string {
  return input
    .replace(/\u001B\][^\u0007]*(\u0007|\u001B\\)/g, "")
    .replace(/\u001B[@-_][0-?]*[ -/]*[@-~]/g, "");
}

function clampTmuxLines(value: number): number {
  if (!Number.isFinite(value)) {
    return 200;
  }
  return Math.max(TMUX_LINES_MIN, Math.min(TMUX_LINES_MAX, Math.round(value)));
}

function clampUiScalePercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 100;
  }
  return Math.max(UI_SCALE_MIN_PERCENT, Math.min(UI_SCALE_MAX_PERCENT, Math.round(value)));
}

function normalizeTmuxTarget(target: string): string {
  return String(target ?? "").trim().split(/\s+/)[0] ?? "";
}

function sanitizeTmuxWindowName(name: string): string {
  return String(name ?? "").trim().replace(/\s+/g, "-");
}

function parseTmuxTargetFromCommand(commandText: string): string | undefined {
  const tmuxTargetMatch = commandText.match(/^\/(?:tmux|t)\s+target\s+(.+)$/i);
  if (tmuxTargetMatch?.[1]) {
    return normalizeTmuxTarget(tmuxTargetMatch[1]);
  }
  const shortAliasMatch = commandText.match(/^\/ttarget\s+(.+)$/i);
  if (shortAliasMatch?.[1]) {
    return normalizeTmuxTarget(shortAliasMatch[1]);
  }
  return undefined;
}

function parseTmuxTargets(output: string): string[] {
  const lines = output.split(/\r?\n/);
  const found: string[] = [];
  for (const line of lines) {
    const paneMatch = line.match(/^\s*-\s*\[\d+\]\s+([^\s|]+)\s+\|/);
    if (paneMatch?.[1]) {
      found.push(paneMatch[1]);
      continue;
    }
    const tmuxHeader = line.match(/^\s*\[tmux\s+([^\]]+)\]/);
    if (tmuxHeader?.[1]) {
      const normalized = normalizeTmuxTarget(tmuxHeader[1]);
      if (normalized) {
        found.push(normalized);
      }
    }
  }
  return Array.from(new Set(found));
}

function parseTmuxTargetHint(output: string): string | undefined {
  const targetSet = output.match(/Target set to\s+`([^`]+)`/i);
  if (targetSet?.[1]) {
    return normalizeTmuxTarget(targetSet[1]);
  }
  const passthroughTarget = output.match(/tmux target\s+`([^`]+)`/i);
  if (passthroughTarget?.[1]) {
    return normalizeTmuxTarget(passthroughTarget[1]);
  }
  const tmuxHeader = output.match(/\[tmux\s+([^\]]+)\]/);
  if (tmuxHeader?.[1]) {
    return normalizeTmuxTarget(tmuxHeader[1]);
  }
  return undefined;
}

function parseTmuxLinesValue(output: string): number | undefined {
  const setMatch = output.match(/capture_lines set to\s+(\d+)/i);
  if (setMatch?.[1]) {
    return clampTmuxLines(Number.parseInt(setMatch[1], 10));
  }
  const currentMatch = output.match(/Current capture_lines:\s*(\d+)/i);
  if (currentMatch?.[1]) {
    return clampTmuxLines(Number.parseInt(currentMatch[1], 10));
  }
  return undefined;
}

export default function App() {
  const [stage, setStage] = useState<AppStage>("login");
  const [relayUrl, setRelayUrl] = useState("");
  const [token, setToken] = useState("");
  const [rememberLogin, setRememberLogin] = useState(false);
  const [connectionState, setConnectionState] = useState<ConnectionState>("offline");
  const [workMode, setWorkMode] = useState<WorkMode>("tfclaw");
  const [tmuxLines, setTmuxLines] = useState(200);
  const [tmuxLinesInput, setTmuxLinesInput] = useState("200");
  const [tmuxTargets, setTmuxTargets] = useState<string[]>([]);
  const [selectedTmuxTarget, setSelectedTmuxTarget] = useState("");
  const [tmuxTargetMenuOpen, setTmuxTargetMenuOpen] = useState(false);
  const [tmuxNewDialogOpen, setTmuxNewDialogOpen] = useState(false);
  const [tmuxNewNameInput, setTmuxNewNameInput] = useState("");
  const [hideTfclawWindowInTmux, setHideTfclawWindowInTmux] = useState(false);
  const [ignoreTopPanels, setIgnoreTopPanels] = useState(false);
  const [uiScalePercent, setUiScalePercent] = useState(UI_SCALE_DEFAULT_PERCENT);
  const [uiScaleInput, setUiScaleInput] = useState(String(UI_SCALE_DEFAULT_PERCENT));
  const [contentFontStep, setContentFontStep] = useState(0);
  const [tmuxKeyPanelOpen, setTmuxKeyPanelOpen] = useState(false);
  const [agent, setAgent] = useState<AgentDescriptor | undefined>(undefined);
  const [inputText, setInputText] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [tmuxRenderByTarget, setTmuxRenderByTarget] = useState<Record<string, string>>({});
  const [tmuxLiveProgressByTarget, setTmuxLiveProgressByTarget] = useState<Record<string, string>>({});
  const [selectedTextMessageId, setSelectedTextMessageId] = useState("");
  const [terminalTextSelected, setTerminalTextSelected] = useState(false);
  const [textActionMenu, setTextActionMenu] = useState<TextActionMenuState>({
    visible: false,
    text: "",
    x: 12,
    y: 12,
    sourceType: "message",
  });

  const wsRef = useRef<WebSocket | null>(null);
  const workModeRef = useRef<WorkMode>("tfclaw");
  const stageRef = useRef<AppStage>("login");
  const connectionStateRef = useRef<ConnectionState>("offline");
  const appStateRef = useRef(AppState.currentState);
  const keepConnectionRef = useRef(false);
  const selectedTmuxTargetRef = useRef("");
  const tmuxProgressRequestTargetRef = useRef<Map<string, string>>(new Map());
  const pendingMapRef = useRef<Map<string, PendingCommandState>>(new Map());
  const silentRequestIdsRef = useRef<Set<string>>(new Set());
  const closeSwitchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chatScrollRef = useRef<ScrollView | null>(null);
  const terminalScrollRef = useRef<ScrollView | null>(null);
  const tmuxLinesTrackWidthRef = useRef(1);
  const [tmuxLinesTrackWidth, setTmuxLinesTrackWidth] = useState(1);

  const isOnline = connectionState === "online";
  const isConnecting = connectionState === "connecting";
  const uiScaleValue = clampUiScalePercent(uiScalePercent);
  const uiScale = uiScaleValue / 100;
  const uiScaleLabel = `${uiScaleValue}%`;
  const contentFontScale = CONTENT_FONT_SCALES[contentFontStep] ?? CONTENT_FONT_SCALES[0];
  const contentFontLabel = CONTENT_FONT_LABELS[contentFontStep] ?? CONTENT_FONT_LABELS[0];

  const dynamicUi = useMemo(() => {
    const scaled = (value: number, min = 1) => Math.max(min, Math.round(value * uiScale));
    const contentScaled = (value: number, min = 1) => Math.max(min, Math.round(value * uiScale * contentFontScale));
    return {
      title: { fontSize: scaled(21, 6) },
      subtitle: { fontSize: scaled(12, 4) },
      label: { fontSize: scaled(12, 4) },
      sectionTitle: { fontSize: scaled(15, 5) },
      metaText: { fontSize: scaled(12, 4) },
      btn: {
        borderRadius: scaled(10, 4),
        paddingHorizontal: scaled(12, 4),
        paddingVertical: scaled(10, 4),
        minWidth: scaled(80, 36),
      },
      topBtn: { minWidth: scaled(92, 40) },
      btnText: { fontSize: scaled(13, 5) },
      modeBadgeText: { fontSize: scaled(12, 5) },
      input: {
        fontSize: scaled(14, 5),
        paddingHorizontal: scaled(10, 5),
        paddingVertical: scaled(10, 4),
      },
      linesInput: { width: scaled(88, 44) },
      linesApplyBtn: {
        borderRadius: scaled(8, 4),
        paddingHorizontal: scaled(10, 4),
        paddingVertical: scaled(6, 4),
      },
      linesApplyBtnText: { fontSize: scaled(12, 5) },
      targetPickerText: { fontSize: scaled(12, 5) },
      targetMenuItemText: { fontSize: scaled(12, 5) },
      terminalText: {
        fontSize: contentScaled(12, 5),
        lineHeight: contentScaled(18, 8),
      },
      msgName: { fontSize: scaled(11, 4) },
      msgText: {
        fontSize: contentScaled(13, 5),
        lineHeight: contentScaled(18, 8),
      },
      msgSystemText: { fontSize: contentScaled(12, 4) },
      emptyText: { fontSize: contentScaled(12, 4) },
      keyPanelBtn: {
        minWidth: scaled(68, 34),
        paddingHorizontal: scaled(10, 4),
        paddingVertical: scaled(8, 4),
        borderRadius: scaled(8, 4),
      },
      keyPanelBtnText: { fontSize: scaled(12, 5) },
      headerActionBtn: {
        minWidth: scaled(74, 34),
        borderRadius: scaled(8, 4),
        paddingHorizontal: scaled(10, 4),
        paddingVertical: scaled(8, 4),
      },
      headerScaleInputWrap: {
        minWidth: scaled(56, 36),
        borderRadius: scaled(8, 4),
      },
      headerScaleInput: {
        fontSize: scaled(12, 5),
        paddingHorizontal: scaled(8, 4),
        paddingVertical: scaled(6, 3),
      },
      dialogTitle: { fontSize: scaled(16, 6) },
      textActionBtn: {
        borderRadius: scaled(8, 4),
        paddingHorizontal: scaled(10, 4),
        paddingVertical: scaled(8, 4),
      },
      textActionBtnText: { fontSize: scaled(12, 5) },
    };
  }, [contentFontScale, uiScale]);

  const statusText = useMemo(() => {
    if (connectionState === "online") {
      return "online";
    }
    if (connectionState === "connecting") {
      return "connecting";
    }
    return "offline";
  }, [connectionState]);

  const agentText = useMemo(() => {
    if (!agent) {
      return "agent: not connected";
    }
    return `agent: ${agent.hostname} (${agent.platform})`;
  }, [agent]);

  const modeText = useMemo(() => `mode: ${workMode}`, [workMode]);

  const switchWorkMode = (mode: WorkMode) => {
    workModeRef.current = mode;
    setWorkMode(mode);
  };

  const appendMessage = (message: ChatMessage) => {
    setMessages((prev) => {
      const next = [...prev, message];
      return next.slice(-500);
    });
  };

  const updateMessageText = (id: string, text: string) => {
    setMessages((prev) => prev.map((msg) => (msg.id === id ? { ...msg, text } : msg)));
  };

  const removeMessage = (id: string) => {
    setMessages((prev) => prev.filter((msg) => msg.id !== id));
  };

  const normalizeTmuxRenderKey = (target?: string): string => {
    const normalized = normalizeTmuxTarget(target ?? "");
    if (normalized) {
      return normalized;
    }
    const selected = normalizeTmuxTarget(selectedTmuxTargetRef.current);
    if (selected) {
      return selected;
    }
    return TMUX_RENDER_DEFAULT_KEY;
  };

  const resolveTmuxTargetForOutput = (output: string, requestId?: string): string => {
    if (requestId) {
      const pending = pendingMapRef.current.get(requestId);
      const pendingTarget = normalizeTmuxTarget(pending?.tmuxTargetKey ?? "");
      if (pendingTarget) {
        return pendingTarget;
      }
    }
    const hintedTarget = parseTmuxTargetHint(output);
    if (hintedTarget) {
      return hintedTarget;
    }
    return normalizeTmuxRenderKey();
  };

  const resolveTmuxTargetForCommand = (commandText: string, mode: WorkMode): string => {
    if (mode !== "tmux") {
      return TMUX_RENDER_DEFAULT_KEY;
    }
    const explicitTarget = parseTmuxTargetFromCommand(commandText);
    if (explicitTarget) {
      return normalizeTmuxRenderKey(explicitTarget);
    }
    return normalizeTmuxRenderKey();
  };

  const setTmuxProgress = (text: string, tmuxTargetKey?: string, requestId?: string) => {
    const key = normalizeTmuxRenderKey(tmuxTargetKey);
    if (requestId) {
      tmuxProgressRequestTargetRef.current.set(requestId, key);
    }
    setTmuxLiveProgressByTarget((prev) => ({
      ...prev,
      [key]: text,
    }));
  };

  const clearTmuxProgressByTarget = (tmuxTargetKey?: string) => {
    const key = normalizeTmuxRenderKey(tmuxTargetKey);
    setTmuxLiveProgressByTarget((prev) => {
      if (!(key in prev) || !prev[key]) {
        return prev;
      }
      return {
        ...prev,
        [key]: "",
      };
    });
  };

  const clearTmuxProgressByRequest = (requestId?: string) => {
    if (!requestId) {
      return;
    }
    const key = tmuxProgressRequestTargetRef.current.get(requestId);
    tmuxProgressRequestTargetRef.current.delete(requestId);
    if (!key) {
      return;
    }
    clearTmuxProgressByTarget(key);
  };

  const clearTmuxProgress = () => {
    clearTmuxProgressByTarget();
  };

  const sendJson = (payload: unknown): boolean => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      if (workModeRef.current === "tmux") {
        appendTerminalRender("Not connected. Message was not sent.");
      } else {
        appendMessage({
          id: randomId("sys"),
          role: "system",
          text: "Not connected. Message was not sent.",
        });
      }
      return false;
    }
    ws.send(JSON.stringify(payload));
    return true;
  };

  const sendSilentCommandText = (commandText: string): boolean => {
    const text = commandText.trim();
    if (!text) {
      return false;
    }
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    const requestId = randomId("tfclaw-silent");
    silentRequestIdsRef.current.add(requestId);
    pendingMapRef.current.set(requestId, {});
    ws.send(
      JSON.stringify({
        type: "client.command",
        requestId,
        payload: {
          command: "tfclaw.command",
          text,
          sessionKey: "mobile-app",
        },
      }),
    );
    return true;
  };

  const appendTerminalRender = (chunk: string, tmuxTargetKey?: string) => {
    const cleaned = stripAnsi(String(chunk ?? "")).replace(/\r\n/g, "\n");
    if (!cleaned) {
      return;
    }
    const normalized = cleaned.endsWith("\n") ? cleaned : `${cleaned}\n`;
    const key = normalizeTmuxRenderKey(tmuxTargetKey);
    setTmuxRenderByTarget((prev) => {
      const existing = prev[key] ?? "";
      const merged = `${existing}${normalized}`;
      const trimmed = merged.length > TERMINAL_RENDER_MAX_CHARS ? merged.slice(-TERMINAL_RENDER_MAX_CHARS) : merged;
      return {
        ...prev,
        [key]: trimmed,
      };
    });
  };

  const appendSystemText = (text: string) => {
    if (workModeRef.current === "tmux") {
      appendTerminalRender(text);
    }
    appendMessage({
      id: randomId("sys"),
      role: "system",
      text,
    });
  };

  const syncModeFromOutput = (output: string) => {
    if (/^\s*passthrough enabled\./i.test(output)) {
      setHideTfclawWindowInTmux(true);
      switchWorkMode("tmux");
      return;
    }
    if (/^\s*passthrough disabled\./i.test(output)) {
      switchWorkMode("tfclaw");
    }
  };

  const applySelectedTmuxTarget = (target: string) => {
    const normalized = normalizeTmuxTarget(target);
    if (!normalized) {
      return;
    }
    selectedTmuxTargetRef.current = normalized;
    setSelectedTmuxTarget(normalized);
    setTmuxTargets((prev) => Array.from(new Set([...prev, normalized])));
  };

  const syncSelectedTmuxTargetFromOutput = (output: string) => {
    const targetSet = output.match(/Target set to\s+`([^`]+)`/i);
    if (targetSet?.[1]) {
      applySelectedTmuxTarget(targetSet[1]);
      return;
    }
    if (normalizeTmuxTarget(selectedTmuxTargetRef.current)) {
      return;
    }
    const fallback = output.match(/tmux target\s+`([^`]+)`/i) ?? output.match(/\[tmux\s+([^\]]+)\]/);
    if (fallback?.[1]) {
      applySelectedTmuxTarget(fallback[1]);
    }
  };

  const syncTmuxContextFromOutput = (output: string) => {
    const discoveredTargets = parseTmuxTargets(output);
    if (discoveredTargets.length > 0) {
      const hasPaneListing = /^\s*-\s*\[\d+\]/m.test(output);
      if (hasPaneListing) {
        setTmuxTargets(Array.from(new Set(discoveredTargets)));
      } else {
        setTmuxTargets((prev) => Array.from(new Set([...prev, ...discoveredTargets])));
      }
    }
    const hintedTarget = parseTmuxTargetHint(output);
    if (hintedTarget) {
      setTmuxTargets((prev) => Array.from(new Set([...prev, hintedTarget])));
    }
    const maybeLines = parseTmuxLinesValue(output);
    if (typeof maybeLines === "number") {
      setTmuxLines(maybeLines);
      setTmuxLinesInput(String(maybeLines));
    }
  };

  const finishPending = (requestId?: string) => {
    if (!requestId) {
      return;
    }
    const pending = pendingMapRef.current.get(requestId);
    if (pending?.progressMessageId) {
      removeMessage(pending.progressMessageId);
    }
    tmuxProgressRequestTargetRef.current.delete(requestId);
    pendingMapRef.current.delete(requestId);
  };

  const handleIncoming = (rawData: string) => {
    let parsed: IncomingMessage;
    try {
      parsed = JSON.parse(rawData) as IncomingMessage;
    } catch {
      appendSystemText("Received an invalid message.");
      return;
    }

    if (parsed.type === "relay.state") {
      setAgent(parsed.payload.agent);
      return;
    }

    if (parsed.type === "agent.command_result") {
      const requestId = parsed.payload.requestId;
      const isProgress = Boolean(parsed.payload.progress);
      const isSilent = Boolean(requestId && silentRequestIdsRef.current.has(requestId));
      const rawOutput = String(parsed.payload.output ?? "");
      const tmuxTargetForOutput = resolveTmuxTargetForOutput(rawOutput, requestId);
      const outputText = cleanOutput(rawOutput);
      syncModeFromOutput(rawOutput);
      syncTmuxContextFromOutput(rawOutput);
      syncSelectedTmuxTargetFromOutput(rawOutput);
      const currentMode = workModeRef.current;

      if (isProgress) {
        if (isSilent) {
          return;
        }
        if (currentMode === "tmux") {
          setTmuxProgress(cleanOutput(rawOutput), tmuxTargetForOutput, requestId);
          return;
        }
        if (!requestId) {
          return;
        }
        const pending = pendingMapRef.current.get(requestId) ?? {};
        if (!pending.progressMessageId) {
          const progressMessageId = randomId("progress");
          pending.progressMessageId = progressMessageId;
          pendingMapRef.current.set(requestId, pending);
          appendMessage({
            id: progressMessageId,
            role: "assistant",
            progress: true,
            text: outputText,
          });
        } else {
          updateMessageText(pending.progressMessageId, outputText);
        }
        return;
      }

      finishPending(requestId);
      if (requestId) {
        silentRequestIdsRef.current.delete(requestId);
      }
      if (isSilent) {
        return;
      }
      if (currentMode === "tmux") {
        if (requestId) {
          clearTmuxProgressByRequest(requestId);
        } else {
          clearTmuxProgressByTarget(tmuxTargetForOutput);
        }
        appendTerminalRender(rawOutput, tmuxTargetForOutput);
        return;
      }
      appendMessage({
        id: randomId("assistant"),
        role: "assistant",
        text: outputText,
      });
      return;
    }

    if (parsed.type === "agent.terminal_output") {
      syncTmuxContextFromOutput(parsed.payload.chunk);
      if (workModeRef.current === "tmux") {
        appendTerminalRender(parsed.payload.chunk);
      }
      return;
    }

    if (parsed.type === "agent.error") {
      const requestId = parsed.payload.requestId;
      const isSilent = Boolean(requestId && silentRequestIdsRef.current.has(requestId));
      finishPending(requestId);
      if (requestId) {
        silentRequestIdsRef.current.delete(requestId);
      }
      if (isSilent) {
        return;
      }
      const errorText = `[${parsed.payload.code}] ${parsed.payload.message}`;
      if (workModeRef.current === "tmux") {
        const tmuxTargetForError = resolveTmuxTargetForOutput(errorText, requestId);
        if (requestId) {
          clearTmuxProgressByRequest(requestId);
        } else {
          clearTmuxProgressByTarget(tmuxTargetForError);
        }
        appendTerminalRender(errorText, tmuxTargetForError);
      } else {
        appendMessage({
          id: randomId("assistant-error"),
          role: "assistant",
          text: errorText,
        });
      }
      return;
    }

  if (parsed.type === "relay.ack" && !parsed.payload.ok) {
      const ackText = parsed.payload.message ? `Request failed: ${parsed.payload.message}` : "Request failed";
      appendSystemText(ackText);
    }
  };

  const clearReconnectTimer = () => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  };

  function scheduleAutoReconnect(delayMs = 900): void {
    if (reconnectTimerRef.current) {
      return;
    }
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      if (!keepConnectionRef.current) {
        return;
      }
      if (appStateRef.current !== "active") {
        return;
      }
      if (stageRef.current !== "chat") {
        return;
      }
      if (connectionStateRef.current === "online" || connectionStateRef.current === "connecting") {
        return;
      }
      connectWithToken();
    }, Math.max(0, delayMs));
  }

  const connectWithToken = () => {
    const urlText = relayUrl.trim() || DEFAULT_RELAY_URL;
    const tokenText = token.trim() || DEFAULT_TOKEN;
    if (isConnecting) {
      return;
    }
    keepConnectionRef.current = true;
    clearReconnectTimer();
    void (async () => {
      try {
        if (rememberLogin) {
          const saved: SavedLoginPrefs = {
            remember: true,
            relayUrl: urlText,
            token: tokenText,
          };
          await AsyncStorage.setItem(LOGIN_PREFS_STORAGE_KEY, JSON.stringify(saved));
          return;
        }
        await AsyncStorage.removeItem(LOGIN_PREFS_STORAGE_KEY);
      } catch {
        // Keep login flow working even when local persistence fails.
      }
    })();

    wsRef.current?.close();
    wsRef.current = null;
    clearTmuxProgress();
    setTmuxRenderByTarget({});
    setTmuxLiveProgressByTarget({});
    tmuxProgressRequestTargetRef.current.clear();
    selectedTmuxTargetRef.current = "";
    setTmuxNewDialogOpen(false);
    setTmuxNewNameInput("");
    silentRequestIdsRef.current.clear();
    if (closeSwitchTimerRef.current) {
      clearTimeout(closeSwitchTimerRef.current);
      closeSwitchTimerRef.current = null;
    }

    setStage("chat");
    setConnectionState("connecting");
    const connectingText = "Connecting to TFClaw relay...";
    appendSystemText(connectingText);

    const wsUrl = `${urlText.replace(/\/+$/, "")}/?role=client&token=${encodeURIComponent(tokenText)}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      if (wsRef.current !== ws) {
        return;
      }
      setConnectionState("online");
      const connectedText = "Connected.";
      appendSystemText(connectedText);
      sendJson({
        type: "client.hello",
        payload: {
          clientType: "mobile",
        },
      });
      // Auto-refresh tmux targets immediately after connecting.
      setTimeout(() => {
        void sendSilentCommandText("/tmux panes");
      }, 180);
    };

    ws.onmessage = (event) => {
      if (wsRef.current !== ws) {
        return;
      }
      handleIncoming(String(event.data));
    };

    ws.onerror = () => {
      if (wsRef.current !== ws) {
        return;
      }
      const errorText = "Socket error. Check relay URL/token and network.";
      appendSystemText(errorText);
    };

    ws.onclose = () => {
      if (wsRef.current !== ws) {
        return;
      }
      setConnectionState("offline");
      setAgent(undefined);
      wsRef.current = null;
      pendingMapRef.current.clear();
      setTmuxNewDialogOpen(false);
      setTmuxNewNameInput("");
      silentRequestIdsRef.current.clear();
      setTmuxRenderByTarget({});
      setTmuxLiveProgressByTarget({});
      tmuxProgressRequestTargetRef.current.clear();
      selectedTmuxTargetRef.current = "";
      if (closeSwitchTimerRef.current) {
        clearTimeout(closeSwitchTimerRef.current);
        closeSwitchTimerRef.current = null;
      }
      clearTmuxProgress();
      const disconnectedText = "Disconnected.";
      appendSystemText(disconnectedText);
      if (keepConnectionRef.current && appStateRef.current === "active") {
        scheduleAutoReconnect(900);
      }
    };
  };

  const backToLogin = () => {
    keepConnectionRef.current = false;
    clearReconnectTimer();
    wsRef.current?.close();
    wsRef.current = null;
    setConnectionState("offline");
    setAgent(undefined);
    pendingMapRef.current.clear();
    setTmuxNewDialogOpen(false);
    setTmuxNewNameInput("");
    silentRequestIdsRef.current.clear();
    setTmuxRenderByTarget({});
    setTmuxLiveProgressByTarget({});
    tmuxProgressRequestTargetRef.current.clear();
    selectedTmuxTargetRef.current = "";
    if (closeSwitchTimerRef.current) {
      clearTimeout(closeSwitchTimerRef.current);
      closeSwitchTimerRef.current = null;
    }
    clearTmuxProgress();
    setStage("login");
  };

  const sendCommandText = (commandText: string): boolean => {
    const text = commandText.trim();
    if (!text) {
      return false;
    }

    const lowered = text.toLowerCase();
    let targetMode = workModeRef.current;
    if (lowered === "/pt on" || lowered === "/passthrough on") {
      setHideTfclawWindowInTmux(true);
      targetMode = "tmux";
      switchWorkMode("tmux");
    }
    if (lowered === "/pt off" || lowered === "/passthrough off") {
      targetMode = "tfclaw";
      switchWorkMode("tfclaw");
    }
    const tmuxTargetForCommand = resolveTmuxTargetForCommand(text, targetMode);
    if (targetMode === "tmux") {
      clearTmuxProgressByTarget(tmuxTargetForCommand);
      appendTerminalRender(`$ ${text}`, tmuxTargetForCommand);
    } else {
      appendMessage({
        id: randomId("user"),
        role: "user",
        text,
      });
    }

    if (!isOnline) {
      const offlineText = "Not connected yet. Tap Reconnect after checking URL/token.";
      if (targetMode === "tmux") {
        appendTerminalRender(offlineText, tmuxTargetForCommand);
      } else {
        appendSystemText(offlineText);
      }
      return false;
    }

    const requestId = randomId("tfclaw");
    const ok = sendJson({
      type: "client.command",
      requestId,
      payload: {
        command: "tfclaw.command",
        text,
        sessionKey: "mobile-app",
      },
    });

    if (!ok) {
      return false;
    }

    pendingMapRef.current.set(requestId, {
      tmuxTargetKey: targetMode === "tmux" ? tmuxTargetForCommand : undefined,
    });
    return true;
  };

  const handlePtOn = () => {
    void sendCommandText("/pt on");
    const normalizedTarget = normalizeTmuxTarget(selectedTmuxTarget);
    if (normalizedTarget) {
      void sendCommandText(`/tmux target ${normalizedTarget}`);
    } else {
      void sendCommandText("/tmux panes");
    }
  };

  const handlePtOff = () => {
    void sendCommandText("/pt off");
  };

  const handleTCapture = () => {
    void sendCommandText("/tcapture");
  };

  const applyUiScalePercent = (value: number) => {
    const clamped = clampUiScalePercent(value);
    setUiScalePercent(clamped);
    setUiScaleInput(String(clamped));
  };

  const handleCycleUiScale = () => {
    const current = clampUiScalePercent(uiScalePercent);
    const existingIndex = UI_SCALE_STEPS.findIndex((item) => item === current);
    if (existingIndex >= 0) {
      applyUiScalePercent(UI_SCALE_STEPS[(existingIndex + 1) % UI_SCALE_STEPS.length]);
      return;
    }
    const next = UI_SCALE_STEPS.find((item) => item > current) ?? UI_SCALE_STEPS[0];
    applyUiScalePercent(next);
  };

  const handleUiScaleInputSubmit = () => {
    const parsed = Number.parseInt(uiScaleInput, 10);
    if (!Number.isFinite(parsed)) {
      setUiScaleInput(String(clampUiScalePercent(uiScalePercent)));
      return;
    }
    applyUiScalePercent(parsed);
  };

  const handleCycleContentFont = () => {
    setContentFontStep((prev) => (prev + 1) % CONTENT_FONT_SCALES.length);
  };

  const closeTextActionMenu = () => {
    setTextActionMenu((prev) => ({
      ...prev,
      visible: false,
    }));
    setSelectedTextMessageId("");
    setTerminalTextSelected(false);
  };

  const openTextActionMenu = (
    event: GestureResponderEvent,
    text: string,
    sourceType: "message" | "tmux",
    sourceId?: string,
  ) => {
    const safeText = String(text ?? "");
    if (!safeText.trim()) {
      return;
    }
    const screen = Dimensions.get("window");
    const menuWidth = Math.min(360, Math.max(260, screen.width - 24));
    const menuHeight = 172;
    const x = Math.max(10, Math.min(event.nativeEvent.pageX - menuWidth / 2, screen.width - menuWidth - 10));
    const y = Math.max(10, Math.min(event.nativeEvent.pageY - menuHeight - 12, screen.height - menuHeight - 10));

    if (sourceType === "message") {
      setSelectedTextMessageId(sourceId ?? "");
      setTerminalTextSelected(false);
    } else {
      setSelectedTextMessageId("");
      setTerminalTextSelected(true);
    }

    setTextActionMenu({
      visible: true,
      text: safeText,
      x,
      y,
      sourceType,
      sourceId,
    });
  };

  const handleCopySelectedText = () => {
    const text = textActionMenu.text;
    if (!text) {
      closeTextActionMenu();
      return;
    }
    Clipboard.setString(text);
    closeTextActionMenu();
  };

  const handleUnimplementedTextAction = () => {
    closeTextActionMenu();
  };

  const handleToggleIgnoreTopPanels = () => {
    setIgnoreTopPanels((prev) => {
      const next = !prev;
      if (next) {
        setTmuxTargetMenuOpen(false);
      }
      return next;
    });
  };

  const handleToggleRememberLogin = () => {
    setRememberLogin((prev) => {
      const next = !prev;
      if (!next) {
        void AsyncStorage.removeItem(LOGIN_PREFS_STORAGE_KEY).catch(() => {
          // Ignore persistence failures when clearing remembered credentials.
        });
      }
      return next;
    });
  };

  const handleClearLoginInputs = () => {
    setRelayUrl("");
    setToken("");
  };

  const handleTmuxLinesApply = (lines: number) => {
    const clamped = clampTmuxLines(lines);
    setTmuxLines(clamped);
    setTmuxLinesInput(String(clamped));
    void sendCommandText(`/tmux lines ${clamped}`);
  };

  const handleTmuxLinesTrackLayout = (event: LayoutChangeEvent) => {
    const width = Math.max(1, Math.round(event.nativeEvent.layout.width));
    tmuxLinesTrackWidthRef.current = width;
    if (width !== tmuxLinesTrackWidth) {
      setTmuxLinesTrackWidth(width);
    }
  };

  const updateTmuxLinesFromTrack = (rawX: number, commit = false) => {
    const width = Math.max(1, tmuxLinesTrackWidthRef.current);
    const x = Math.max(0, Math.min(rawX, width));
    const ratio = x / width;
    const value = clampTmuxLines(TMUX_LINES_MIN + ratio * (TMUX_LINES_MAX - TMUX_LINES_MIN));
    setTmuxLines(value);
    setTmuxLinesInput(String(value));
    if (commit) {
      void sendCommandText(`/tmux lines ${value}`);
    }
  };

  const tmuxLinesPanResponder = PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (event) => {
      updateTmuxLinesFromTrack(event.nativeEvent.locationX, false);
    },
    onPanResponderMove: (event) => {
      updateTmuxLinesFromTrack(event.nativeEvent.locationX, false);
    },
    onPanResponderRelease: (event) => {
      updateTmuxLinesFromTrack(event.nativeEvent.locationX, true);
    },
    onPanResponderTerminate: (event) => {
      updateTmuxLinesFromTrack(event.nativeEvent.locationX, true);
    },
  });

  const handleTmuxLinesInputSubmit = () => {
    const parsed = Number.parseInt(tmuxLinesInput, 10);
    if (Number.isFinite(parsed)) {
      handleTmuxLinesApply(parsed);
      return;
    }
    setTmuxLinesInput(String(tmuxLines));
  };

  const handleRefreshTmuxTargets = () => {
    void sendCommandText("/tmux panes");
  };

  const closeTmuxNewDialog = () => {
    setTmuxNewDialogOpen(false);
    setTmuxNewNameInput("");
  };

  const handleOpenTmuxNewDialog = () => {
    setTmuxTargetMenuOpen(false);
    setTmuxNewNameInput("");
    setTmuxNewDialogOpen(true);
  };

  const handleCreateTmuxWindow = () => {
    const windowName = sanitizeTmuxWindowName(tmuxNewNameInput);
    if (!windowName) {
      appendSystemText("Enter tmux window name.");
      return;
    }
    if (workModeRef.current !== "tmux") {
      void sendCommandText("/pt on");
    }
    const sent = sendCommandText(`/tmux new ${windowName}`);
    if (!sent) {
      return;
    }
    closeTmuxNewDialog();
    if (closeSwitchTimerRef.current) {
      clearTimeout(closeSwitchTimerRef.current);
      closeSwitchTimerRef.current = null;
    }
    closeSwitchTimerRef.current = setTimeout(() => {
      void sendSilentCommandText("/tmux panes");
      closeSwitchTimerRef.current = null;
    }, 220);
  };

  const handleCloseTmuxTarget = () => {
    const currentTarget = normalizeTmuxTarget(selectedTmuxTarget);
    if (!currentTarget) {
      appendSystemText("Select tmux window before closing.");
      return;
    }

    const normalizedTargets = Array.from(
      new Set(tmuxTargets.map((target) => normalizeTmuxTarget(target)).filter((target) => target.length > 0)),
    );
    const currentIndex = normalizedTargets.indexOf(currentTarget);
    let fallbackTarget = "";
    if (currentIndex > 0) {
      fallbackTarget = normalizedTargets[currentIndex - 1];
    } else if (currentIndex === 0 && normalizedTargets.length > 1) {
      fallbackTarget = normalizedTargets[1];
    } else if (currentIndex < 0) {
      fallbackTarget = normalizedTargets.find((target) => target !== currentTarget) ?? "";
    }

    const sent = sendCommandText(`/tmux close ${currentTarget}`);
    if (!sent) {
      return;
    }

    setTmuxTargetMenuOpen(false);
    selectedTmuxTargetRef.current = fallbackTarget;
    setSelectedTmuxTarget(fallbackTarget);

    if (closeSwitchTimerRef.current) {
      clearTimeout(closeSwitchTimerRef.current);
      closeSwitchTimerRef.current = null;
    }
    closeSwitchTimerRef.current = setTimeout(() => {
      if (fallbackTarget) {
        void sendCommandText(`/tmux target ${fallbackTarget}`);
      }
      void sendSilentCommandText("/tmux panes");
      closeSwitchTimerRef.current = null;
    }, 220);
  };

  const handleSelectTmuxTarget = (target: string) => {
    const normalized = normalizeTmuxTarget(target);
    if (!normalized) {
      return;
    }
    selectedTmuxTargetRef.current = normalized;
    setSelectedTmuxTarget(normalized);
    setTmuxTargetMenuOpen(false);
    clearTmuxProgressByTarget(normalized);
    void sendCommandText(`/tmux target ${normalized}`);
  };

  const handleToggleTfclawWindowInTmux = () => {
    if (workMode !== "tmux") {
      return;
    }
    setHideTfclawWindowInTmux((prev) => !prev);
  };

  const handleTmuxKeyShortcut = (token: string) => {
    const normalized = token.trim();
    if (!normalized) {
      return;
    }
    if (workModeRef.current !== "tmux") {
      void sendCommandText("/pt on");
    }
    void sendCommandText(`/tkey ${normalized}`);
  };

  const sendChat = () => {
    const text = inputText.trim();
    if (!text) {
      return;
    }
    setInputText("");
    void sendCommandText(text);
  };

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const raw = await AsyncStorage.getItem(LOGIN_PREFS_STORAGE_KEY);
        if (!active || !raw) {
          return;
        }
        const parsed = JSON.parse(raw) as SavedLoginPrefs;
        const shouldRemember = Boolean(parsed?.remember);
        setRememberLogin(shouldRemember);
        if (!shouldRemember) {
          return;
        }
        if (typeof parsed.relayUrl === "string") {
          setRelayUrl(parsed.relayUrl);
        }
        if (typeof parsed.token === "string") {
          setToken(parsed.token);
        }
      } catch {
        // Ignore invalid persisted values and continue with defaults.
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    return () => {
      keepConnectionRef.current = false;
      clearReconnectTimer();
      wsRef.current?.close();
      silentRequestIdsRef.current.clear();
      if (closeSwitchTimerRef.current) {
        clearTimeout(closeSwitchTimerRef.current);
        closeSwitchTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    stageRef.current = stage;
    if (stage !== "chat") {
      keepConnectionRef.current = false;
      clearReconnectTimer();
    }
  }, [stage]);

  useEffect(() => {
    connectionStateRef.current = connectionState;
  }, [connectionState]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      appStateRef.current = nextState;
      if (nextState !== "active") {
        return;
      }
      if (!keepConnectionRef.current || stageRef.current !== "chat") {
        return;
      }
      if (connectionStateRef.current === "online" || connectionStateRef.current === "connecting") {
        return;
      }
      scheduleAutoReconnect(180);
    });

    return () => {
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    if (workMode !== "tmux") {
      setHideTfclawWindowInTmux(false);
      setTmuxKeyPanelOpen(false);
      setTmuxNewDialogOpen(false);
      setTmuxNewNameInput("");
      setTmuxLiveProgressByTarget({});
      tmuxProgressRequestTargetRef.current.clear();
    }
  }, [workMode]);

  useEffect(() => {
    if (!ignoreTopPanels) {
      return;
    }
    setTmuxTargetMenuOpen(false);
  }, [ignoreTopPanels]);

  useEffect(() => {
    selectedTmuxTargetRef.current = normalizeTmuxTarget(selectedTmuxTarget);
  }, [selectedTmuxTarget]);

  useEffect(() => {
    setSelectedTmuxTarget((prev) => {
      const normalizedPrev = normalizeTmuxTarget(prev);
      if (normalizedPrev && tmuxTargets.includes(normalizedPrev)) {
        return normalizedPrev;
      }
      return tmuxTargets[0] ?? "";
    });
  }, [tmuxTargets]);

  const tmuxLinesRatio = (clampTmuxLines(tmuxLines) - TMUX_LINES_MIN) / (TMUX_LINES_MAX - TMUX_LINES_MIN);
  const tmuxLinesFillWidth = Math.max(0, Math.min(tmuxLinesTrackWidth, tmuxLinesTrackWidth * tmuxLinesRatio));
  const tmuxLinesThumbLeft = Math.max(
    0,
    Math.min(tmuxLinesTrackWidth - TMUX_LINES_SLIDER_THUMB_SIZE, tmuxLinesFillWidth - TMUX_LINES_SLIDER_THUMB_SIZE / 2),
  );
  const scrollOutputsToEnd = (animated = false) => {
    chatScrollRef.current?.scrollToEnd({ animated });
    terminalScrollRef.current?.scrollToEnd({ animated });
  };
  const activeTmuxRenderKey = normalizeTmuxTarget(selectedTmuxTarget) || TMUX_RENDER_DEFAULT_KEY;
  const terminalDisplay = useMemo(() => {
    const baseRender = tmuxRenderByTarget[activeTmuxRenderKey] ?? "";
    const base = baseRender || "# tmux renderer\n# output will appear here";
    if (workMode !== "tmux") {
      return base;
    }
    const live = stripAnsi(tmuxLiveProgressByTarget[activeTmuxRenderKey] ?? "").replace(/\r\n/g, "\n").trim();
    if (!live) {
      return base;
    }
    return `${base}${base.endsWith("\n") ? "" : "\n"}${live}`;
  }, [activeTmuxRenderKey, tmuxLiveProgressByTarget, tmuxRenderByTarget, workMode]);

  useEffect(() => {
    if (workMode !== "tmux") {
      return;
    }
    const timer = setTimeout(() => {
      scrollOutputsToEnd(false);
    }, 0);
    return () => {
      clearTimeout(timer);
    };
  }, [terminalDisplay, workMode]);

  useEffect(() => {
    const showEvent = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const onShow = Keyboard.addListener(showEvent, () => {
      setTimeout(() => scrollOutputsToEnd(false), 0);
      setTimeout(() => scrollOutputsToEnd(false), 120);
    });
    const onHide = Keyboard.addListener(hideEvent, () => {
      setTimeout(() => scrollOutputsToEnd(false), 0);
    });
    return () => {
      onShow.remove();
      onHide.remove();
    };
  }, []);

  const renderMessage = (msg: ChatMessage) => {
    const isUser = msg.role === "user";
    const isSystem = msg.role === "system";
    const name = isSystem ? "system" : isUser ? "you" : "tfclaw";

    return (
      <View key={msg.id} style={[styles.msgWrap, isUser ? styles.msgWrapUser : styles.msgWrapAssistant]}>
        <Text
          style={[
            styles.msgName,
            dynamicUi.msgName,
            isUser ? styles.msgNameUser : undefined,
            isSystem ? styles.msgNameSystem : undefined,
          ]}
        >
          {name}
        </Text>
        <View
          style={[
            styles.msgBubble,
            isUser ? styles.msgUser : styles.msgAssistant,
            isSystem ? styles.msgSystem : undefined,
            msg.progress ? styles.msgProgress : undefined,
          ]}
        >
          <TextInput
            value={msg.text}
            editable
            multiline
            scrollEnabled={false}
            contextMenuHidden={false}
            selectTextOnFocus
            showSoftInputOnFocus={false}
            onChangeText={() => {}}
            style={[
              styles.msgText,
              styles.msgTextSelectableInput,
              dynamicUi.msgText,
              isSystem ? styles.msgSystemText : undefined,
              isSystem ? dynamicUi.msgSystemText : undefined,
            ]}
          />
        </View>
      </View>
    );
  };

    return (
    <SafeAreaView style={styles.safe}>
      <ExpoStatusBar style="light" />
      <KeyboardAvoidingView
        behavior="padding"
        keyboardVerticalOffset={0}
        style={styles.container}
      >
        <View style={styles.header}>
          <View style={styles.headerTopRow}>
            <View style={styles.headerTitleWrap}>
              <Text style={[styles.title, dynamicUi.title]}>TFClaw Chat</Text>
              <Text style={[styles.subtitle, dynamicUi.subtitle]}>
                {statusText} | {modeText}
              </Text>
            </View>
            <View style={styles.headerActions}>
              <Pressable style={[styles.headerActionBtn, dynamicUi.headerActionBtn]} onPress={handleCycleContentFont}>
                <Text style={[styles.headerActionBtnText, dynamicUi.btnText]}>T {contentFontLabel}</Text>
              </Pressable>
              <Pressable style={[styles.headerActionBtn, dynamicUi.headerActionBtn]} onPress={handleCycleUiScale}>
                <Text style={[styles.headerActionBtnText, dynamicUi.btnText]}>A {uiScaleLabel}</Text>
              </Pressable>
              <View style={[styles.headerScaleInputWrap, dynamicUi.headerScaleInputWrap]}>
                <TextInput
                  style={[styles.headerScaleInput, dynamicUi.headerScaleInput]}
                  value={uiScaleInput}
                  onChangeText={(text) => setUiScaleInput(text.replace(/[^0-9]/g, ""))}
                  keyboardType="number-pad"
                  returnKeyType="done"
                  onSubmitEditing={handleUiScaleInputSubmit}
                  onEndEditing={handleUiScaleInputSubmit}
                  placeholder={String(UI_SCALE_DEFAULT_PERCENT)}
                  placeholderTextColor="#8ca5b0"
                  maxLength={3}
                />
              </View>
              {stage === "chat" ? (
                <Pressable
                  style={[
                    styles.headerActionBtn,
                    styles.headerActionBtnIgnore,
                    dynamicUi.headerActionBtn,
                  ]}
                  onPress={handleToggleIgnoreTopPanels}
                >
                  <Text style={[styles.headerActionBtnText, dynamicUi.btnText]}>
                    {ignoreTopPanels ? "Show Panel" : "Ignore"}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          </View>
        </View>

        {stage === "login" ? (
          <View style={styles.card}>
            <Text style={[styles.label, dynamicUi.label]}>Relay URL</Text>
            <TextInput
              style={[styles.input, dynamicUi.input]}
              value={relayUrl}
              onChangeText={setRelayUrl}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder={DEFAULT_RELAY_URL}
              placeholderTextColor="#6f878f"
            />
            <Text style={[styles.label, dynamicUi.label]}>Token</Text>
            <TextInput
              style={[styles.input, dynamicUi.input]}
              value={token}
              onChangeText={setToken}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder={DEFAULT_TOKEN}
              placeholderTextColor="#6f878f"
            />
            <Pressable style={styles.rememberRow} onPress={handleToggleRememberLogin}>
              <View style={[styles.rememberBox, rememberLogin ? styles.rememberBoxActive : undefined]}>
                {rememberLogin ? <Text style={[styles.rememberBoxMark, dynamicUi.metaText]}>✓</Text> : null}
              </View>
              <Text style={[styles.metaText, dynamicUi.metaText]}>Remember URL and token on this device</Text>
            </Pressable>
            <View style={styles.loginActionsRow}>
              <Pressable style={[styles.btn, dynamicUi.btn, styles.btnPrimary, styles.loginActionBtn]} onPress={connectWithToken}>
                <Text style={[styles.btnText, dynamicUi.btnText]}>Login</Text>
              </Pressable>
              <Pressable style={[styles.btn, dynamicUi.btn, styles.btnGhost, styles.loginActionBtn]} onPress={handleClearLoginInputs}>
                <Text style={[styles.btnText, dynamicUi.btnText]}>Clear</Text>
              </Pressable>
            </View>
            <Text style={[styles.metaText, dynamicUi.metaText]}>Tap Login to enter chat immediately and start connecting.</Text>
            <Text style={[styles.metaText, dynamicUi.metaText]}>Leave URL/token blank to use default values.</Text>
            <Text style={[styles.metaText, dynamicUi.metaText]}>For Android emulator use: `adb reverse tcp:8787 tcp:8787`.</Text>
          </View>
        ) : (
          <View
            style={[styles.card, styles.chatCard, ignoreTopPanels ? styles.chatCardIgnore : undefined]}
            onLayout={() => scrollOutputsToEnd(false)}
          >
            {!ignoreTopPanels ? (
              <>
                <View style={styles.chatTopRow}>
                  <View style={styles.chatTopLeft}>
                    <Text style={[styles.sectionTitle, dynamicUi.sectionTitle]}>Conversation</Text>
                    <View
                      style={[
                        styles.connectionDot,
                        connectionState === "online" ? styles.connectionDotOnline : styles.connectionDotOffline,
                      ]}
                    />
                  </View>
                  <View style={styles.chatTopBtns}>
                    <Pressable
                      style={[styles.btn, dynamicUi.btn, styles.topBtn, dynamicUi.topBtn, styles.topBtnCapture]}
                      onPress={handleTCapture}
                    >
                      <Text style={[styles.btnText, dynamicUi.btnText]}>/tcapture</Text>
                    </Pressable>
                    <Pressable
                      style={[styles.btn, dynamicUi.btn, styles.topBtn, dynamicUi.topBtn, styles.topBtnBright]}
                      onPress={connectWithToken}
                      disabled={isConnecting}
                    >
                      <Text style={[styles.btnText, dynamicUi.btnText]}>{isConnecting ? "Connecting" : "Reconnect"}</Text>
                    </Pressable>
                    <Pressable style={[styles.btn, dynamicUi.btn, styles.topBtn, dynamicUi.topBtn, styles.topBtnBright]} onPress={backToLogin}>
                      <Text style={[styles.btnText, dynamicUi.btnText]}>Back</Text>
                    </Pressable>
                  </View>
                </View>
                <View style={styles.modeRow}>
                  <View style={[styles.modeBadge, workMode === "tmux" ? styles.modeTmux : styles.modeTfclaw]}>
                    <Text style={[styles.modeBadgeText, dynamicUi.modeBadgeText]}>{modeText}</Text>
                  </View>
                  <Pressable style={[styles.btn, dynamicUi.btn, styles.modeBtnOn]} onPress={handlePtOn}>
                    <Text style={[styles.btnText, dynamicUi.btnText]}>PT ON</Text>
                  </Pressable>
                  <Pressable style={[styles.btn, dynamicUi.btn, styles.modeBtnOff]} onPress={handlePtOff}>
                    <Text style={[styles.btnText, dynamicUi.btnText]}>PT OFF</Text>
                  </Pressable>
                  {workMode === "tmux" ? (
                    <Pressable style={[styles.btn, dynamicUi.btn, styles.modeBtnToggleTfclaw]} onPress={handleToggleTfclawWindowInTmux}>
                      <Text style={[styles.btnText, dynamicUi.btnText]}>
                        {hideTfclawWindowInTmux ? "Show TFClaw" : "Hide TFClaw"}
                      </Text>
                    </Pressable>
                  ) : null}
                </View>

                <View style={styles.linesRow}>
                  <Text style={[styles.metaText, dynamicUi.metaText]}>/tmux lines:</Text>
                  <View
                    style={styles.linesSliderWrap}
                    onLayout={handleTmuxLinesTrackLayout}
                    {...tmuxLinesPanResponder.panHandlers}
                  >
                    <View style={styles.linesSliderTrack}>
                      <View style={[styles.linesSliderFill, { width: tmuxLinesFillWidth }]} />
                    </View>
                    <View style={[styles.linesSliderThumb, { left: tmuxLinesThumbLeft }]} />
                  </View>
                  <TextInput
                    style={[styles.input, dynamicUi.input, styles.linesInput, dynamicUi.linesInput]}
                    value={tmuxLinesInput}
                    onChangeText={setTmuxLinesInput}
                    keyboardType="number-pad"
                    returnKeyType="done"
                    onSubmitEditing={handleTmuxLinesInputSubmit}
                  />
                  <Pressable style={[styles.linesApplyBtn, dynamicUi.linesApplyBtn]} onPress={handleTmuxLinesInputSubmit}>
                    <Text style={[styles.linesApplyBtnText, dynamicUi.linesApplyBtnText]}>Set</Text>
                  </Pressable>
                </View>

                <View style={styles.targetRow}>
                  <Text style={[styles.metaText, dynamicUi.metaText]}>tmux window:</Text>
                  <Pressable
                    style={styles.targetPickerBtn}
                    onPress={() => setTmuxTargetMenuOpen((prev) => !prev)}
                  >
                    <Text style={[styles.targetPickerText, dynamicUi.targetPickerText]}>
                      {selectedTmuxTarget || "Select target"}
                    </Text>
                  </Pressable>
                  <Pressable style={[styles.linesApplyBtn, dynamicUi.linesApplyBtn, styles.targetNewBtn]} onPress={handleOpenTmuxNewDialog}>
                    <Text style={[styles.linesApplyBtnText, dynamicUi.linesApplyBtnText]}>New</Text>
                  </Pressable>
                  <Pressable style={[styles.linesApplyBtn, dynamicUi.linesApplyBtn]} onPress={handleRefreshTmuxTargets}>
                    <Text style={[styles.linesApplyBtnText, dynamicUi.linesApplyBtnText]}>Refresh</Text>
                  </Pressable>
                  <Pressable style={[styles.linesApplyBtn, dynamicUi.linesApplyBtn, styles.targetCloseBtn]} onPress={handleCloseTmuxTarget}>
                    <Text style={[styles.linesApplyBtnText, dynamicUi.linesApplyBtnText]}>Close</Text>
                  </Pressable>
                </View>
                {tmuxTargetMenuOpen ? (
                  <View style={styles.targetMenu}>
                    {tmuxTargets.length === 0 ? (
                      <Text style={[styles.metaText, dynamicUi.metaText]}>No tmux panes yet. Tap Refresh.</Text>
                    ) : (
                      tmuxTargets.map((target) => (
                        <Pressable
                          key={target}
                          style={[
                            styles.targetMenuItem,
                            selectedTmuxTarget === target ? styles.targetMenuItemActive : undefined,
                          ]}
                          onPress={() => handleSelectTmuxTarget(target)}
                        >
                          <Text style={[styles.targetMenuItemText, dynamicUi.targetMenuItemText]}>{target}</Text>
                        </Pressable>
                      ))
                    )}
                  </View>
                ) : null}

                <Text style={[styles.metaText, dynamicUi.metaText]}>
                  {agentText} | lines: {tmuxLines} | target: {selectedTmuxTarget || "(none)"}
                </Text>
              </>
            ) : null}

            {!(workMode === "tmux" && hideTfclawWindowInTmux) ? (
              <ScrollView
                ref={chatScrollRef}
                style={[styles.chatList, ignoreTopPanels ? styles.chatListIgnore : undefined]}
                contentContainerStyle={styles.chatListContent}
                keyboardShouldPersistTaps="handled"
                onContentSizeChange={() => chatScrollRef.current?.scrollToEnd({ animated: true })}
              >
                {messages.length === 0 ? (
                  <Text style={[styles.emptyText, dynamicUi.emptyText]}>No messages yet.</Text>
                ) : (
                  messages.map(renderMessage)
                )}
              </ScrollView>
            ) : null}

            {workMode === "tmux" ? (
              <View
                style={[
                  styles.terminalWrap,
                  hideTfclawWindowInTmux
                    ? styles.terminalWrapFullscreen
                    : ignoreTopPanels
                      ? styles.terminalWrapSplit
                      : styles.terminalWrapInline,
                ]}
                onLayout={() => scrollOutputsToEnd(false)}
              >
                <Text style={[styles.metaText, dynamicUi.metaText]}>tmux renderer</Text>
                <ScrollView
                  ref={terminalScrollRef}
                  style={styles.terminalView}
                  contentContainerStyle={styles.terminalContent}
                  keyboardShouldPersistTaps="handled"
                  onContentSizeChange={() => terminalScrollRef.current?.scrollToEnd({ animated: true })}
                >
                  <View>
                    <TextInput
                      value={terminalDisplay}
                      editable
                      multiline
                      scrollEnabled={false}
                      contextMenuHidden={false}
                      selectTextOnFocus
                      showSoftInputOnFocus={false}
                      onChangeText={() => {}}
                      style={[styles.terminalText, styles.terminalTextSelectableInput, dynamicUi.terminalText]}
                    />
                  </View>
                </ScrollView>
              </View>
            ) : null}

            <View style={styles.sendRow}>
              <TextInput
                style={[styles.input, dynamicUi.input, styles.sendInput]}
                value={inputText}
                onChangeText={setInputText}
                placeholder={workMode === "tmux" ? "tmux command..." : "Type command or /tmux ..."}
                placeholderTextColor="#6f878f"
                autoCapitalize="none"
                autoCorrect={false}
                blurOnSubmit={false}
                onSubmitEditing={sendChat}
              />
              <Pressable style={[styles.btn, dynamicUi.btn, styles.btnPrimary]} onPress={sendChat}>
                <Text style={[styles.btnText, dynamicUi.btnText]}>Send</Text>
              </Pressable>
            </View>
            <View style={styles.keyToggleRow}>
              <Pressable
                style={[styles.btn, dynamicUi.btn, styles.keyToggleBtn]}
                onPress={() => setTmuxKeyPanelOpen((prev) => !prev)}
              >
                <Text style={[styles.btnText, dynamicUi.btnText]}>{tmuxKeyPanelOpen ? "Hide Key" : "Key"}</Text>
              </Pressable>
              <Text style={[styles.metaText, dynamicUi.metaText]}>Send /tkey shortcuts to tmux</Text>
            </View>
            {tmuxKeyPanelOpen ? (
              <View style={styles.keyPanel}>
                {TMUX_KEY_SHORTCUTS.map((item) => (
                  <Pressable
                    key={item.token}
                    style={[styles.keyPanelBtn, dynamicUi.keyPanelBtn]}
                    onPress={() => handleTmuxKeyShortcut(item.token)}
                  >
                    <Text style={[styles.keyPanelBtnText, dynamicUi.keyPanelBtnText]}>{item.label}</Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
          </View>
        )}
        <Modal
          visible={textActionMenu.visible}
          transparent
          animationType="fade"
          onRequestClose={closeTextActionMenu}
        >
          <View style={styles.textActionBackdrop}>
            <Pressable style={StyleSheet.absoluteFill} onPress={closeTextActionMenu} />
            <View
              style={[
                styles.textActionCard,
                {
                  left: textActionMenu.x,
                  top: textActionMenu.y,
                },
              ]}
            >
              <View style={styles.textActionRow}>
                {TEXT_ACTION_MENU_BUTTONS.map((item) => (
                  <Pressable
                    key={item.id}
                    style={[
                      styles.textActionBtn,
                      dynamicUi.textActionBtn,
                      item.enabled ? styles.textActionBtnEnabled : styles.textActionBtnDisabled,
                    ]}
                    onPress={item.id === "copy" ? handleCopySelectedText : handleUnimplementedTextAction}
                  >
                    <Text style={[styles.textActionBtnText, dynamicUi.textActionBtnText]}>{item.label}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
          </View>
        </Modal>
        <Modal
          visible={tmuxNewDialogOpen}
          transparent
          animationType="fade"
          onRequestClose={closeTmuxNewDialog}
        >
          <View style={styles.dialogBackdrop}>
            <View style={styles.dialogCard}>
              <Text style={[styles.dialogTitle, dynamicUi.dialogTitle]}>New tmux window</Text>
              <Text style={[styles.metaText, dynamicUi.metaText]}>name:</Text>
              <TextInput
                style={[styles.input, dynamicUi.input]}
                value={tmuxNewNameInput}
                onChangeText={setTmuxNewNameInput}
                placeholder="window-name"
                placeholderTextColor="#6f878f"
                autoCapitalize="none"
                autoCorrect={false}
                autoFocus
                returnKeyType="done"
                onSubmitEditing={handleCreateTmuxWindow}
              />
              <View style={styles.dialogActions}>
                <Pressable style={[styles.linesApplyBtn, dynamicUi.linesApplyBtn, styles.dialogCancelBtn]} onPress={closeTmuxNewDialog}>
                  <Text style={[styles.linesApplyBtnText, dynamicUi.linesApplyBtnText]}>Cancel</Text>
                </Pressable>
                <Pressable style={[styles.linesApplyBtn, dynamicUi.linesApplyBtn, styles.dialogConfirmBtn]} onPress={handleCreateTmuxWindow}>
                  <Text style={[styles.linesApplyBtnText, dynamicUi.linesApplyBtnText]}>Create</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: "#0d1418",
  },
  container: {
    flex: 1,
    paddingHorizontal: 12,
    paddingBottom: 12,
    paddingTop: Platform.OS === "android" ? (NativeStatusBar.currentHeight ?? 0) + 8 : 12,
    gap: 10,
  },
  header: {
    borderRadius: 12,
    backgroundColor: "#16232a",
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: "#2c434f",
  },
  headerTopRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  headerTitleWrap: {
    flex: 1,
    minWidth: 0,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  headerScaleInputWrap: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#4f6a76",
    backgroundColor: "#122129",
    minWidth: 56,
    alignItems: "center",
    justifyContent: "center",
  },
  headerScaleInput: {
    color: "#d9ecf5",
    textAlign: "center",
    fontWeight: "700",
    paddingHorizontal: 8,
    paddingVertical: 6,
    width: "100%",
  },
  headerActionBtn: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#4f6a76",
    backgroundColor: "#2a4450",
    minWidth: 74,
    paddingHorizontal: 10,
    paddingVertical: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  headerActionBtnIgnore: {
    backgroundColor: "#5b4f2f",
    borderColor: "#8d7a46",
  },
  headerActionBtnText: {
    color: "#d9ecf5",
    fontWeight: "700",
  },
  title: {
    color: "#d4f0f7",
    fontSize: 21,
    fontWeight: "700",
  },
  subtitle: {
    color: "#8fb1bd",
    fontSize: 12,
    marginTop: 2,
  },
  card: {
    borderRadius: 12,
    backgroundColor: "#132128",
    borderWidth: 1,
    borderColor: "#28414d",
    padding: 12,
    gap: 10,
  },
  chatCard: {
    flex: 1,
    minHeight: 0,
  },
  loginActionsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  rememberRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  rememberBox: {
    width: 20,
    height: 20,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: "#4f6a76",
    backgroundColor: "#0f1a1f",
    alignItems: "center",
    justifyContent: "center",
  },
  rememberBoxActive: {
    backgroundColor: "#436f7f",
    borderColor: "#7fb4c8",
  },
  rememberBoxMark: {
    color: "#e6f6ff",
    fontWeight: "700",
    lineHeight: 14,
  },
  loginActionBtn: {
    flex: 1,
  },
  chatCardIgnore: {
    gap: 8,
  },
  label: {
    color: "#9cc7d4",
    fontSize: 12,
    fontWeight: "600",
  },
  input: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#2a4552",
    color: "#d5edf6",
    paddingHorizontal: 10,
    paddingVertical: 10,
    backgroundColor: "#0f1a1f",
  },
  btn: {
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    alignItems: "center",
    justifyContent: "center",
    minWidth: 80,
  },
  topBtn: {
    minWidth: 92,
  },
  btnPrimary: {
    backgroundColor: "#ec7d37",
  },
  btnGhost: {
    backgroundColor: "#304c59",
  },
  topBtnBright: {
    backgroundColor: "#496a79",
    borderWidth: 1,
    borderColor: "#6f95a7",
  },
  topBtnCapture: {
    backgroundColor: "#4f7b51",
    borderWidth: 1,
    borderColor: "#7ab27d",
  },
  btnText: {
    color: "#081114",
    fontWeight: "700",
  },
  sectionTitle: {
    color: "#d7eef6",
    fontWeight: "700",
    fontSize: 15,
  },
  metaText: {
    color: "#8fb1bd",
    fontSize: 12,
  },
  modeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  modeBadge: {
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderWidth: 1,
  },
  modeTfclaw: {
    backgroundColor: "#1c3943",
    borderColor: "#3e7788",
  },
  modeTmux: {
    backgroundColor: "#203a24",
    borderColor: "#4f9460",
  },
  modeBadgeText: {
    color: "#d9edf6",
    fontSize: 12,
    fontWeight: "700",
  },
  modeBtnOn: {
    backgroundColor: "#5f9f55",
  },
  modeBtnOff: {
    backgroundColor: "#ad6349",
  },
  modeBtnToggleTfclaw: {
    backgroundColor: "#6a7f3d",
  },
  linesRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
  },
  linesSliderWrap: {
    flex: 1,
    minWidth: 120,
    height: 30,
    justifyContent: "center",
  },
  linesSliderTrack: {
    height: 4,
    borderRadius: 2,
    backgroundColor: "#3b5966",
    overflow: "hidden",
  },
  linesSliderFill: {
    height: "100%",
    backgroundColor: "#7db9ca",
  },
  linesSliderThumb: {
    position: "absolute",
    top: 6,
    width: TMUX_LINES_SLIDER_THUMB_SIZE,
    height: TMUX_LINES_SLIDER_THUMB_SIZE,
    borderRadius: TMUX_LINES_SLIDER_THUMB_SIZE / 2,
    backgroundColor: "#ec7d37",
    borderWidth: 1,
    borderColor: "#f0b48c",
  },
  linesInput: {
    width: 88,
    paddingVertical: 6,
  },
  linesApplyBtn: {
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: "#355663",
    borderWidth: 1,
    borderColor: "#5f8ea0",
  },
  linesApplyBtnText: {
    color: "#d9ecf5",
    fontSize: 12,
    fontWeight: "700",
  },
  targetRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
  },
  targetPickerBtn: {
    flex: 1,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#4b6875",
    backgroundColor: "#192b33",
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  targetPickerText: {
    color: "#d8ecf4",
    fontSize: 12,
  },
  targetMenu: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#3b5966",
    backgroundColor: "#102028",
    maxHeight: 180,
    paddingVertical: 4,
  },
  targetMenuItem: {
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  targetMenuItemActive: {
    backgroundColor: "#2e4e5b",
  },
  targetMenuItemText: {
    color: "#d4ecf5",
    fontSize: 12,
  },
  targetCloseBtn: {
    backgroundColor: "#7f5348",
    borderColor: "#b07d72",
  },
  targetNewBtn: {
    backgroundColor: "#4f7f4c",
    borderColor: "#79b078",
  },
  chatTopRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  chatTopLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  chatTopBtns: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    flex: 1,
    flexWrap: "wrap",
    gap: 8,
  },
  connectionDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  connectionDotOnline: {
    backgroundColor: "#4dd26f",
  },
  connectionDotOffline: {
    backgroundColor: "#de4f4f",
  },
  chatList: {
    flex: 1,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#2c4350",
    backgroundColor: "#0b1418",
  },
  chatListIgnore: {
    flex: 1,
    minHeight: 0,
  },
  chatListContent: {
    padding: 10,
    gap: 8,
  },
  terminalWrap: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#2e4a39",
    backgroundColor: "#08100b",
    overflow: "hidden",
  },
  terminalWrapInline: {
    minHeight: 130,
    maxHeight: 260,
    height: 210,
    paddingTop: 8,
  },
  terminalWrapSplit: {
    flex: 1,
    minHeight: 0,
    paddingTop: 8,
  },
  terminalWrapFullscreen: {
    flex: 1,
    minHeight: 0,
    flexShrink: 1,
    paddingTop: 8,
  },
  terminalView: {
    flex: 1,
  },
  terminalContent: {
    padding: 10,
  },
  terminalText: {
    color: "#b6f0c1",
    fontSize: 12,
    lineHeight: 18,
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }),
  },
  terminalTextSelectableInput: {
    paddingHorizontal: 0,
    paddingVertical: 0,
    margin: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    textAlignVertical: "top",
  },
  terminalSelected: {
    borderWidth: 1,
    borderColor: "#5fa673",
    borderRadius: 8,
    backgroundColor: "#102016",
    padding: 6,
  },
  msgWrap: {
    maxWidth: "100%",
  },
  msgWrapAssistant: {
    alignItems: "flex-start",
  },
  msgWrapUser: {
    alignItems: "flex-end",
  },
  msgName: {
    color: "#93afbb",
    fontSize: 11,
    marginBottom: 3,
    marginHorizontal: 4,
  },
  msgNameUser: {
    color: "#f2a26b",
  },
  msgNameSystem: {
    color: "#7fa2b2",
  },
  msgBubble: {
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    maxWidth: "92%",
  },
  msgUser: {
    alignSelf: "flex-end",
    backgroundColor: "#eb8743",
  },
  msgAssistant: {
    alignSelf: "flex-start",
    backgroundColor: "#203844",
  },
  msgSystem: {
    alignSelf: "center",
    backgroundColor: "#1c2b32",
  },
  msgProgress: {
    borderWidth: 1,
    borderColor: "#4f7888",
  },
  msgSelected: {
    borderWidth: 1,
    borderColor: "#9bc6d6",
    shadowColor: "#9bc6d6",
    shadowOpacity: 0.28,
    shadowRadius: 7,
    shadowOffset: { width: 0, height: 0 },
    elevation: 2,
  },
  msgText: {
    color: "#e7f4fb",
    fontSize: 13,
    lineHeight: 18,
  },
  msgTextSelectableInput: {
    paddingHorizontal: 0,
    paddingVertical: 0,
    margin: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    textAlignVertical: "top",
  },
  msgSystemText: {
    color: "#9cc7d4",
    fontSize: 12,
  },
  emptyText: {
    color: "#89a6b2",
    fontSize: 12,
  },
  sendRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  keyToggleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  keyToggleBtn: {
    backgroundColor: "#7d9350",
    minWidth: 92,
  },
  keyPanel: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#375664",
    backgroundColor: "#0f1a1f",
    padding: 8,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  keyPanelBtn: {
    borderRadius: 8,
    borderWidth: 1,
    borderColor: "#5f8ea0",
    backgroundColor: "#355663",
    paddingHorizontal: 10,
    paddingVertical: 8,
    minWidth: 68,
    alignItems: "center",
    justifyContent: "center",
  },
  keyPanelBtnText: {
    color: "#d9ecf5",
    fontSize: 12,
    fontWeight: "700",
  },
  dialogBackdrop: {
    flex: 1,
    backgroundColor: "rgba(4, 8, 11, 0.72)",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
  },
  dialogCard: {
    width: "100%",
    maxWidth: 420,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#3b5966",
    backgroundColor: "#132128",
    padding: 12,
    gap: 10,
  },
  dialogTitle: {
    color: "#d7eef6",
    fontSize: 16,
    fontWeight: "700",
  },
  dialogActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: 8,
  },
  dialogCancelBtn: {
    backgroundColor: "#3b5561",
    borderColor: "#5f8391",
  },
  dialogConfirmBtn: {
    backgroundColor: "#4f7f4c",
    borderColor: "#79b078",
  },
  textActionBackdrop: {
    flex: 1,
    backgroundColor: "rgba(4, 8, 11, 0.42)",
  },
  textActionCard: {
    position: "absolute",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#335362",
    backgroundColor: "#0f1d24",
    padding: 8,
    width: 320,
    maxWidth: "94%",
  },
  textActionRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  textActionBtn: {
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    minWidth: 64,
    alignItems: "center",
    justifyContent: "center",
  },
  textActionBtnEnabled: {
    backgroundColor: "#47697a",
    borderWidth: 1,
    borderColor: "#76a3b8",
  },
  textActionBtnDisabled: {
    backgroundColor: "#273943",
    borderWidth: 1,
    borderColor: "#3a5461",
    opacity: 0.7,
  },
  textActionBtnText: {
    color: "#d9ecf5",
    fontSize: 12,
    fontWeight: "700",
  },
  sendInput: {
    flex: 1,
  },
});
