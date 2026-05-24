// @agnost/vercel-ai
// Implements Vercel AI SDK's TelemetryIntegration interface to capture
// LLM completions and tool calls into Agnost.
//
// Vercel AI SDK exposes experimental_telemetry.integrations — an array of
// objects with optional lifecycle methods the SDK calls at the right times.
// This is the designed hook point for observability tools: errors here are
// caught by the SDK so they cannot crash your agent, it works identically
// for both generateText() and streamText(), and multiple integrations can
// be composed in the same array.
//
// Usage:
//   import { AgnostTelemetry } from "@agnost/vercel-ai"
//   const agnost = new AgnostTelemetry({ orgId: process.env.AGNOST_ORG_ID! })
//
//   await streamText({
//     model: openai("gpt-4o"),
//     messages,
//     experimental_telemetry: {
//       isEnabled: true,
//       integrations: [agnost],
//       metadata: { sessionId, userId },
//     },
//   })