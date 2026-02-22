export type Platform = "windows" | "macos" | "linux" | "unknown";
export interface AgentDescriptor {
    agentId: string;
    platform: Platform;
    hostname: string;
    connectedAt: string;
}
export interface TerminalSummary {
    terminalId: string;
    title: string;
    cwd?: string;
    isActive: boolean;
    updatedAt: string;
}
export interface TerminalSnapshot {
    terminalId: string;
    output: string;
    updatedAt: string;
}
export interface ScreenCapture {
    terminalId?: string;
    source: "screen" | "window";
    mimeType: string;
    imageBase64: string;
    capturedAt: string;
}
export type RelayMessage = AgentRegister | AgentTerminalList | AgentTerminalOutput | AgentScreenCapture | AgentError | ClientHello | ClientCommand | RelayState | RelayAck;
export interface AgentRegister {
    type: "agent.register";
    payload: AgentDescriptor;
}
export interface AgentTerminalList {
    type: "agent.terminal_list";
    payload: {
        terminals: TerminalSummary[];
    };
}
export interface AgentTerminalOutput {
    type: "agent.terminal_output";
    payload: {
        terminalId: string;
        chunk: string;
        at: string;
    };
}
export interface AgentScreenCapture {
    type: "agent.screen_capture";
    payload: ScreenCapture;
}
export interface AgentError {
    type: "agent.error";
    payload: {
        code: string;
        message: string;
        requestId?: string;
    };
}
export interface ClientHello {
    type: "client.hello";
    payload: {
        clientType: "mobile" | "feishu" | "web";
    };
}
export interface ClientCommand {
    type: "client.command";
    payload: {
        command: "terminal.create";
        title?: string;
        cwd?: string;
    } | {
        command: "terminal.close";
        terminalId: string;
    } | {
        command: "terminal.input";
        terminalId: string;
        data: string;
    } | {
        command: "terminal.snapshot";
        terminalId: string;
    } | {
        command: "screen.capture";
        source: "screen" | "window";
        terminalId?: string;
    };
    requestId?: string;
}
export interface RelayState {
    type: "relay.state";
    payload: {
        agent?: AgentDescriptor;
        terminals: TerminalSummary[];
        snapshots: TerminalSnapshot[];
    };
}
export interface RelayAck {
    type: "relay.ack";
    payload: {
        requestId?: string;
        ok: boolean;
        message?: string;
    };
}
export declare function safeJsonParse(input: string): RelayMessage | null;
export declare function jsonStringify(message: RelayMessage): string;
