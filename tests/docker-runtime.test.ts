import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { DockerRuntime } from "../src/runtime/docker.js";
import {
  ContainerNotFoundError,
  ImageNotFoundError,
  NameConflictError,
  RuntimeError,
  RuntimeUnavailableError,
} from "../src/runtime/errors.js";
import type { ContainerInfo } from "../src/runtime/types.js";

const SOCKET = "/run/paas.sock";

type Handler = (...args: any[]) => any;

class DockerStub {
  calls: Array<{ method: string; args: any[] }> = [];
  handlers: Record<string, Handler> = {};
  containerCalls: Array<{ id: string; method: string; args: any[] }> = [];
  containerHandlers: Record<string, Handler> = {};
  networkCalls: Array<{ name: string; method: string; args: any[] }> = [];
  networkHandlers: Record<string, Handler> = {};
  volumeCalls: Array<{ name: string; method: string; args: any[] }> = [];
  volumeHandlers: Record<string, Handler> = {};

  private record(method: string, args: any[]): void {
    this.calls.push({ method, args });
  }

  version(...args: any[]): any {
    this.record("version", args);
    return this.handlers.version?.(...args);
  }

  pull(...args: any[]): any {
    this.record("pull", args);
    return this.handlers.pull?.(...args);
  }

  createContainer(...args: any[]): any {
    this.record("createContainer", args);
    return this.handlers.createContainer?.(...args);
  }

  listContainers(...args: any[]): any {
    this.record("listContainers", args);
    return this.handlers.listContainers?.(...args);
  }

  getContainer(id: string): any {
    this.record("getContainer", [id]);
    const stub = this;
    return {
      id,
      start: (...args: any[]) => {
        stub.containerCalls.push({ id, method: "start", args });
        return stub.containerHandlers.start?.(...args);
      },
      stop: (...args: any[]) => {
        stub.containerCalls.push({ id, method: "stop", args });
        return stub.containerHandlers.stop?.(...args);
      },
      remove: (...args: any[]) => {
        stub.containerCalls.push({ id, method: "remove", args });
        return stub.containerHandlers.remove?.(...args);
      },
      inspect: (...args: any[]) => {
        stub.containerCalls.push({ id, method: "inspect", args });
        return stub.containerHandlers.inspect?.(...args);
      },
      logs: (...args: any[]) => {
        stub.containerCalls.push({ id, method: "logs", args });
        return stub.containerHandlers.logs?.(...args);
      },
    };
  }

  createNetwork(...args: any[]): any {
    this.record("createNetwork", args);
    return this.handlers.createNetwork?.(...args);
  }

  listNetworks(...args: any[]): any {
    this.record("listNetworks", args);
    return this.handlers.listNetworks?.(...args);
  }

  getNetwork(name: string): any {
    this.record("getNetwork", [name]);
    const stub = this;
    return {
      inspect: (...args: any[]) => {
        stub.networkCalls.push({ name, method: "inspect", args });
        return stub.networkHandlers.inspect?.(...args);
      },
      remove: (...args: any[]) => {
        stub.networkCalls.push({ name, method: "remove", args });
        return stub.networkHandlers.remove?.(...args);
      },
    };
  }

  createVolume(...args: any[]): any {
    this.record("createVolume", args);
    return this.handlers.createVolume?.(...args);
  }

  listVolumes(...args: any[]): any {
    this.record("listVolumes", args);
    return this.handlers.listVolumes?.(...args);
  }

  getVolume(name: string): any {
    this.record("getVolume", [name]);
    const stub = this;
    return {
      inspect: (...args: any[]) => {
        stub.volumeCalls.push({ name, method: "inspect", args });
        return stub.volumeHandlers.inspect?.(...args);
      },
      remove: (...args: any[]) => {
        stub.volumeCalls.push({ name, method: "remove", args });
        return stub.volumeHandlers.remove?.(...args);
      },
    };
  }

  get modem(): {
    followProgress: (
      stream: unknown,
      onFinished: (error: unknown, output: unknown[]) => void,
    ) => void;
  } {
    const stub = this;
    return {
      followProgress(stream, onFinished) {
        stub.record("followProgress", [stream]);
        const handler = stub.handlers.followProgress;
        if (handler !== undefined) {
          handler(stream, onFinished);
          return;
        }
        onFinished(null, []);
      },
    };
  }

  asClient(): never {
    return this as never;
  }
}

