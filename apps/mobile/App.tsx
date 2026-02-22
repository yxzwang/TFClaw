import { StatusBar } from "expo-status-bar";
import { useMemo, useRef, useState } from "react";
import {
  Image,
  KeyboardAvoidingView,
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

interface AgentDescriptor {
  agentId: string;
  platform: PlatformName;
  hostname: string;
  connectedAt: string;
}

interface TerminalSummary {
  terminalId: string;
  title: string;
  cwd?: string;
  isActive: boolean;
  updatedAt: string;
}

interface RelayStateMessage {
  type: "relay.state";
  payload: {
    agent?: AgentDescriptor;
    terminals: TerminalSummary[];
    snapshots: Array<{
      terminalId: string;
      output: string;
      updatedAt: string;
    }>;
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

interface OutputMessage {
  type: "agent.terminal_output";
  payload: {
    terminalId: string;
    chunk: string;
    at: string;
  };
}

interface ScreenCaptureMessage {
  type: "agent.screen_capture";
  payload: {
    source: "screen" | "window";
    terminalId?: string;
    mimeType: string;
    imageBase64: string;
    capturedAt: string;
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
  | OutputMessage
  | ScreenCaptureMessage
  | AgentErrorMessage;

function randomId(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

export default function App() {
  const [relayUrl, setRelayUrl] = useState(process.env.EXPO_PUBLIC_TFCLAW_RELAY_URL ?? "ws://10.0.2.2:8787");
  const [token, setToken] = useState(process.env.EXPO_PUBLIC_TFCLAW_TOKEN ?? "demo-token");
  const [connected, setConnected] = useState(false);
  const [agent, setAgent] = useState<AgentDescriptor | undefined>();
  const [terminals, setTerminals] = useState<TerminalSummary[]>([]);
  const [selectedTerminalId, setSelectedTerminalId] = useState<string | undefined>();
  const [outputMap, setOutputMap] = useState<Record<string, string>>({});
  const [inputText, setInputText] = useState("");
  const [eventLog, setEventLog] = useState<string[]>([]);
  const [captureBase64, setCaptureBase64] = useState<string | undefined>();
  const wsRef = useRef<WebSocket | undefined>(undefined);
  const outputScrollRef = useRef<ScrollView | null>(null);

  const selectedOutput = useMemo(() => {
    if (!selectedTerminalId) {
      return "";
    }
    return outputMap[selectedTerminalId] ?? "";
  }, [outputMap, selectedTerminalId]);

  const appendEvent = (line: string) => {
    setEventLog((prev) => {
      const merged = [`${new Date().toLocaleTimeString()}  ${line}`, ...prev];
      return merged.slice(0, 8);
    });
  };

  const send = (data: unknown) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      appendEvent("not connected");
      return;
    }
    ws.send(JSON.stringify(data));
  };

  const connect = () => {
    if (connected) {
      return;
    }

    const url = `${relayUrl.replace(/\/+$/, "")}/?role=client&token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      appendEvent("relay connected");
      send({
        type: "client.hello",
        payload: {
          clientType: "mobile",
        },
      });
    };

    ws.onmessage = (event) => {
      try {
        const parsed = JSON.parse(String(event.data)) as IncomingMessage;

        if (parsed.type === "relay.state") {
          setAgent(parsed.payload.agent);
          setTerminals(parsed.payload.terminals);
          setOutputMap((prev) => {
            const next = { ...prev };
            for (const snapshot of parsed.payload.snapshots) {
              next[snapshot.terminalId] = snapshot.output;
            }
            return next;
          });

          if (!selectedTerminalId && parsed.payload.terminals.length > 0) {
            setSelectedTerminalId(parsed.payload.terminals[0].terminalId);
          }
          return;
        }

        if (parsed.type === "agent.terminal_output") {
          setOutputMap((prev) => {
            const current = prev[parsed.payload.terminalId] ?? "";
            const merged = `${current}${parsed.payload.chunk}`;
            return {
              ...prev,
              [parsed.payload.terminalId]: merged.length > 16000 ? merged.slice(-16000) : merged,
            };
          });
          return;
        }

        if (parsed.type === "agent.screen_capture") {
          setCaptureBase64(parsed.payload.imageBase64);
          appendEvent(`capture received (${parsed.payload.source})`);
          return;
        }

        if (parsed.type === "agent.error") {
          appendEvent(`agent error ${parsed.payload.code}: ${parsed.payload.message}`);
          return;
        }

        if (parsed.type === "relay.ack" && parsed.payload.message) {
          appendEvent(parsed.payload.message);
        }
      } catch {
        appendEvent("invalid message received");
      }
    };

    ws.onerror = () => {
      appendEvent("relay socket error");
    };

    ws.onclose = () => {
      setConnected(false);
      setAgent(undefined);
      wsRef.current = undefined;
      appendEvent("relay disconnected");
    };
  };

  const disconnect = () => {
    wsRef.current?.close();
    wsRef.current = undefined;
    setConnected(false);
  };

  const createTerminal = () => {
    send({
      type: "client.command",
      requestId: randomId(),
      payload: {
        command: "terminal.create",
        title: `mobile-${Date.now()}`,
      },
    });
  };

  const closeTerminal = () => {
    if (!selectedTerminalId) {
      return;
    }
    send({
      type: "client.command",
      requestId: randomId(),
      payload: {
        command: "terminal.close",
        terminalId: selectedTerminalId,
      },
    });
  };

  const sendInput = (raw: string) => {
    if (!selectedTerminalId) {
      return;
    }
    send({
      type: "client.command",
      payload: {
        command: "terminal.input",
        terminalId: selectedTerminalId,
        data: raw,
      },
    });
  };

  const submitText = () => {
    if (!inputText.trim()) {
      return;
    }
    sendInput(`${inputText}${Platform.OS === "windows" ? "\r\n" : "\n"}`);
    setInputText("");
  };

  const captureScreen = () => {
    send({
      type: "client.command",
      requestId: randomId(),
      payload: {
        command: "screen.capture",
        source: "screen",
        terminalId: selectedTerminalId,
      },
    });
  };

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" />
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>Token-Free-Claw</Text>
          <Text style={styles.subtitle}>{connected ? "Connected" : "Disconnected"}</Text>
        </View>

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

          <View style={styles.row}>
            <Pressable style={[styles.btn, styles.btnPrimary]} onPress={connect}>
              <Text style={styles.btnText}>Connect</Text>
            </Pressable>
            <Pressable style={[styles.btn, styles.btnGhost]} onPress={disconnect}>
              <Text style={styles.btnText}>Disconnect</Text>
            </Pressable>
          </View>

          <Text style={styles.metaText}>
            Agent: {agent ? `${agent.hostname} (${agent.platform})` : "not connected"}
          </Text>
        </View>

        <View style={styles.card}>
          <View style={styles.rowBetween}>
            <Text style={styles.sectionTitle}>Terminals</Text>
            <View style={styles.row}>
              <Pressable style={[styles.smallBtn, styles.btnPrimary]} onPress={createTerminal}>
                <Text style={styles.smallBtnText}>New</Text>
              </Pressable>
              <Pressable style={[styles.smallBtn, styles.btnGhost]} onPress={closeTerminal}>
                <Text style={styles.smallBtnText}>Close</Text>
              </Pressable>
              <Pressable style={[styles.smallBtn, styles.btnGhost]} onPress={captureScreen}>
                <Text style={styles.smallBtnText}>Capture</Text>
              </Pressable>
            </View>
          </View>

          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.terminalRow}>
            {terminals.map((terminal) => {
              const selected = terminal.terminalId === selectedTerminalId;
              return (
                <Pressable
                  key={terminal.terminalId}
                  style={[styles.terminalChip, selected ? styles.terminalChipActive : undefined]}
                  onPress={() => setSelectedTerminalId(terminal.terminalId)}
                >
                  <Text style={styles.chipTitle}>{terminal.title}</Text>
                  <Text style={styles.chipMeta}>{terminal.isActive ? "active" : "closed"}</Text>
                </Pressable>
              );
            })}
          </ScrollView>

          <ScrollView
            ref={outputScrollRef}
            style={styles.outputBox}
            onContentSizeChange={() => outputScrollRef.current?.scrollToEnd({ animated: true })}
          >
            <Text style={styles.outputText}>{selectedOutput || "Select a terminal to view output."}</Text>
          </ScrollView>

          <View style={styles.row}>
            <TextInput
              style={[styles.input, styles.flex]}
              value={inputText}
              onChangeText={setInputText}
              placeholder="Type command..."
              placeholderTextColor="#6f878f"
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Pressable style={[styles.btn, styles.btnPrimary]} onPress={submitText}>
              <Text style={styles.btnText}>Send</Text>
            </Pressable>
          </View>

          <View style={styles.row}>
            <Pressable style={[styles.smallBtn, styles.btnGhost]} onPress={() => sendInput("__ENTER__")}>
              <Text style={styles.smallBtnText}>Enter</Text>
            </Pressable>
            <Pressable style={[styles.smallBtn, styles.btnGhost]} onPress={() => sendInput("__CTRL_C__")}>
              <Text style={styles.smallBtnText}>Ctrl+C</Text>
            </Pressable>
            <Pressable style={[styles.smallBtn, styles.btnGhost]} onPress={() => sendInput("__CTRL_D__")}>
              <Text style={styles.smallBtnText}>Ctrl+D</Text>
            </Pressable>
          </View>
        </View>

        {captureBase64 ? (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Latest Capture</Text>
            <Image
              style={styles.capture}
              resizeMode="contain"
              source={{
                uri: `data:image/png;base64,${captureBase64}`,
              }}
            />
          </View>
        ) : null}

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Events</Text>
          {eventLog.length === 0 ? <Text style={styles.metaText}>No events yet.</Text> : null}
          {eventLog.map((item) => (
            <Text key={item} style={styles.logItem}>
              {item}
            </Text>
          ))}
        </View>
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
  },
  card: {
    borderRadius: 12,
    backgroundColor: "#132128",
    borderWidth: 1,
    borderColor: "#28414d",
    padding: 10,
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
    paddingVertical: 8,
    backgroundColor: "#0f1a1f",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  rowBetween: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
  },
  btn: {
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  smallBtn: {
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    alignItems: "center",
    justifyContent: "center",
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
  smallBtnText: {
    color: "#d8ecf3",
    fontWeight: "600",
    fontSize: 12,
  },
  metaText: {
    color: "#8fb1bd",
    fontSize: 12,
  },
  sectionTitle: {
    color: "#d7eef6",
    fontWeight: "700",
    fontSize: 14,
  },
  terminalRow: {
    gap: 8,
    paddingVertical: 2,
  },
  terminalChip: {
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: "#1f333d",
    borderWidth: 1,
    borderColor: "#2e4b57",
    minWidth: 120,
  },
  terminalChipActive: {
    borderColor: "#ec7d37",
  },
  chipTitle: {
    color: "#d8edf4",
    fontWeight: "700",
    fontSize: 12,
  },
  chipMeta: {
    color: "#8db3bf",
    fontSize: 10,
  },
  outputBox: {
    minHeight: 170,
    maxHeight: 260,
    backgroundColor: "#0b1418",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#2c4350",
    padding: 8,
  },
  outputText: {
    color: "#9ee7bf",
    fontSize: 12,
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }),
    lineHeight: 17,
  },
  flex: {
    flex: 1,
  },
  capture: {
    width: "100%",
    height: 180,
    borderRadius: 8,
    backgroundColor: "#0b1418",
  },
  logItem: {
    color: "#88aab6",
    fontSize: 11,
  },
});
