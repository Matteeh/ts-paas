import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  AdminRequestError,
  AdminUnreachableError,
  HttpCaddyAdmin,
} from "../src/ingress/admin.js";

interface Captured {
  method: string;
  url: string;
  headerNames: string[];
  contentType: string | undefined;
  body: string;
}

interface TestServer {
  url: string;
  requests: Captured[];
  close: () => Promise<void>;
}

type Handler = (request: Captured, respond: Respond) => void;

interface Respond {
  status: number;
  body: string;
}

/** Caddy 2.11.4 treats any of these as a browser request and enforces origins. */
function hasBrowserHeader(headerNames: string[]): boolean {
  return headerNames.some(
    (name) =>
      name === "origin" ||
      name === "referer" ||
      name.startsWith("sec-fetch-"),
  );
}

function startServer(handler: Handler): Promise<TestServer> {
  return new Promise((resolve) => {
    const requests: Captured[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => {
        body += chunk;
      });
      req.on("end", () => {
        const captured: Captured = {
          method: req.method ?? "",
          url: req.url ?? "",
          headerNames: Object.keys(req.headers),
          contentType: req.headers["content-type"],
          body,
        };
        requests.push(captured);
        const responder: Respond = { status: 200, body: "{}" };
        if (hasBrowserHeader(captured.headerNames)) {
          responder.status = 403;
          responder.body = '{"error":"client is not allowed to access from origin \'\'"}';
        } else {
          handler(captured, responder);
        }
        res.writeHead(responder.status, { "Content-Type": "application/json" });
        res.end(responder.body);
      });
    });

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port =
        typeof address === "object" && address !== null ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

async function refusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port =
    typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

test("load and getConfig succeed against a server that rejects browser headers", async () => {
  const stored = { apps: { http: { servers: { paas: { routes: [] } } } } };
  const server = await startServer((request, respond) => {
    if (request.url === "/config/") {
      respond.body = JSON.stringify(stored);
    }
  });
  try {
    const admin = new HttpCaddyAdmin(server.url);
    const config = { admin: { listen: "0.0.0.0:2019" }, apps: {} };

    await admin.load(config);

    assert.equal(server.requests.length, 1);
    const load = server.requests[0]!;
    assert.equal(load.method, "POST");
    assert.equal(load.url, "/load");
    assert.deepEqual(JSON.parse(load.body), config);

    const read = await admin.getConfig();
    assert.deepEqual(read, stored);
    assert.equal(server.requests.length, 2);
    assert.equal(server.requests[1]!.method, "GET");
    assert.equal(server.requests[1]!.url, "/config/");
  } finally {
    await server.close();
  }
});

test("no request carries origin, referer or sec-fetch-* and load sends JSON", async () => {
  const server = await startServer((request, respond) => {
    if (request.url === "/config/") {
      respond.body = "{}";
    }
  });
  try {
    const admin = new HttpCaddyAdmin(server.url);
    await admin.load({ apps: {} });
    await admin.getConfig();

    assert.ok(server.requests.length >= 2);
    for (const request of server.requests) {
      assert.equal(
        hasBrowserHeader(request.headerNames),
        false,
        `browser header in ${request.method} ${request.url}: ${request.headerNames.join(", ")}`,
      );
    }

    const load = server.requests.find((request) => request.url === "/load")!;
    assert.equal(load.contentType, "application/json");
  } finally {
    await server.close();
  }
});

test("an empty 200 body makes getConfig resolve null", async () => {
  const server = await startServer((_request, respond) => {
    respond.body = "";
  });
  try {
    const admin = new HttpCaddyAdmin(server.url);
    assert.equal(await admin.getConfig(), null);
  } finally {
    await server.close();
  }
});

test("a refused port rejects with AdminUnreachableError naming ECONNREFUSED", async () => {
  const port = await refusedPort();
  const admin = new HttpCaddyAdmin(`http://127.0.0.1:${port}`);

  await assert.rejects(admin.load({}), (error: unknown) => {
    assert.ok(error instanceof AdminUnreachableError);
    assert.ok(
      error.message.startsWith(
        `cannot reach Caddy admin API at http://127.0.0.1:${port}: ECONNREFUSED`,
      ),
      error.message,
    );
    return true;
  });
});

test("a 400 response rejects with AdminRequestError and the first body line", async () => {
  const server = await startServer((_request, respond) => {
    respond.status = 400;
    respond.body = '{"error":"bad config"}\nmore detail';
  });
  try {
    const admin = new HttpCaddyAdmin(server.url);

    await assert.rejects(admin.load({}), (error: unknown) => {
      assert.ok(error instanceof AdminRequestError);
      assert.equal(error.status, 400);
      assert.equal(
        error.message,
        'Caddy admin API answered 400: {"error":"bad config"}',
      );
      return true;
    });
  } finally {
    await server.close();
  }
});

test("the admin client does not call fetch", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../src/ingress/admin.ts", import.meta.url)),
    "utf8",
  );
  assert.equal(
    /\bfetch\b/.test(source),
    false,
    "src/ingress/admin.ts still references fetch",
  );
});
