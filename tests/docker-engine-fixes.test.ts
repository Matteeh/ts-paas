import assert from "node:assert/strict";
import { test } from "node:test";

import { DockerRuntime } from "../src/runtime/docker.js";
import {
  ImageNotFoundError,
  NameConflictError,
  RuntimeError,
  RuntimeUnavailableError,
} from "../src/runtime/errors.js";

const SOCKET = "/run/paas.sock";

type Handler = (...args: any[]) => any;

class DockerStub {
  calls: Array<{ method: string; args: any[] }> = [];
  handlers: Record<string, Handler> = {};
  containerCalls: Array<{ id: string; method: string; args: any[] }> = [];
  containerHandlers: Record<string, Handler> = {};

  private record(method: string, args: any[]): void {
    this.calls.push({ method, args });
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
      inspect: (...args: any[]) => {
        stub.containerCalls.push({ id, method: "inspect", args });
        return stub.containerHandlers.inspect?.(id, ...args);
      },
      remove: (...args: any[]) => {
        stub.containerCalls.push({ id, method: "remove", args });
        return stub.containerHandlers.remove?.(id, ...args);
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

function runtimeWith(stub: DockerStub): DockerRuntime {
  return new DockerRuntime({ socketPath: SOCKET, client: stub.asClient() });
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

function pullStream(events: unknown[]): DockerStub {
  const stub = new DockerStub();
  stub.handlers.pull = () => Promise.resolve({});
  stub.handlers.followProgress = (_stream, onFinished) => {
    (onFinished as (error: unknown, output: unknown[]) => void)(null, events);
  };
  return stub;
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

const PODMAN_MISSING_IMAGE =
  "initializing source docker://paas-contract-missing-image:0: reading manifest 0 " +
  "in docker.io/library/paas-contract-missing-image: errors:\n" +
  "denied: requested access to the resource is denied\n" +
  "unauthorized: authentication required\n";

const PODMAN_NAME_CONFLICT =
  'container create: error creating container storage: the container name "x" ' +
  'is already in use by "9a0f...". You have to remove that container to be able ' +
  "to reuse that name.: that name is already in use";

test("pullImage maps a stream error event's message to ImageNotFoundError", async () => {
  for (const events of [
    [{ error: PODMAN_MISSING_IMAGE }],
    [{ errorDetail: { message: PODMAN_MISSING_IMAGE } }],
  ]) {
    const error = await rejection(
      runtimeWith(pullStream(events)).pullImage("reg/img:1"),
    );
    assert.ok(error instanceof ImageNotFoundError);
    assert.equal((error as Error).message, PODMAN_MISSING_IMAGE);
    assert.equal((error as { cause?: unknown }).cause, events[0]);
  }
});

test("pullImage leaves a stream error event that mentions nothing known as a plain RuntimeError", async () => {
  const error = await rejection(
    runtimeWith(pullStream([{ error: "something else broke" }])).pullImage(
      "reg/img:1",
    ),
  );
  assert.ok(error instanceof RuntimeError);
  assert.equal((error as Error).name, "RuntimeError");
  assert.ok(!(error instanceof ImageNotFoundError));
});

test("pullImage maps a 500 access-to-the-resource message to ImageNotFoundError", async () => {
  const stub = new DockerStub();
  stub.handlers.pull = () =>
    Promise.reject(
      engineError(
        "denied: requested access to the resource is denied",
        500,
      ),
    );
  const error = await rejection(runtimeWith(stub).pullImage("reg/img:1"));
  assert.ok(error instanceof ImageNotFoundError);
});

test("createContainer maps a Podman 3.4 500 name conflict to NameConflictError", async () => {
  const conflict = new DockerStub();
  conflict.handlers.createContainer = () =>
    Promise.reject(engineError(PODMAN_NAME_CONFLICT, 500));
  const conflictError = await rejection(
    runtimeWith(conflict).createContainer({ name: "x", image: "img:1" }),
  );
  assert.ok(conflictError instanceof NameConflictError);
  assert.equal((conflictError as Error).message, PODMAN_NAME_CONFLICT);

  const other = new DockerStub();
  other.handlers.createContainer = () =>
    Promise.reject(engineError("disk full", 500));
  const otherError = await rejection(
    runtimeWith(other).createContainer({ name: "x", image: "img:1" }),
  );
  assert.ok(otherError instanceof RuntimeError);
  assert.equal((otherError as Error).name, "RuntimeError");
  assert.ok(!(otherError instanceof NameConflictError));

  const explicit = new DockerStub();
  explicit.handlers.createContainer = () =>
    Promise.reject(engineError("name already in use", 409));
  assert.ok(
    (await rejection(
      runtimeWith(explicit).createContainer({ name: "x", image: "img:1" }),
    )) instanceof NameConflictError,
  );
});

test("removeContainer keeps a 500 already-in-use message a plain RuntimeError", async () => {
  const stub = new DockerStub();
  stub.containerHandlers.remove = () => {
    throw engineError('that name is already in use', 500);
  };
  const error = await rejection(runtimeWith(stub).removeContainer("web"));
  assert.ok(error instanceof RuntimeError);
  assert.equal((error as Error).name, "RuntimeError");
  assert.ok(!(error instanceof NameConflictError));
});

test("listContainers takes each state from inspect and inspects every id once", async () => {
  const stub = new DockerStub();
  stub.handlers.listContainers = () =>
    Promise.resolve([
      summaryInfo({ Id: "a", Names: ["/web"], State: "running" }),
      summaryInfo({
        Id: "b",
        Names: ["/db"],
        Image: "postgres:16",
        Labels: {},
        State: "running",
      }),
    ]);
  const statuses: Record<string, string> = { a: "exited", b: "running" };
  stub.containerHandlers.inspect = (id: string) =>
    Promise.resolve({ State: { Status: statuses[id] } });

  const summaries = await runtimeWith(stub).listContainers({
    "paas.app": "web",
  });

  assert.deepStrictEqual(summaries, [
    {
      id: "a",
      name: "web",
      image: "registry.k8s.io/pause:3.10",
      labels: { "paas.app": "web" },
      state: "exited",
    },
    {
      id: "b",
      name: "db",
      image: "postgres:16",
      labels: {},
      state: "running",
    },
  ]);
  const inspects = stub.containerCalls.filter(
    (call) => call.method === "inspect",
  );
  assert.deepStrictEqual(
    inspects.map((call) => call.id),
    ["a", "b"],
  );
});

test("listContainers leaves out a container whose inspect answers 404", async () => {
  const stub = new DockerStub();
  stub.handlers.listContainers = () =>
    Promise.resolve([
      summaryInfo({ Id: "present" }),
      summaryInfo({ Id: "gone", Names: ["/gone"], State: "exited" }),
    ]);
  stub.containerHandlers.inspect = (id: string) => {
    if (id === "gone") {
      throw engineError("no such container", 404);
    }
    return Promise.resolve({ State: { Status: "running" } });
  };

  const summaries = await runtimeWith(stub).listContainers({});
  assert.deepStrictEqual(
    summaries.map((summary) => summary.id),
    ["present"],
  );
});

test("listContainers maps an inspect socket error to RuntimeUnavailableError", async () => {
  const stub = new DockerStub();
  stub.handlers.listContainers = () => Promise.resolve([summaryInfo()]);
  stub.containerHandlers.inspect = () => {
    throw socketError("ECONNREFUSED");
  };
  const error = await rejection(runtimeWith(stub).listContainers({}));
  assert.ok(error instanceof RuntimeUnavailableError);
  assert.equal(
    (error as Error).message,
    `cannot reach container engine at ${SOCKET}: ECONNREFUSED`,
  );
});
