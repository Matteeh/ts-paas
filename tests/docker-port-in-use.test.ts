import assert from "node:assert/strict";
import { test } from "node:test";

import { DockerRuntime } from "../src/runtime/docker.js";
import {
  NameConflictError,
  PortInUseError,
  RuntimeError,
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

  createContainer(...args: any[]): any {
    this.record("createContainer", args);
    return this.handlers.createContainer?.(...args);
  }

  getContainer(id: string): any {
    this.record("getContainer", [id]);
    const stub = this;
    return {
      start: (...args: any[]) => {
        stub.containerCalls.push({ id, method: "start", args });
        return stub.containerHandlers.start?.(id, ...args);
      },
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

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

const PODMAN_ROOTLESSPORT =
  "rootlessport listen tcp 0.0.0.0:38080: bind: address already in use";
const DOCKER_ENGINE =
  "driver failed programming external connectivity on endpoint paas-caddy " +
  "(b9ac2b2e...): Bind for 0.0.0.0:8080 failed: port is already allocated";
const DOCKER_DESKTOP =
  "Ports are not available: exposing port TCP 127.0.0.1:2019 -> 0.0.0.0:0: " +
  "listen tcp 127.0.0.1:2019: bind: Only one usage of each socket address " +
  "(protocol/network address/port) is normally permitted.";

test("startContainer maps each busy-port engine message to PortInUseError with its address", async () => {
  const cases = [
    { message: PODMAN_ROOTLESSPORT, address: "0.0.0.0:38080" },
    { message: DOCKER_ENGINE, address: "0.0.0.0:8080" },
    { message: DOCKER_DESKTOP, address: "127.0.0.1:2019" },
  ];
  for (const { message, address } of cases) {
    const original = engineError(message, 500);
    const stub = new DockerStub();
    stub.containerHandlers.start = () => {
      throw original;
    };
    const error = await rejection(
      runtimeWith(stub).startContainer("paas-caddy"),
    );
    assert.ok(error instanceof PortInUseError, message);
    assert.equal((error as Error).name, "PortInUseError");
    assert.equal((error as Error).message, message);
    assert.equal((error as PortInUseError).address, address);
    assert.equal((error as { cause?: unknown }).cause, original);
  }
});

test("createContainer maps the Docker Engine busy-port message to PortInUseError", async () => {
  const original = engineError(DOCKER_ENGINE, 500);
  const stub = new DockerStub();
  stub.handlers.createContainer = () => {
    throw original;
  };
  const error = await rejection(
    runtimeWith(stub).createContainer({
      name: "paas-caddy",
      image: "caddy:2",
    }),
  );
  assert.ok(error instanceof PortInUseError);
  assert.equal((error as Error).message, DOCKER_ENGINE);
  assert.equal((error as PortInUseError).address, "0.0.0.0:8080");
  assert.equal((error as { cause?: unknown }).cause, original);
});

test("a busy-port message that names no address gives PortInUseError with a null address", async () => {
  const stub = new DockerStub();
  stub.containerHandlers.start = () => {
    throw engineError("cannot start: address already in use", 500);
  };
  const error = await rejection(runtimeWith(stub).startContainer("x"));
  assert.ok(error instanceof PortInUseError);
  assert.equal((error as PortInUseError).address, null);
});

test("a create 500 ending that name is already in use stays NameConflictError", async () => {
  const message =
    'the container name "x" is already in use by "9a0f...": ' +
    "that name is already in use";
  const stub = new DockerStub();
  stub.handlers.createContainer = () => {
    throw engineError(message, 500);
  };
  const error = await rejection(
    runtimeWith(stub).createContainer({ name: "x", image: "img:1" }),
  );
  assert.ok(error instanceof NameConflictError);
  assert.ok(!(error instanceof PortInUseError));
});

test("a plain 500 on start stays a plain RuntimeError", async () => {
  const stub = new DockerStub();
  stub.containerHandlers.start = () => {
    throw engineError("disk full", 500);
  };
  const error = await rejection(runtimeWith(stub).startContainer("x"));
  assert.ok(error instanceof RuntimeError);
  assert.equal((error as Error).name, "RuntimeError");
  assert.ok(!(error instanceof PortInUseError));
});

test("PortInUseError is a named RuntimeError", () => {
  const error = new PortInUseError("m", "1.2.3.4:5");
  assert.equal(error.name, "PortInUseError");
  assert.ok(error instanceof RuntimeError);
  assert.equal(error.address, "1.2.3.4:5");
});
