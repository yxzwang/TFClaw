import { StatusBar } from "expo-status-bar";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Keyboard,
  LayoutChangeEvent,
  PanResponder,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

type PlatformName = "windows" | "macos" | "linux" | "unknown";
type AppStage = "login" | "chat";
type MessageRole = "user" | "assistant" | "system";
type ConnectionState = "offline" | "connecting" | "online";
type WorkMode = "tfclaw" | "tmux";

const TMUX_LINES_MIN = 10;
const TMUX_LINES_MAX = 300;
const TMUX_LINES_SLIDER_THUMB_SIZE = 18;
const TERMINAL_RENDER_MAX_CHARS = 120000;

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
      found.push(tmuxHeader[1].trim());
    }
  }
  return Array.from(new Set(found));
}

function parseTmuxTargetHint(output: string): string | undefined {
  const targetSet = output.match(/Target set to\s+`([^`]+)`/i);
  if (targetSet?.[1]) {
    return targetSet[1].trim();
  }
  const passthroughTarget = output.match(/tmux target\s+`([^`]+)`/i);
  if (passthroughTarget?.[1]) {
    return passthroughTarget[1].trim();
  }
  const tmuxHeader = output.match(/\[tmux\s+([^\]]+)\]/);
  if (tmuxHeader?.[1]) {
    return tmuxHeader[1].trim();
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
  const [relayUrl, setRelayUrl] = useState(process.env.EXPO_PUBLIC_TFCLAW_RELAY_URL ?? "ws://127.0.0.1:8787");
  const [token, setToken] = useState(process.env.EXPO_PUBLIC_TFCLAW_TOKEN ?? "demo-token");
  const [connectionState, setConnectionState] = useState<ConnectionState>("offline");
  const [workMode, setWorkMode] = useState<WorkMode>("tfclaw");
  const [tmuxLines, setTmuxLines] = useState(200);
  const [tmuxLinesInput, setTmuxLinesInput] = useState("200");
  const [tmuxTargets, setTmuxTargets] = useState<string[]>([]);
  const [selectedTmuxTarget, setSelectedTmuxTarget] = useState("");
  const [tmuxTargetMenuOpen, setTmuxTargetMenuOpen] = useState(false);
  const [hideTfclawWindowInTmux, setHideTfclawWindowInTmux] = useState(false);
  const [agent, setAgent] = useState<AgentDescriptor | undefined>(undefined);
  const [inputText, setInputText] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [terminalRender, setTerminalRender] = useState("");
  const [tmuxLiveProgress, setTmuxLiveProgress] = useState("");

  const wsRef = useRef<WebSocket | null>(null);
  const workModeRef = useRef<WorkMode>("tfclaw");
  const tmuxLiveProgressRequestIdRef = useRef("");
  const pendingMapRef = useRef<Map<string, PendingCommandState>>(new Map());
  const chatScrollRef = useRef<ScrollView | null>(null);
  const terminalScrollRef = useRef<ScrollView | null>(null);
  const tmuxLinesTrackWidthRef = useRef(1);
  const [tmuxLinesTrackWidth, setTmuxLinesTrackWidth] = useState(1);

  const isOnline = connectionState === "online";
  const isConnecting = connectionState === "connecting";

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

  const setTmuxProgress = (text: string, requestId?: string) => {
    const nextRequestId = requestId ?? "";
    tmuxLiveProgressRequestIdRef.current = nextRequestId;
    setTmuxLiveProgress(text);
  };

  const clearTmuxProgress = () => {
    setTmuxProgress("");
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

  const appendTerminalRender = (chunk: string) => {
    const cleaned = stripAnsi(String(chunk ?? "")).replace(/\r\n/g, "\n");
    if (!cleaned) {
      return;
    }
    const normalized = cleaned.endsWith("\n") ? cleaned : `${cleaned}\n`;
    setTerminalRender((prev) => {
      const merged = `${prev}${normalized}`;
      return merged.length > TERMINAL_RENDER_MAX_CHARS ? merged.slice(-TERMINAL_RENDER_MAX_CHARS) : merged;
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

  const syncTmuxContextFromOutput = (output: string) => {
    const discoveredTargets = parseTmuxTargets(output);
    if (discoveredTargets.length > 0) {
      setTmuxTargets((prev) => Array.from(new Set([...prev, ...discoveredTargets])));
    }
    const hintedTarget = parseTmuxTargetHint(output);
    if (hintedTarget) {
      setSelectedTmuxTarget(hintedTarget);
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
      const rawOutput = String(parsed.payload.output ?? "");
      const outputText = cleanOutput(rawOutput);
      syncModeFromOutput(rawOutput);
      syncTmuxContextFromOutput(rawOutput);
      const currentMode = workModeRef.current;

      if (isProgress) {
        if (currentMode === "tmux") {
          setTmuxProgress(cleanOutput(rawOutput), requestId);
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
      if (currentMode === "tmux") {
        if (!requestId || requestId === tmuxLiveProgressRequestIdRef.current) {
          clearTmuxProgress();
        }
        appendTerminalRender(rawOutput);
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
      finishPending(parsed.payload.requestId);
      const errorText = `[${parsed.payload.code}] ${parsed.payload.message}`;
      if (workModeRef.current === "tmux") {
        if (!parsed.payload.requestId || parsed.payload.requestId === tmuxLiveProgressRequestIdRef.current) {
          clearTmuxProgress();
        }
        appendTerminalRender(errorText);
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

  const connectWithToken = () => {
    const urlText = relayUrl.trim();
    const tokenText = token.trim();
    if (!urlText || !tokenText || isConnecting) {
      return;
    }

    wsRef.current?.close();
    wsRef.current = null;
    clearTmuxProgress();

    setStage("chat");
    setConnectionState("connecting");
    const connectingText = "Connecting to TFClaw relay...";
    appendSystemText(connectingText);

    const wsUrl = `${urlText.replace(/\/+$/, "")}/?role=client&token=${encodeURIComponent(tokenText)}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnectionState("online");
      const connectedText = "Connected.";
      appendSystemText(connectedText);
      sendJson({
        type: "client.hello",
        payload: {
          clientType: "mobile",
        },
      });
    };

    ws.onmessage = (event) => {
      handleIncoming(String(event.data));
    };

    ws.onerror = () => {
      const errorText = "Socket error. Check relay URL/token and network.";
      appendSystemText(errorText);
    };

    ws.onclose = () => {
      setConnectionState("offline");
      setAgent(undefined);
      wsRef.current = null;
      pendingMapRef.current.clear();
      clearTmuxProgress();
      const disconnectedText = "Disconnected.";
      appendSystemText(disconnectedText);
    };
  };

  const backToLogin = () => {
    wsRef.current?.close();
    wsRef.current = null;
    setConnectionState("offline");
    setAgent(undefined);
    pendingMapRef.current.clear();
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
    if (targetMode === "tmux") {
      clearTmuxProgress();
      appendTerminalRender(`$ ${text}`);
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
        appendTerminalRender(offlineText);
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

    pendingMapRef.current.set(requestId, {});
    return true;
  };

  const handlePtOn = () => {
    void sendCommandText("/pt on");
    if (selectedTmuxTarget.trim()) {
      void sendCommandText(`/tmux target ${selectedTmuxTarget.trim()}`);
    } else {
      void sendCommandText("/tmux panes");
    }
  };

  const handlePtOff = () => {
    void sendCommandText("/pt off");
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

  const handleSelectTmuxTarget = (target: string) => {
    const normalized = target.trim();
    if (!normalized) {
      return;
    }
    setSelectedTmuxTarget(normalized);
    setTmuxTargetMenuOpen(false);
    void sendCommandText(`/tmux target ${normalized}`);
  };

  const handleToggleTfclawWindowInTmux = () => {
    if (workMode !== "tmux") {
      return;
    }
    setHideTfclawWindowInTmux((prev) => !prev);
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
    return () => {
      wsRef.current?.close();
    };
  }, []);

  useEffect(() => {
    if (workMode !== "tmux") {
      setHideTfclawWindowInTmux(false);
      clearTmuxProgress();
    }
  }, [workMode]);

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
  const terminalDisplay = useMemo(() => {
    const base = terminalRender || "# tmux renderer\n# output will appear here";
    if (workMode !== "tmux") {
      return base;
    }
    const live = stripAnsi(tmuxLiveProgress).replace(/\r\n/g, "\n").trim();
    if (!live) {
      return base;
    }
    return `${base}${base.endsWith("\n") ? "" : "\n"}${live}`;
  }, [terminalRender, tmuxLiveProgress, workMode]);

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
        <Text style={[styles.msgName, isUser ? styles.msgNameUser : undefined, isSystem ? styles.msgNameSystem : undefined]}>
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
          <Text style={[styles.msgText, isSystem ? styles.msgSystemText : undefined]}>{msg.text}</Text>
        </View>
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" />
      <KeyboardAvoidingView
        behavior="padding"
        keyboardVerticalOffset={0}
        style={styles.container}
      >
        <View style={styles.header}>
          <Text style={styles.title}>TFClaw Chat</Text>
          <Text style={styles.subtitle}>
            {statusText} | {modeText}
          </Text>
        </View>

        {stage === "login" ? (
          <View style={styles.card}>
            <Text style={styles.label}>Relay URL</Text>
            <TextInput
              style={styles.input}
              value={relayUrl}
              onChangeText={setRelayUrl}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="ws://10.0.2.2:8787"
              placeholderTextColor="#6f878f"
            />
            <Text style={styles.label}>Token</Text>
            <TextInput
              style={styles.input}
              value={token}
              onChangeText={setToken}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder="demo-token"
              placeholderTextColor="#6f878f"
            />
            <Pressable style={[styles.btn, styles.btnPrimary]} onPress={connectWithToken}>
              <Text style={styles.btnText}>Login</Text>
            </Pressable>
            <Text style={styles.metaText}>Tap Login to enter chat immediately and start connecting.</Text>
            <Text style={styles.metaText}>For Android emulator use: `adb reverse tcp:8787 tcp:8787`.</Text>
          </View>
        ) : (
          <View style={[styles.card, styles.chatCard]} onLayout={() => scrollOutputsToEnd(false)}>
            <View style={styles.chatTopRow}>
              <Text style={styles.sectionTitle}>Conversation</Text>
              <View style={styles.chatTopBtns}>
                <Pressable
                  style={[styles.btn, styles.btnGhost, styles.topBtn]}
                  onPress={connectWithToken}
                  disabled={isConnecting}
                >
                  <Text style={styles.btnText}>{isConnecting ? "Connecting" : "Reconnect"}</Text>
                </Pressable>
                <Pressable style={[styles.btn, styles.btnGhost, styles.topBtn]} onPress={backToLogin}>
                  <Text style={styles.btnText}>Back</Text>
                </Pressable>
              </View>
            </View>
            <View style={styles.modeRow}>
              <View style={[styles.modeBadge, workMode === "tmux" ? styles.modeTmux : styles.modeTfclaw]}>
                <Text style={styles.modeBadgeText}>{modeText}</Text>
              </View>
              <Pressable style={[styles.btn, styles.modeBtnOn]} onPress={handlePtOn}>
                <Text style={styles.btnText}>PT ON</Text>
              </Pressable>
              <Pressable style={[styles.btn, styles.modeBtnOff]} onPress={handlePtOff}>
                <Text style={styles.btnText}>PT OFF</Text>
              </Pressable>
              {workMode === "tmux" ? (
                <Pressable style={[styles.btn, styles.modeBtnToggleTfclaw]} onPress={handleToggleTfclawWindowInTmux}>
                  <Text style={styles.btnText}>
                    {hideTfclawWindowInTmux ? "Show TFClaw" : "Hide TFClaw"}
                  </Text>
                </Pressable>
              ) : null}
            </View>

            <View style={styles.linesRow}>
              <Text style={styles.metaText}>/tmux lines:</Text>
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
                style={[styles.input, styles.linesInput]}
                value={tmuxLinesInput}
                onChangeText={setTmuxLinesInput}
                keyboardType="number-pad"
                returnKeyType="done"
                onSubmitEditing={handleTmuxLinesInputSubmit}
              />
              <Pressable style={[styles.linesApplyBtn]} onPress={handleTmuxLinesInputSubmit}>
                <Text style={styles.linesApplyBtnText}>Set</Text>
              </Pressable>
            </View>

            <View style={styles.targetRow}>
              <Text style={styles.metaText}>tmux window:</Text>
              <Pressable
                style={styles.targetPickerBtn}
                onPress={() => setTmuxTargetMenuOpen((prev) => !prev)}
              >
                <Text style={styles.targetPickerText}>
                  {selectedTmuxTarget || "Select target"}
                </Text>
              </Pressable>
              <Pressable style={styles.linesApplyBtn} onPress={handleRefreshTmuxTargets}>
                <Text style={styles.linesApplyBtnText}>Refresh</Text>
              </Pressable>
            </View>
            {tmuxTargetMenuOpen ? (
              <View style={styles.targetMenu}>
                {tmuxTargets.length === 0 ? (
                  <Text style={styles.metaText}>No tmux panes yet. Tap Refresh.</Text>
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
                      <Text style={styles.targetMenuItemText}>{target}</Text>
                    </Pressable>
                  ))
                )}
              </View>
            ) : null}

            <Text style={styles.metaText}>
              {agentText} | lines: {tmuxLines} | target: {selectedTmuxTarget || "(none)"}
            </Text>

            {!(workMode === "tmux" && hideTfclawWindowInTmux) ? (
              <ScrollView
                ref={chatScrollRef}
                style={styles.chatList}
                contentContainerStyle={styles.chatListContent}
                keyboardShouldPersistTaps="handled"
                onContentSizeChange={() => chatScrollRef.current?.scrollToEnd({ animated: true })}
              >
                {messages.length === 0 ? (
                  <Text style={styles.emptyText}>No messages yet.</Text>
                ) : (
                  messages.map(renderMessage)
                )}
              </ScrollView>
            ) : null}

            {workMode === "tmux" ? (
              <View
                style={[styles.terminalWrap, hideTfclawWindowInTmux ? styles.terminalWrapFullscreen : styles.terminalWrapInline]}
                onLayout={() => scrollOutputsToEnd(false)}
              >
                <Text style={styles.metaText}>tmux renderer</Text>
                <ScrollView
                  ref={terminalScrollRef}
                  style={styles.terminalView}
                  contentContainerStyle={styles.terminalContent}
                  keyboardShouldPersistTaps="handled"
                  onContentSizeChange={() => terminalScrollRef.current?.scrollToEnd({ animated: true })}
                >
                  <Text style={styles.terminalText}>{terminalDisplay}</Text>
                </ScrollView>
              </View>
            ) : null}

            <View style={styles.sendRow}>
              <TextInput
                style={[styles.input, styles.sendInput]}
                value={inputText}
                onChangeText={setInputText}
                placeholder={workMode === "tmux" ? "tmux command..." : "Type command or /tmux ..."}
                placeholderTextColor="#6f878f"
                autoCapitalize="none"
                autoCorrect={false}
                blurOnSubmit={false}
                onSubmitEditing={sendChat}
              />
              <Pressable style={[styles.btn, styles.btnPrimary]} onPress={sendChat}>
                <Text style={styles.btnText}>Send</Text>
              </Pressable>
            </View>
          </View>
        )}
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
    padding: 12,
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
  chatTopRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  chatTopBtns: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  chatList: {
    flex: 1,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#2c4350",
    backgroundColor: "#0b1418",
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
  msgText: {
    color: "#e7f4fb",
    fontSize: 13,
    lineHeight: 18,
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
  sendInput: {
    flex: 1,
  },
});