function runtimeWith(
  stub: DockerStub,
  labels?: Record<string, string>,
): DockerRuntime {
  return new DockerRuntime({
    socketPath: SOCKET,
    client: stub.asClient(),
    labels,
  });
}

function engineError(message: string, statusCode: number): Error {
  return Object.assign(new Error(message), {
    statusCode,
    json: { message },
  }) as Error;
}

function socketError(code: string): Error {
  return Object.assign(new Error(`socket ${code}`), { code }) as Error;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

function inspectInfo(overrides: Record<string, any> = {}): any {
  return {
    Id: "id-1",
    Name: "/web",
    Config: {
      Image: "registry.k8s.io/pause:3.10",
      Labels: { "paas.app": "web" },
      Tty: false,
    },
    State: {
      Status: "created",
      ExitCode: 0,
      StartedAt: "0001-01-01T00:00:00Z",
      FinishedAt: "0001-01-01T00:00:00Z",
    },
    RestartCount: 0,
    ...overrides,
  };
}

function summaryInfo(overrides: Record<string, any> = {}): any {
  return {
    Id: "id-1",
    Names: ["/web"],
    Image: "registry.k8s.io/pause:3.10",
    Labels: { "paas.app": "web" },
    State: "running",
    ...overrides,
  };
}

function frame(stream: 1 | 2, text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

test("ping reports docker with version, apiVersion and endpoint", async () => {
  const stub = new DockerStub();
  stub.handlers.version = () => ({
    Version: "27.1.1",
    ApiVersion: "1.46",
    Components: [{ Name: "Engine", Version: "27.1.1" }],
  });
  const info = await runtimeWith(stub).ping();
  assert.deepStrictEqual(info, {
    name: "docker",
    version: "27.1.1",
    apiVersion: "1.46",
    endpoint: SOCKET,
  });
});

test("ping reports podman when a component names Podman Engine", async () => {
  const stub = new DockerStub();
  stub.handlers.version = () => ({
    Version: "5.0.0",
    ApiVersion: "1.41",
    Components: [{ Name: "Podman Engine", Version: "5.0.0" }],
  });
  const info = await runtimeWith(stub).ping();
  assert.deepStrictEqual(info, {
    name: "podman",
    version: "5.0.0",
    apiVersion: "1.41",
    endpoint: SOCKET,
  });
});

test("constructing a runtime makes no client call", () => {
  const stub = new DockerStub();
  runtimeWith(stub, { "paas.test": "true" });
  const plain = new DockerRuntime({ socketPath: SOCKET });
  assert.equal(plain.socketPath, SOCKET);
  assert.deepStrictEqual(stub.calls, []);
});

test("pullImage resolves only after followProgress finishes", async () => {
  const stub = new DockerStub();
  let finish: (error: unknown, output: unknown[]) => void = () => {};
  stub.handlers.pull = () => Promise.resolve({});
  stub.handlers.followProgress = (_stream, onFinished) => {
    finish = onFinished as typeof finish;
  };
  const runtime = runtimeWith(stub);
  const promise = runtime.pullImage("registry.example/img:1");
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  finish(null, []);
  await promise;
  assert.equal(settled, true);
});

test("pullImage rejects when an output event carries an error", async () => {
  for (const event of [
    { error: "manifest unknown" },
    { errorDetail: { message: "pull access denied" } },
  ]) {
    const stub = new DockerStub();
    stub.handlers.pull = () => Promise.resolve({});
    stub.handlers.followProgress = (_stream, onFinished) => {
      (onFinished as (error: unknown, output: unknown[]) => void)(null, [event]);
    };
    const error = await rejection(runtimeWith(stub).pullImage("reg/img:1"));
    assert.ok(error instanceof RuntimeError);
    assert.equal(error.constructor, RuntimeError);
  }
});

test("pullImage maps 404 and Podman 500 messages to ImageNotFoundError", async () => {
  const notFound = new DockerStub();
  notFound.handlers.pull = () => Promise.reject(engineError("No such image", 404));
  const notFoundError = await rejection(
    runtimeWith(notFound).pullImage("reg/img:1"),
  );
  assert.ok(notFoundError instanceof ImageNotFoundError);
  assert.equal((notFoundError as Error).message, "No such image");

  for (const message of [
    "manifest unknown",
    "image does not exist",
    "pull access denied",
  ]) {
    const stub = new DockerStub();
    const original = engineError(message, 500);
    stub.handlers.pull = () => Promise.reject(original);
    const error = await rejection(runtimeWith(stub).pullImage("reg/img:1"));
    assert.ok(error instanceof ImageNotFoundError);
    assert.equal((error as Error).message, message);
    assert.equal((error as { cause?: unknown }).cause, original);
  }
});

test("pullImage maps any other 500 to a plain RuntimeError", async () => {
  const stub = new DockerStub();
  stub.handlers.pull = () => Promise.reject(engineError("server broke", 500));
  const error = await rejection(runtimeWith(stub).pullImage("reg/img:1"));
  assert.ok(error instanceof RuntimeError);
  assert.equal((error as Error).name, "RuntimeError");
  assert.ok(!(error instanceof ImageNotFoundError));
});

test("createContainer sends the contracted body and returns the id", async () => {
  const stub = new DockerStub();
  stub.handlers.createContainer = () => Promise.resolve({ id: "created-1" });
  const runtime = runtimeWith(stub, { "paas.test": "true" });
  const id = await runtime.createContainer({
    name: "web",
    image: "registry.k8s.io/pause:3.10",
    env: { A: "1", B: "2" },
    labels: { "paas.app": "web" },
    network: "paas-net",
    internalPort: 3000,
    restartPolicy: "unless-stopped",
    publish: [{ hostIp: "127.0.0.1", hostPort: 12345, containerPort: 8080 }],
    volumes: [{ volume: "data", path: "/data", readOnly: true }],
  });
  assert.equal(id, "created-1");
  const body = stub.calls.find((call) => call.method === "createContainer")!
    .args[0];
  assert.deepStrictEqual(body, {
    name: "web",
    Image: "registry.k8s.io/pause:3.10",
    Env: ["A=1", "B=2"],
    Labels: {
      "paas.app": "web",
      "paas.test": "true",
      "paas.managed": "true",
    },
    ExposedPorts: { "3000/tcp": {}, "8080/tcp": {} },
    HostConfig: {
      RestartPolicy: { Name: "unless-stopped" },
      PortBindings: {
        "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "12345" }],
      },
      Binds: ["data:/data:ro"],
      NetworkMode: "paas-net",
    },
  });
});

test("createContainer maps 409 to NameConflictError and 404 to ImageNotFoundError", async () => {
  const conflict = new DockerStub();
  conflict.handlers.createContainer = () =>
    Promise.reject(engineError("name already in use", 409));
  const conflictError = await rejection(
    runtimeWith(conflict).createContainer({ name: "web", image: "img:1" }),
  );
  assert.ok(conflictError instanceof NameConflictError);

  const missing = new DockerStub();
  missing.handlers.createContainer = () =>
    Promise.reject(engineError("No such image", 404));
  const missingError = await rejection(
    runtimeWith(missing).createContainer({ name: "web", image: "img:1" }),
  );
  assert.ok(missingError instanceof ImageNotFoundError);
});

test("startContainer treats 304 as success and maps 404", async () => {
  const stub = new DockerStub();
  stub.containerHandlers.start = () => {
    throw engineError("already started", 304);
  };
  const runtime = runtimeWith(stub);
  await runtime.startContainer("web");

  stub.containerHandlers.start = () => {
    throw engineError("no such container", 404);
  };
  await assert.rejects(runtime.startContainer("web"), ContainerNotFoundError);
});

test("stopContainer passes t and treats 304 as success", async () => {
  const stub = new DockerStub();
  stub.containerHandlers.stop = (options: unknown) => {
    throw engineError("already stopped", 304);
  };
  const runtime = runtimeWith(stub);
  await runtime.stopContainer("web", { timeoutSeconds: 7 });
  const options = stub.containerCalls.find(
    (call) => call.method === "stop",
  )!.args[0];
  assert.deepStrictEqual(options, { t: 7 });

  stub.containerHandlers.stop = () => {
    throw engineError("no such container", 404);
  };
  await assert.rejects(runtime.stopContainer("web"), ContainerNotFoundError);
});

test("removeContainer passes force and maps 409 to a plain RuntimeError", async () => {
  const stub = new DockerStub();
  stub.containerHandlers.remove = () => Promise.resolve();
  const runtime = runtimeWith(stub);
  await runtime.removeContainer("web", { force: true });
  const options = stub.containerCalls.find(
    (call) => call.method === "remove",
  )!.args[0];
  assert.deepStrictEqual(options, { force: true });

  stub.containerHandlers.remove = () => {
    throw engineError("container is running", 409);
  };
  const error = await rejection(runtime.removeContainer("web"));
  assert.ok(error instanceof RuntimeError);
  assert.equal((error as Error).name, "RuntimeError");
  assert.ok(!(error instanceof NameConflictError));
});

test("inspectContainer maps states, zero times, the name and RestartCount", async () => {
  const stub = new DockerStub();
  const runtime = runtimeWith(stub);

  stub.containerHandlers.inspect = () => Promise.resolve(inspectInfo());
  const fresh = await runtime.inspectContainer("web");
  assert.deepStrictEqual(fresh, {
    id: "id-1",
    name: "web",
    image: "registry.k8s.io/pause:3.10",
    labels: { "paas.app": "web" },
    state: "created",
    exitCode: null,
    startedAt: null,
    finishedAt: null,
    restartCount: 0,
  } satisfies ContainerInfo);

  stub.containerHandlers.inspect = () =>
    Promise.resolve(
      inspectInfo({
        State: {
          Status: "running",
          ExitCode: 0,
          StartedAt: "2024-05-05T10:00:00.000Z",
          FinishedAt: "0001-01-01T00:00:00Z",
        },
        RestartCount: 3,
      }),
    );
  const running = await runtime.inspectContainer("id-1");
  assert.equal(running.state, "running");
  assert.equal(running.exitCode, null);
  assert.equal(running.startedAt?.toISOString(), "2024-05-05T10:00:00.000Z");
  assert.equal(running.finishedAt, null);
  assert.equal(running.restartCount, 3);

  for (const [status, expected] of [
    ["restarting", "running"],
    ["paused", "running"],
    ["exited", "exited"],
    ["dead", "exited"],
    ["removing", "exited"],
  ] as const) {
    stub.containerHandlers.inspect = () =>
      Promise.resolve(
        inspectInfo({
          State: {
            Status: status,
            ExitCode: 9,
            StartedAt: "2024-05-05T10:00:00.000Z",
            FinishedAt: "2024-05-05T11:00:00.000Z",
          },
        }),
      );
    const info = await runtime.inspectContainer("web");
    assert.equal(info.state, expected);
    if (expected === "exited") {
      assert.equal(info.exitCode, 9);
      assert.equal(info.finishedAt?.toISOString(), "2024-05-05T11:00:00.000Z");
    } else {
      assert.equal(info.exitCode, null);
    }
  }
});

test("listContainers sends all and one label filter entry per label", async () => {
  const stub = new DockerStub();
  stub.handlers.listContainers = () =>
    Promise.resolve([
      summaryInfo(),
      summaryInfo({
        Id: "id-2",
        Names: ["/db"],
        Image: "postgres:16",
        Labels: {},
        State: "exited",
      }),
    ]);
  const summaries = await runtimeWith(stub).listContainers({
    "paas.app": "web",
    "paas.managed": "true",
  });
  const options = stub.calls.find(
    (call) => call.method === "listContainers",
  )!.args[0];
  assert.deepStrictEqual(options, {
    all: true,
    filters: { label: ["paas.app=web", "paas.managed=true"] },
  });
  assert.deepStrictEqual(summaries, [
    {
      id: "id-1",
      name: "web",
      image: "registry.k8s.io/pause:3.10",
      labels: { "paas.app": "web" },
      state: "running",
    },
    {
      id: "id-2",
      name: "db",
      image: "postgres:16",
      labels: {},
      state: "exited",
    },
  ]);
});

test("containerLogs requests since in seconds and applies millisecond since and tail", async () => {
  const stub = new DockerStub();
  const data = Buffer.concat([
    frame(1, "2024-01-01T00:00:01.500Z alpha\n"),
    frame(2, "2024-01-01T00:00:02.250Z beta\n"),
    frame(1, "2024-01-01T00:00:03.000Z gamma\n"),
  ]);
  stub.containerHandlers.inspect = () => Promise.resolve(inspectInfo());
  stub.containerHandlers.logs = () => Promise.resolve(data);
  const runtime = runtimeWith(stub);
  const since = new Date("2024-01-01T00:00:02.000Z");
  const entries = await runtime.containerLogs("web", { since, tail: 1 });
  const options = stub.containerCalls.find(
    (call) => call.method === "logs",
  )!.args[0];
  assert.deepStrictEqual(options, {
    follow: false,
    stdout: true,
    stderr: true,
    timestamps: true,
    since: Math.floor(since.getTime() / 1000),
  });
  assert.deepStrictEqual(entries, [
    {
      stream: "stdout",
      time: new Date("2024-01-01T00:00:03.000Z"),
      text: "gamma",
    },
  ]);
});

test("containerLogs requests tail when there is no since", async () => {
  const stub = new DockerStub();
  stub.containerHandlers.inspect = () => Promise.resolve(inspectInfo());
  stub.containerHandlers.logs = () =>
    Promise.resolve(
      Buffer.concat([
        frame(1, "2024-01-01T00:00:01.000Z one\n"),
        frame(1, "2024-01-01T00:00:02.000Z two\n"),
        frame(1, "2024-01-01T00:00:03.000Z three\n"),
      ]),
    );
  const runtime = runtimeWith(stub);
  const entries = await runtime.containerLogs("web", { tail: 2 });
  const options = stub.containerCalls.find(
    (call) => call.method === "logs",
  )!.args[0];
  assert.equal(options.tail, 2);
  assert.deepStrictEqual(
    entries.map((entry) => entry.text),
    ["two", "three"],
  );
});

test("containerLogs demultiplexes stdout and stderr frames", async () => {
  const stub = new DockerStub();
  stub.containerHandlers.inspect = () => Promise.resolve(inspectInfo());
  stub.containerHandlers.logs = () =>
    Promise.resolve(
      Buffer.concat([
        frame(1, "2024-01-01T00:00:01.000Z out\n"),
        frame(2, "2024-01-01T00:00:02.000Z err\n"),
      ]),
    );
  const entries = await runtimeWith(stub).containerLogs("web");
  assert.deepStrictEqual(entries, [
    {
      stream: "stdout",
      time: new Date("2024-01-01T00:00:01.000Z"),
      text: "out",
    },
    {
      stream: "stderr",
      time: new Date("2024-01-01T00:00:02.000Z"),
      text: "err",
    },
  ]);
});

test("containerLogs treats a TTY container as one stdout stream", async () => {
  const stub = new DockerStub();
  stub.containerHandlers.inspect = () =>
    Promise.resolve(
      inspectInfo({
        Config: {
          Image: "registry.k8s.io/pause:3.10",
          Labels: {},
          Tty: true,
        },
      }),
    );
  stub.containerHandlers.logs = () =>
    Promise.resolve(
      Buffer.from(
        "2024-01-01T00:00:01.000Z one\n2024-01-01T00:00:02.000Z two\n",
      ),
    );
  const entries = await runtimeWith(stub).containerLogs("web");
  assert.deepStrictEqual(
    entries.map((entry) => entry.stream),
    ["stdout", "stdout"],
  );
});

test("ensureNetwork creates only after a 404 inspect and treats 409 as success", async () => {
  const notFound = engineError("no such network", 404);

  const create = new DockerStub();
  create.networkHandlers.inspect = () => {
    throw notFound;
  };
  create.handlers.createNetwork = () => Promise.resolve({});
  await runtimeWith(create, { "paas.test": "true" }).ensureNetwork("paas-net");
  assert.deepStrictEqual(
    create.calls.find((call) => call.method === "createNetwork")!.args[0],
    {
      Name: "paas-net",
      Driver: "bridge",
      Labels: { "paas.test": "true" },
    },
  );

  const existing = new DockerStub();
  existing.networkHandlers.inspect = () => Promise.resolve({ Name: "paas-net" });
  existing.handlers.createNetwork = () => {
    throw new Error("should not create");
  };
  await runtimeWith(existing).ensureNetwork("paas-net");
  assert.equal(
    existing.calls.some((call) => call.method === "createNetwork"),
    false,
  );

  const raced = new DockerStub();
  raced.networkHandlers.inspect = () => {
    throw notFound;
  };
  raced.handlers.createNetwork = () => {
    throw engineError("already exists", 409);
  };
  await runtimeWith(raced).ensureNetwork("paas-net");
});

test("ensureVolume creates only after a 404 inspect and treats 409 as success", async () => {
  const notFound = engineError("no such volume", 404);

  const create = new DockerStub();
  create.volumeHandlers.inspect = () => {
    throw notFound;
  };
  create.handlers.createVolume = () => Promise.resolve({});
  await runtimeWith(create, { "paas.test": "true" }).ensureVolume("data");
  assert.deepStrictEqual(
    create.calls.find((call) => call.method === "createVolume")!.args[0],
    { Name: "data", Labels: { "paas.test": "true" } },
  );

  const existing = new DockerStub();
  existing.volumeHandlers.inspect = () => Promise.resolve({ Name: "data" });
  existing.handlers.createVolume = () => {
    throw new Error("should not create");
  };
  await runtimeWith(existing).ensureVolume("data");
  assert.equal(
    existing.calls.some((call) => call.method === "createVolume"),
    false,
  );

  const raced = new DockerStub();
  raced.volumeHandlers.inspect = () => {
    throw notFound;
  };
  raced.handlers.createVolume = () => {
    throw engineError("already exists", 409);
  };
  await runtimeWith(raced).ensureVolume("data");
});

test("networkExists is true on inspect and false on 404", async () => {
  const present = new DockerStub();
  present.networkHandlers.inspect = () => Promise.resolve({});
  assert.equal(await runtimeWith(present).networkExists("n1"), true);

  const absent = new DockerStub();
  absent.networkHandlers.inspect = () => {
    throw engineError("no such network", 404);
  };
  assert.equal(await runtimeWith(absent).networkExists("n1"), false);
});

test("removeLabelled removes containers, then networks, then volumes", async () => {
  const stub = new DockerStub();
  const order: string[] = [];
  stub.handlers.listContainers = () =>
    Promise.resolve([summaryInfo({ Id: "c1" })]);
  stub.containerHandlers.remove = () => {
    order.push("container");
    return Promise.resolve();
  };
  stub.handlers.listNetworks = () =>
    Promise.resolve([{ Name: "paas-net", Id: "n1" }]);
  stub.networkHandlers.remove = () => {
    order.push("network");
    return Promise.resolve();
  };
  stub.handlers.listVolumes = () =>
    Promise.resolve({ Volumes: [{ Name: "data" }], Warnings: [] });
  stub.volumeHandlers.remove = () => {
    order.push("volume");
    return Promise.resolve();
  };

  await runtimeWith(stub, { "paas.test": "true" }).removeLabelled({
    "paas.test": "true",
  });

  assert.deepStrictEqual(order, ["container", "network", "volume"]);
  const filters = { label: ["paas.test=true"] };
  assert.deepStrictEqual(
    stub.calls.find((call) => call.method === "listContainers")!.args[0],
    { all: true, filters },
  );
  assert.deepStrictEqual(
    stub.calls.find((call) => call.method === "listNetworks")!.args[0],
    { filters },
  );
  assert.deepStrictEqual(
    stub.calls.find((call) => call.method === "listVolumes")!.args[0],
    { filters },
  );
  assert.deepStrictEqual(
    stub.containerCalls.find((call) => call.method === "remove")!.args[0],
    { force: true },
  );
});

test("removeLabelled ignores 404s while removing", async () => {
  const stub = new DockerStub();
  const notFound = engineError("gone", 404);
  stub.handlers.listContainers = () =>
    Promise.resolve([summaryInfo({ Id: "c1" })]);
  stub.containerHandlers.remove = () => {
    throw notFound;
  };
  stub.handlers.listNetworks = () => Promise.resolve([{ Name: "paas-net" }]);
  stub.networkHandlers.remove = () => {
    throw notFound;
  };
  stub.handlers.listVolumes = () =>
    Promise.resolve({ Volumes: [{ Name: "data" }], Warnings: [] });
  stub.volumeHandlers.remove = () => {
    throw notFound;
  };
  await runtimeWith(stub).removeLabelled({ "paas.test": "true" });
});

test("socket errors become RuntimeUnavailableError named after the socket", async () => {
  for (const code of ["ECONNREFUSED", "ENOENT", "EACCES", "ENOTSOCK"]) {
    const stub = new DockerStub();
    const original = socketError(code);
    stub.handlers.version = () => {
      throw original;
    };
    const error = await rejection(runtimeWith(stub).ping());
    assert.ok(error instanceof RuntimeUnavailableError);
    assert.equal(
      (error as Error).message,
      `cannot reach container engine at ${SOCKET}: ${code}`,
    );
    assert.equal((error as { cause?: unknown }).cause, original);
  }
});

test("package.json exposes the integration script", () => {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { scripts: Record<string, string> };
  assert.equal(
    pkg.scripts["test:integration"],
    'node --import tsx --test "tests/integration/**/*.itest.ts"',
  );
});
