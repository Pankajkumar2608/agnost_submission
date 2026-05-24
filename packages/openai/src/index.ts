import {
  AgnostClient,
  AgnostConfig,
  generateSessionId,
  extractUserMessage,
} from "@agnost/core";

export interface AgnostOpenAIConfig extends AgnostConfig {
  // Called before each completion to supply the current session and user.
  // A function (not a static value) because the client is a singleton but
  // session context changes on every request. Callers typically read from
  // AsyncLocalStorage or a request-scoped store.
  getContext?: () => { sessionId?: string; userId?: string; email?: string };
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}
interface ChatParams {
  model: string;
  messages: ChatMessage[];
  tools?: unknown[];
  stream?: boolean;
  [key: string]: unknown;
}
interface ChatResponse {
  id: string;
  model: string;
  choices: Array<{ message: ChatMessage; finish_reason: string }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export function withAgnost<T extends object>(
  openaiClient: T,
  config: AgnostOpenAIConfig,
): T {
  const client = new AgnostClient(config);
  return buildProxy(openaiClient, client, config.getContext);
}

function buildProxy<T extends object>(
  target: T,
  client: AgnostClient,
  getContext: AgnostOpenAIConfig["getContext"],
  path: string[] = [],
): T {
  return new Proxy(target, {
    get(obj, prop: string) {
      const value = (obj as any)[prop];
      const fullPath = [...path, prop].join(".");
      if (
        fullPath === "chat.completions.create" &&
        typeof value === "function"
      ) {
        return buildInstrumentedCreate(value.bind(obj), client, getContext);
      }
      if (value !== null && value !== undefined && typeof value === "object") {
        return buildProxy(value, client, getContext, [...path, prop]);
      }
      return value;
    },
  });
}

function buildInstrumentedCreate(
  originalFn: Function,
  client: AgnostClient,
  getContext: AgnostOpenAIConfig["getContext"],
): Function {
  return async function instrumentedCreate(
    params: ChatParams,
    ...rest: unknown[]
  ): Promise<ChatResponse> {
    const startTime = Date.now();
    const ctx = getContext?.() ?? {};
    const sessionId = ctx.sessionId ?? generateSessionId();
    const userId = ctx.userId ?? "anonymous";
    // Extract the user input now — we have the messages array here but not after the call.
    const input = extractUserMessage(params.messages as any);

    await client.captureSession({
      sessionId,
      userId,
      email: ctx.email,
      metadata: {
        framework: "openai-sdk",
        model: params.model,
        hasTools: (params.tools?.length ?? 0) > 0,
      },
    });

    let response: ChatResponse;
    try {
      response = await originalFn(params, ...rest);
    } catch (err) {
      await client.capturePrompt({
        sessionId,
        promptName: "chat",
        input,
        output: err instanceof Error ? err.message : String(err),
        success: false,
        latencyMs: Date.now() - startTime,
        metadata: { model: params.model, error: true, framework: "openai-sdk" },
      });
      throw err;
    }

    const latencyMs = Date.now() - startTime;
    const choice = response.choices?.[0];
    const message = choice?.message;

    // capturePrompt returns the event_id of this agent turn.
    // Tool calls set parent_id to it so Agnost links them to this turn in the dashboard.
    const parentEventId = await client.capturePrompt({
      sessionId,
      promptName: "chat",
      input,
      output: message?.content ?? "",
      success: true,
      latencyMs,
      metadata: {
        // response.model is the actual snapshot ("gpt-4o-2024-08-06"), not the alias —
        // more accurate for cost tracking than the requested model name.
        model: response.model ?? params.model,
        finishReason: choice?.finish_reason,
        promptTokens: response.usage?.prompt_tokens,
        outputTokens: response.usage?.completion_tokens,
        totalTokens: response.usage?.total_tokens,
        framework: "openai-sdk",
      },
    });

    for (const tc of message?.tool_calls ?? []) {
      let parsedArgs: unknown;
      try {
        parsedArgs = JSON.parse(tc.function.arguments);
      } catch {
        parsedArgs = tc.function.arguments;
      }

      await client.captureToolCall({
        sessionId,
        toolName: tc.function.name,
        args: parsedArgs,
        result: null,
        success: true,
        latencyMs: 0,
        parentEventId: parentEventId ?? undefined,
        metadata: {
          toolCallId: tc.id,
          model: response.model ?? params.model,
          framework: "openai-sdk",
        },
      });
    }

    return response;
  };
}
