import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";

import {
  AdminRequestError,
  AdminUnreachableError,
  DEFAULT_ADMIN_URL,
  HttpCaddyAdmin,
  IngressError,
} from "../src/ingress/admin.js";
import { FakeCaddyAdmin } from "../src/ingress/fake-admin.js";

interface Captured {
  method: string;
  url: string;
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
          contentType: req.headers["content-type"],
          body,
        };
        requests.push(captured);
        const responder: Respond = { status: 200, body: "{}" };
        handler(captured, responder);
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

test("load posts the config as JSON and getConfig returns the parsed body", async () => {
  const server = await startServer((request, respond) => {
    if (request.url === "/config/") {
      respond.body = JSON.stringify({
        apps: { http: { servers: { paas: { routes: [] } } } },
      });
    }
  });
  try {
    assert.equal(DEFAULT_ADMIN_URL, "http://127.0.0.1:2019");
    const admin = new HttpCaddyAdmin(server.url);
    const config = { admin: { listen: "0.0.0.0:2019" }, apps: {} };

    await admin.load(config);

    assert.equal(server.requests.length, 1);
    const load = server.requests[0]!;
    assert.equal(load.method, "POST");
    assert.equal(load.url, "/load");
    assert.equal(load.contentType, "application/json");
    assert.deepEqual(JSON.parse(load.body), config);

    const read = await admin.getConfig();
    assert.deepEqual(read, {
      apps: { http: { servers: { paas: { routes: [] } } } },
    });
    assert.equal(server.requests.length, 2);
    assert.equal(server.requests[1]!.method, "GET");
    assert.equal(server.requests[1]!.url, "/config/");
  } finally {
    await server.close();
  }
});

test("a non-2xx response rejects with AdminRequestError and the first body line", async () => {
  const server = await startServer((_request, respond) => {
    respond.status = 400;
    respond.body = '{"error":"bad config"}\nmore detail';
  });
  try {
    const admin = new HttpCaddyAdmin(server.url);

    await assert.rejects(admin.load({}), (error: unknown) => {
      assert.ok(error instanceof AdminRequestError);
      assert.ok(error instanceof IngressError);
      assert.equal(error.name, "AdminRequestError");
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

test("a refused port rejects with AdminUnreachableError naming the base URL", async () => {
  const port = await refusedPort();
  const admin = new HttpCaddyAdmin(`http://127.0.0.1:${port}`);

  await assert.rejects(admin.load({}), (error: unknown) => {
    assert.ok(error instanceof AdminUnreachableError);
    assert.ok(error instanceof IngressError);
    assert.equal(error.name, "AdminUnreachableError");
    assert.ok(
      error.message.startsWith(
        `cannot reach Caddy admin API at http://127.0.0.1:${port}: `,
      ),
      error.message,
    );
    return true;
  });
});

test("FakeCaddyAdmin rejects with each queued failure in order", async () => {
  const fake = new FakeCaddyAdmin();
  const first = new Error("first failure");
  const second = new Error("second failure");
  fake.failures = [first, second];

  await assert.rejects(fake.load({ a: 1 }), (error: unknown) => error === first);
  await assert.rejects(fake.load({ a: 2 }), (error: unknown) => error === second);
  assert.deepEqual(fake.loads, []);

  await fake.load({ a: 3 });
  assert.deepEqual(fake.loads, [{ a: 3 }]);
});

test("FakeCaddyAdmin awaits onLoad before recording and remembers the last config", async () => {
  const fake = new FakeCaddyAdmin();
  assert.equal(await fake.getConfig(), null);

  const order: string[] = [];
  fake.onLoad = async () => {
    order.push("onLoad:start");
    await Promise.resolve();
    order.push("onLoad:end");
  };

  const first = { step: 1 };
  const second = { step: 2 };
  await fake.load(first);
  order.push("recorded:1");
  assert.deepEqual(fake.loads, [first]);
  await fake.load(second);
  order.push("recorded:2");

  assert.deepEqual(order, [
    "onLoad:start",
    "onLoad:end",
    "recorded:1",
    "onLoad:start",
    "onLoad:end",
    "recorded:2",
  ]);
  assert.deepEqual(fake.loads, [first, second]);
  assert.deepEqual(await fake.getConfig(), second);
});
