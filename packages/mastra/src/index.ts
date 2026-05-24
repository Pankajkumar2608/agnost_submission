import {
  AgnostClient,
  AgnostConfig,
  generateSessionId,
  extractUserMessage,
} from "@agnost/core";

interface HonoContext {
  req: {
    method: string;
    url: string;
    header: (name: string) => string | undefined;
  };
  get: <T>(key: string) => T | undefined;
  set: <T>(key: string, value: T) => void;
}
interface RuntimeContext {
  get: <T>(key: string) => T | undefined;
  set: <T>(key: string, value: T) => void;
}
type NextFn = () => Promise<void>;
type MiddlewareFn = (c: HonoContext, next: NextFn) => Promise<void>;

export interface AgnostMiddlewareInstance extends MiddlewareFn {
  client: AgnostClient;
}

export function createAgnostMiddleware(
  config: AgnostConfig,
): AgnostMiddlewareInstance {
  const client = new AgnostClient(config);

  const middleware: MiddlewareFn = async (c, next) => {
    const sessionId =
      c.req.header("x-session-id") ??
      c.req.header("x-conversation-id") ??
      generateSessionId();
    const userId = c.req.header("x-user-id") ?? "anonymous";
    const email = c.req.header("x-user-email");

    await client.captureSession({
      sessionId,
      userId,
      email,
      metadata: { framework: "mastra", method: c.req.method, url: c.req.url },
    });

    const runtimeContext = c.get<RuntimeContext>("runtimeContext");
    if (runtimeContext) {
      runtimeContext.set("agnost.sessionId", sessionId);
      runtimeContext.set("agnost.userId", userId);
    }

    await next();
  };

  (middleware as AgnostMiddlewareInstance).client = client;
  return middleware as AgnostMiddlewareInstance;
}

export function agnostHooks(client: AgnostClient) {
  // Per-step state: start time + user input captured at onGenerateStart,
  // consumed and cleared at onGenerateEnd.
  interface StepState {
    startTime: number;
    input: string;
  }
  const stepStates = new Map<string, StepState>();

  return {
    onGenerateStart: async (params: {
      messages: Array<{ role: string; content: unknown }>;
      model?: string;
      runtimeContext?: RuntimeContext;
    }) => {
      const stepId = `step_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      (params as any).__agnostStepId = stepId;

      // Capture the user input here — onGenerateEnd only receives the model's output.
      stepStates.set(stepId, {
        startTime: Date.now(),
        input: extractUserMessage(params.messages as any),
      });

      const sessionId =
        params.runtimeContext?.get<string>("agnost.sessionId") ??
        generateSessionId();
      const userId =
        params.runtimeContext?.get<string>("agnost.userId") ?? "anonymous";
      await client.captureSession({
        sessionId,
        userId,
        metadata: { framework: "mastra" },
      });
    },

    onGenerateEnd: async (params: {
      text?: string;
      model?: string;
      usage?: { promptTokens?: number; completionTokens?: number };
      toolCalls?: Array<{ toolName: string; args: unknown }>;
      runtimeContext?: RuntimeContext;
    }) => {
      const stepId = (params as any).__agnostStepId as string | undefined;
      const state = stepId ? stepStates.get(stepId) : undefined;
      const latencyMs = Date.now() - (state?.startTime ?? Date.now());
      if (stepId) stepStates.delete(stepId);

      const sessionId =
        params.runtimeContext?.get<string>("agnost.sessionId") ??
        generateSessionId();

      // capturePrompt returns the event_id of the agent turn.
      // Tool calls from this turn set parent_id to it so Agnost builds the event tree.
      const parentEventId = await client.capturePrompt({
        sessionId,
        promptName: "chat",
        input: state?.input ?? "",
        output: params.text ?? "",
        success: true,
        latencyMs,
        metadata: {
          model: params.model,
          promptTokens: params.usage?.promptTokens,
          outputTokens: params.usage?.completionTokens,
          framework: "mastra",
        },
      });

      for (const tc of params.toolCalls ?? []) {
        await client.captureToolCall({
          sessionId,
          toolName: tc.toolName,
          args: tc.args,
          result: null,
          success: true,
          latencyMs: 0,
          parentEventId: parentEventId ?? undefined,
          metadata: { model: params.model, framework: "mastra" },
        });
      }
    },

    onToolResult: async (params: {
      toolName: string;
      result: unknown;
      executionTimeMs?: number;
      success?: boolean;
      runtimeContext?: RuntimeContext;
    }) => {
      const sessionId =
        params.runtimeContext?.get<string>("agnost.sessionId") ??
        generateSessionId();

      await client.captureToolCall({
        sessionId,
        toolName: params.toolName,
        args: null,
        result: params.result,
        success: params.success ?? true,
        latencyMs: params.executionTimeMs ?? 0,
        // parentEventId not available here — onToolResult fires independently of
        // the step state. The turn → tool link is set in onGenerateEnd above.
        metadata: { framework: "mastra", phase: "tool-result" },
      });
    },
  };
}
