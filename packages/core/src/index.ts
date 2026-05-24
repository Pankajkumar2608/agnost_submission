// @agnost/core
// Shared HTTP client used by all three adapters.
// Talks to two Agnost REST endpoints:
//   POST /api/v1/capture-session  — once per conversation
//   POST /api/v1/capture-event    — once per LLM call or tool execution

export interface AgnostConfig {
  orgId: string; // Your org UUID from app.agnost.ai/settings
  baseUrl?: string; // Default: https://api.agnost.ai. Override in tests.
  debug?: boolean; // Logs every API call. Off by default — it logs user messages.
}

export interface CaptureSessionPayload {
  session_id: string;
  user_data: { user_id: string; email?: string; [key: string]: unknown };
  metadata?: Record<string, unknown>;
  timestamp?: number;
  client_config?: string;
}

export interface CaptureEventPayload {
  event_id: string; // Required — client-generated UUID so child events can reference this one
  session_id: string;
  primitive_name: string;
  args: string; // Required — user message (turn) or JSON-encoded tool args
  result: string; // Required — assistant reply or JSON-encoded tool result
  success?: boolean;
  latency?: number;
  timestamp?: number;
  parent_id?: string; // Tool call events set this to their parent turn's event_id
  metadata?: Record<string, unknown>;
}

export interface SessionInfo {
  sessionId: string;
  userId: string;
  email?: string;
  metadata?: Record<string, unknown>;
}

export interface ToolCallInfo {
  sessionId: string;
  toolName: string;
  args: unknown;
  result: unknown;
  success: boolean;
  latencyMs: number;
  // Set to the event_id of the agent turn that triggered this tool call.
  // Agnost uses this to build the event tree in the dashboard.
  parentEventId?: string;
  metadata?: Record<string, unknown>;
}

export interface PromptInfo {
  sessionId: string;
  promptName: string;
  input: string; // The actual user message — required by the API, not optional
  output: string;
  success: boolean;
  latencyMs: number;
  metadata?: Record<string, unknown>;
}

export class AgnostClient {
  private orgId: string;
  private baseUrl: string;
  private debug: boolean;
  // Deduplicates capture-session calls. A multi-turn conversation reuses
  // the same session_id — only the first call hits the network.
  private activeSessions = new Set<string>();

  constructor(config: AgnostConfig) {
    if (!config.orgId)
      throw new Error(
        "[Agnost] orgId is required. Get it from app.agnost.ai/settings",
      );
    this.orgId = config.orgId;
    this.baseUrl = (config.baseUrl ?? "https://api.agnost.ai").replace(
      /\/$/,
      "",
    );
    this.debug = config.debug ?? false;
  }

  async captureSession(info: SessionInfo): Promise<string | null> {
    if (this.activeSessions.has(info.sessionId)) return info.sessionId;

    const payload: CaptureSessionPayload = {
      session_id: info.sessionId,
      user_data: {
        user_id: info.userId,
        ...(info.email ? { email: info.email } : {}),
      },
      metadata: info.metadata,
      timestamp: Date.now(),
      client_config: "agnost-integrations@0.1.0",
    };

    const result = await this.post<{ session_id: string }>(
      "/api/v1/capture-session",
      payload,
    );
    if (result) {
      this.activeSessions.add(info.sessionId);
      this.log("session registered:", info.sessionId);
    }
    return result?.session_id ?? null;
  }

  // Returns the event_id of the captured turn so adapters can pass it
  // as parentEventId to subsequent tool call captures from the same turn.
  async capturePrompt(info: PromptInfo): Promise<string | null> {
    if (!this.activeSessions.has(info.sessionId)) {
      await this.captureSession({
        sessionId: info.sessionId,
        userId: "anonymous",
      });
    }

    const eventId = generateId();
    const payload: CaptureEventPayload = {
      event_id: eventId,
      session_id: info.sessionId,
      primitive_name: info.promptName,
      args: info.input,
      result: info.output,
      success: info.success,
      latency: info.latencyMs,
      timestamp: Date.now(),
      metadata: { ...info.metadata, sdk: "agnost-integrations" },
    };

    await this.post<{ event_id: string }>("/api/v1/capture-event", payload);
    this.log("prompt captured:", info.promptName, eventId);
    // Return the eventId we generated — adapters use this as parentEventId for tool calls
    return eventId;
  }

  async captureToolCall(info: ToolCallInfo): Promise<string | null> {
    if (!this.activeSessions.has(info.sessionId)) {
      await this.captureSession({
        sessionId: info.sessionId,
        userId: "anonymous",
      });
    }

    const eventId = generateId();
    const payload: CaptureEventPayload = {
      event_id: eventId,
      session_id: info.sessionId,
      primitive_name: info.toolName,
      args: safeStringify(info.args),
      result: safeStringify(info.result),
      success: info.success,
      latency: info.latencyMs,
      timestamp: Date.now(),
      // Links this tool call to the agent turn that triggered it.
      // Agnost uses parent_id to build the event tree: turn → tool calls.
      ...(info.parentEventId ? { parent_id: info.parentEventId } : {}),
      metadata: { ...info.metadata, sdk: "agnost-integrations" },
    };

    await this.post<{ event_id: string }>("/api/v1/capture-event", payload);
    this.log(
      "tool captured:",
      info.toolName,
      eventId,
      info.parentEventId ? `(parent: ${info.parentEventId})` : "",
    );
    return eventId;
  }

  private async post<T>(path: string, body: unknown): Promise<T | null> {
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-org-id": this.orgId },
        body: JSON.stringify(body),
      });
      // Agnost returns 202 Accepted (async ingestion pipeline) — accept any 2xx
      if (res.status < 200 || res.status >= 300) {
        this.log(
          `${path} failed:`,
          res.status,
          await res.text().catch(() => ""),
        );
        return null;
      }
      return res.json() as Promise<T>;
    } catch (err) {
      this.log(`${path} error:`, err instanceof Error ? err.message : err);
      return null;
    }
  }

  private log(...args: unknown[]) {
    if (this.debug) console.log("[Agnost]", ...args);
  }
}

export function generateId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

export function safeStringify(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

export function extractUserMessage(
  messages: Array<{ role: string; content: unknown }>,
): string {
  const last = [...messages].reverse().find((m) => m.role === "user");
  if (!last) return "";
  if (typeof last.content === "string") return last.content;
  if (Array.isArray(last.content)) {
    return (last.content as any[])
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join(" ");
  }
  return safeStringify(last.content);
}

export function generateSessionId(): string {
  return generateId();
}
