// @agnost/openai
// Wraps the OpenAI JS client in a JavaScript Proxy that intercepts
// chat.completions.create() — transparent to all existing call sites.
//
// The OpenAI SDK has no built-in telemetry hook. A Proxy gives us full typed
// access to params and response before and after the call, scoped only to the
// client instance you wrap (no global side effects), and zero changes required
// at call sites since the return type is identical to the original client.
//
// Usage:
//   import OpenAI from "openai"
//   import { withAgnost } from "@agnost/openai"
//
//   const openai = withAgnost(
//     new OpenAI({ apiKey: process.env.OPENAI_API_KEY }),
//     {
//       orgId: process.env.AGNOST_ORG_ID!,
//       getContext: () => ({ sessionId, userId }),
//     }
//   )
//
//   const res = await openai.chat.completions.create({ model: "gpt-4o", messages })