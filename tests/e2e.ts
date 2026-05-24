/**
 * test/e2e.ts
 * End-to-end tests against the Agnost API (real or mock).
 *
 * Against mock:  AGNOST_ORG_ID=test AGNOST_BASE_URL=http://localhost:3099 tsx test/e2e.ts
 * Against real:  AGNOST_ORG_ID=your-org-id tsx test/e2e.ts
 */

//const ORG_ID = process.env.AGNOST_ORG_ID;
const ORG_ID = "0236d275-3dd4-4764-be17-a30375c59155";
const BASE = ("https://api.agnost.ai").replace(
  /\/$/,
  "",
);
// const BASE = (process.env.AGNOST_BASE_URL ?? "https://api.agnost.ai").replace(
//   /\/$/,
//   "",
// );

const GREEN = "\x1b[32m✓\x1b[0m";
const RED = "\x1b[31m✗\x1b[0m";
const YELLOW = "\x1b[33m→\x1b[0m";
const BOLD = (s: string) => `\x1b[1m${s}\x1b[0m`;

function uuid(): string {
  return crypto.randomUUID();
}

async function post(path: string, body: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-org-id": ORG_ID! },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return {
    ok: res.status >= 200 && res.status < 300,
    status: res.status,
    data,
  };
}

let passed = 0,
  failed = 0;

async function test(name: string, fn: () => Promise<void>) {
  process.stdout.write(`\n${BOLD(name)}\n`);
  try {
    await fn();
  } catch (err) {
    console.log(`  ${RED} Threw: ${err instanceof Error ? err.message : err}`);
    failed++;
  }
}

function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`  ${GREEN} ${message}`);
    passed++;
  } else {
    console.log(`  ${RED} ${message}`);
    failed++;
  }
}

function info(msg: string) {
  console.log(`  ${YELLOW} ${msg}`);
}

async function main() {
  console.log(BOLD("\n🧪 Agnost Integration — End-to-End Tests\n"));

  if (!ORG_ID) {
    console.log(
      `${RED} AGNOST_ORG_ID not set.\n   export AGNOST_ORG_ID=your-org-id && tsx test/e2e.ts\n`,
    );
    process.exit(1);
  }

  info(`Org: ${ORG_ID.slice(0, 8)}...  Base: ${BASE}\n`);

  const sessionId = uuid();

  // ── 1. capture-session ─────────────────────────────────────────────────────
  await test("1. capture-session", async () => {
    const { status, data } = await post("/api/v1/capture-session", {
      session_id: sessionId,
      user_data: { user_id: "test-user", email: "test@example.com" },
      metadata: { framework: "test" },
      timestamp: Date.now(),
      client_config: "agnost-integrations@0.1.0",
    });
    info(`${status} — ${JSON.stringify(data)}`);
    assert(status === 202 || status === 200, `2xx (got ${status})`);
    assert(typeof (data as any)?.session_id === "string", `returns session_id`);
  });

  // ── 2. capture-event: agent turn with real input (fix #2) ──────────────────
  const turnEventId = uuid();
  await test("2. capture-event — agent turn, args is the user message (fix #2)", async () => {
    const { status, data } = await post("/api/v1/capture-event", {
      event_id: turnEventId,
      session_id: sessionId,
      primitive_name: "chat",
      args: "What is the weather in Jaipur?", // real input, not ""
      result: "It is 38°C and sunny in Jaipur.",
      success: true,
      latency: 1243,
      timestamp: Date.now(),
      metadata: { model: "gpt-4o", framework: "test" },
    });
    info(`${status} — ${JSON.stringify(data)}`);
    assert(status === 202 || status === 200, `2xx (got ${status})`);
    assert(
      (data as any)?.status === "accepted" ||
        typeof (data as any)?.event_id === "string",
      `accepted`,
    );
  });

  // ── 3. capture-event: tool call with parent_id (fix #1) ───────────────────
  await test("3. capture-event — tool call with parent_id linking to agent turn (fix #1)", async () => {
    const { status, data } = await post("/api/v1/capture-event", {
      event_id: uuid(),
      session_id: sessionId,
      primitive_name: "get_weather",
      args: JSON.stringify({ city: "Jaipur" }),
      result: JSON.stringify({ temperature: 38, condition: "sunny" }),
      success: true,
      latency: 87,
      timestamp: Date.now(),
      parent_id: turnEventId, // ← links to the agent turn above
      metadata: { framework: "test" },
    });
    info(`${status} — ${JSON.stringify(data)}`);
    assert(status === 202 || status === 200, `2xx (got ${status})`);
    assert(
      (data as any)?.status === "accepted" ||
        typeof (data as any)?.event_id === "string",
      `accepted`,
    );
  });

  // ── 4. capture-event: failed tool call ────────────────────────────────────
  await test("4. capture-event — failed tool call (success: false)", async () => {
    const { status, data } = await post("/api/v1/capture-event", {
      event_id: uuid(),
      session_id: sessionId,
      primitive_name: "search_db",
      args: JSON.stringify({ query: "orders" }),
      result: "Connection timeout",
      success: false,
      latency: 30000,
      timestamp: Date.now(),
      parent_id: turnEventId,
      metadata: { error: true, framework: "test" },
    });
    info(`${status} — ${JSON.stringify(data)}`);
    assert(
      status === 202 || status === 200,
      `2xx for failed events (got ${status})`,
    );
  });

  // ── 5. second session ──────────────────────────────────────────────────────
  await test("5. capture-session — second user", async () => {
    const s2 = uuid();
    const { status, data } = await post("/api/v1/capture-session", {
      session_id: s2,
      user_data: { user_id: "test-user-2" },
      timestamp: Date.now(),
      client_config: "agnost-integrations@0.1.0",
    });
    info(`${status} — ${JSON.stringify(data)}`);
    assert(status === 202 || status === 200, `2xx (got ${status})`);
    assert((data as any)?.session_id === s2, `session_id echoed`);
  });

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(50)}`);
  console.log(
    `${BOLD("Results:")} ${GREEN} ${passed} passed   ${RED} ${failed} failed\x1b[0m`,
  );

  if (failed === 0) {
    console.log(`\n${GREEN} All tests passed.`);
    console.log(`   Check your Agnost dashboard for the test sessions.\n`);
  } else {
    console.log(
      `\n${RED} Some tests failed. Check your AGNOST_ORG_ID and network.\n`,
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
