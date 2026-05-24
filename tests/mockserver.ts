/**
 * test/mock-server.ts
 *
 * A local HTTP server that mimics the Agnost API.
 * Use this to test the integration WITHOUT a real Agnost org ID.
 *
 * Run in one terminal:
 *   npx tsx test/mock-server.ts
 *
 * Run tests in another terminal:
 *   AGNOST_ORG_ID=test-org AGNOST_BASE_URL=http://localhost:3099 npx tsx test/e2e.ts
 */

import http from "http";

const PORT = 3099;

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const orgId = req.headers["x-org-id"];

    // Validate org ID header — Agnost requires this
    if (!orgId) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing x-org-id header" }));
      return;
    }

    let payload: any;
    try {
      payload = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    res.setHeader("Content-Type", "application/json");

    if (req.url === "/api/v1/capture-session" && req.method === "POST") {
      // Validate required fields
      if (!payload.session_id || !payload.user_data?.user_id) {
        res.writeHead(400);
        res.end(
          JSON.stringify({
            error: "session_id and user_data.user_id are required",
          }),
        );
        return;
      }

      console.log(
        `[mock] capture-session  session=${payload.session_id.slice(0, 8)}...  user=${payload.user_data.user_id}`,
      );
      res.writeHead(202);
      res.end(
        JSON.stringify({ session_id: payload.session_id, status: "accepted" }),
      );
    } else if (req.url === "/api/v1/capture-event" && req.method === "POST") {
      if (!payload.session_id || !payload.primitive_name) {
        res.writeHead(400);
        res.end(
          JSON.stringify({
            error: "session_id and primitive_name are required",
          }),
        );
        return;
      }

      console.log(
        `[mock] capture-event    session=${payload.session_id.slice(0, 8)}...` +
          `  name=${payload.primitive_name}  success=${payload.success}  latency=${payload.latency}ms`,
      );
      res.writeHead(202);
      res.end(JSON.stringify({ status: "accepted" }));
    } else {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "Not found" }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`\n🟢 Agnost mock server running at http://localhost:${PORT}`);
  console.log(`\nNow run in another terminal:`);
  console.log(
    `  AGNOST_ORG_ID=test-org AGNOST_BASE_URL=http://localhost:${PORT} npx tsx test/e2e.ts\n`,
  );
});
