//  @agnost/mastra
//  Two-surface instrumentation for Mastra agents.


//  Surface 1 — createAgnostMiddleware(): Hono middleware on the Mastra server.
//    Reads x-session-id and x-user-id from request headers, calls capture-session,
//    and injects both values into RuntimeContext so agent hooks can read them
//    without accessing the raw HTTP request.
 
//  Surface 2 — agnostHooks(): lifecycle hooks spread onto a Mastra Agent.
//    Fires around each LLM call and tool execution in the agent loop.
 
//  Two surfaces are needed because Mastra v0.14+ controls its own agent loop —
//  tool execution happens inside Mastra between AI SDK calls, so a single
//  hook point on the LLM layer misses tool events entirely.
//  Middleware handles session lifecycle; hooks handle event-level capture.
//  Both share one AgnostClient — one HTTP connection pool, one session cache.
 
//  Usage:
//    const agnostMiddleware = createAgnostMiddleware({ orgId: process.env.AGNOST_ORG_ID! })
 
//    const myAgent = new Agent({
//      name: "MyAgent",
//      model: openai("gpt-4o"),
//      instructions: "...",
//      ...agnostHooks(agnostMiddleware.client),
//    })
  
//    export const mastra = new Mastra({
//      agents: { myAgent },
//      server: { middleware: [agnostMiddleware] },
//    })