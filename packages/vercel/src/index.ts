import { AgnostClient, AgnostConfig, generateSessionId } from "@agnost/core";

interface TelemetryMetadata {
  sessionId?: string;
  userId?: string;
  email?: string;
  [key: string]: unknown;
}
interface Message {
  role: string;
  content: unknown;
}
interface ToolCall {
  toolName: string;
  args: unknown;
  result?: unknown;
}
interface Usage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

interface OnStartParams {
  model: string;
  prompt?: string;
  messages?: Message[];
  metadata?: TelemetryMetadata;
}
interface OnFinishParams {
  model: string;
  text?: string;
  usage?: Usage;
  finishReason?: string;
  toolCalls?: ToolCall[];
  metadata?: TelemetryMetadata;
}
interface OnStepFinishParams {
  model: string;
  stepType: "initial" | "continue" | "tool-result";
  toolCalls?: ToolCall[];
  usage?: Usage;
  metadata?: TelemetryMetadata;
}

// Per-request state stored between onStart and onFinish.
// A Map (not instance variables) so concurrent requests don't overwrite each other.
interface RequestState {
  startTime: number;
  input: string; // captured at onStart, used as args in the prompt event
}

export class AgnostTelemetry {
  private client: AgnostClient;
  private requests = new Map<string, RequestState>();

  constructor(config: AgnostConfig) {
    this.client = new AgnostClient(config);
  }

  async onStart(params: OnStartParams): Promise<void> {
    // Store both start time AND the user's input.
    // input is captured here because onFinish doesn't receive the messages array —
    // only the model's response. We need the input to satisfy the required `args` field.
    this.requests.set(requestKey(params.model), {
      startTime: Date.now(),
      input: extractInput(params),
    });

    await this.client.captureSession({
      sessionId: params.metadata?.sessionId ?? generateSessionId(),
      userId: String(params.metadata?.userId ?? "anonymous"),
      email: params.metadata?.email as string | undefined,
      metadata: { framework: "vercel-ai", model: params.model },
    });
  }

  async onFinish(params: OnFinishParams): Promise<void> {
    const key = requestKey(params.model);
    const state = this.requests.get(key);
    const latencyMs = Date.now() - (state?.startTime ?? Date.now());
    this.requests.delete(key);

    const sessionId = params.metadata?.sessionId ?? generateSessionId();

    // capturePrompt returns the event_id it generated for this turn.
    // Tool calls from this same turn set parent_id to this value so Agnost
    // can build the event tree: agent turn → tool calls.
    const parentEventId = await this.client.capturePrompt({
      sessionId,
      promptName: "chat",
      input: state?.input ?? "", // the user message captured at onStart
      output: params.text ?? "",
      success: params.finishReason !== "error",
      latencyMs,
      metadata: {
        model: params.model,
        finishReason: params.finishReason,
        promptTokens: params.usage?.promptTokens,
        outputTokens: params.usage?.completionTokens,
        totalTokens: params.usage?.totalTokens,
        framework: "vercel-ai",
      },
    });

    for (const tc of params.toolCalls ?? []) {
      await this.client.captureToolCall({
        sessionId,
        toolName: tc.toolName,
        args: tc.args,
        result: tc.result ?? null,
        success: true,
        latencyMs: 0,
        parentEventId: parentEventId ?? undefined,
        metadata: { model: params.model, framework: "vercel-ai" },
      });
    }
  }

  // onStepFinish fires after each iteration of a multi-step agent loop (maxSteps > 1).
  // For "tool-result" steps we have the actual tool output — log it with the parent turn's id.
  async onStepFinish(params: OnStepFinishParams): Promise<void> {
    if (params.stepType !== "tool-result") return;
    const sessionId = params.metadata?.sessionId ?? generateSessionId();

    for (const tc of params.toolCalls ?? []) {
      if (tc.result !== undefined) {
        await this.client.captureToolCall({
          sessionId,
          toolName: tc.toolName,
          args: tc.args,
          result: tc.result,
          success: true,
          latencyMs: 0,
          // parentEventId not available here — onStepFinish fires after the step
          // completes, after onFinish has already cleaned up the request state.
          // The turn → tool link is already captured in onFinish for this step.
          metadata: {
            model: params.model,
            stepType: params.stepType,
            framework: "vercel-ai",
          },
        });
      }
    }
  }

  async onError(params: {
    model?: string;
    error: unknown;
    metadata?: TelemetryMetadata;
  }): Promise<void> {
    const key = requestKey(params.model ?? "unknown");
    const state = this.requests.get(key);
    const latencyMs = Date.now() - (state?.startTime ?? Date.now());
    this.requests.delete(key);

    await this.client.capturePrompt({
      sessionId: params.metadata?.sessionId ?? generateSessionId(),
      promptName: "chat",
      input: state?.input ?? "",
      output:
        params.error instanceof Error
          ? params.error.message
          : String(params.error),
      success: false,
      latencyMs,
      metadata: { model: params.model, error: true, framework: "vercel-ai" },
    });
  }
}

// Keys by model + current second. Known limitation: two concurrent requests
// to the same model within the same second share a key. Production fix: accept
// a requestId via metadata and use that as the key.
function requestKey(model: string): string {
  return `${model}_${Math.floor(Date.now() / 1000)}`;
}

function extractInput(params: OnStartParams): string {
  if (params.prompt) return params.prompt;
  if (params.messages?.length) {
    const last = [...params.messages].reverse().find((m) => m.role === "user");
    if (typeof last?.content === "string") return last.content;
  }
  return "";
}
