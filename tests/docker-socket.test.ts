import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RuntimeUnavailableError } from "../src/runtime/errors.js";
import {
  nodeSocketProbe,
  resolveSocket,
  type SocketProbe,
} from "../src/runtime/socket.js";

function probe(
  existing: string[],
  homedir = "/home/tester",
  uid = 1000,
): SocketProbe {
  return {
    exists: (path) => existing.includes(path),
    homedir,
    uid,
  };
}

const DOCKER_SOCKET = "/var/run/docker.sock";
const DOCKER_DESKTOP = "/home/tester/.docker/run/docker.sock";
const PODMAN_USER = "/run/user/1000/podman/podman.sock";

function catchError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}

describe("resolveSocket", () => {
  it("prefers PAAS_SOCKET over every other setting", () => {
    const resolved = resolveSocket(
      {
        PAAS_SOCKET: "/paas.sock",
        DOCKER_HOST: "unix:///docker.sock",
        PODMAN_SOCKET: "/podman.sock",
      },
      probe(["/paas.sock", "/docker.sock", "/podman.sock"]),
    );
    assert.deepStrictEqual(resolved, {
      path: "/paas.sock",
      source: "PAAS_SOCKET",
    });
  });

  it("takes the path out of a unix:// DOCKER_HOST", () => {
    const resolved = resolveSocket(
      { DOCKER_HOST: "unix:///a.sock" },
      probe(["/a.sock"]),
    );
    assert.deepStrictEqual(resolved, { path: "/a.sock", source: "DOCKER_HOST" });
  });

  it("ignores a non-unix DOCKER_HOST and uses PODMAN_SOCKET", () => {
    const resolved = resolveSocket(
      { DOCKER_HOST: "tcp://h:2375", PODMAN_SOCKET: "/podman.sock" },
      probe(["/podman.sock"]),
    );
    assert.deepStrictEqual(resolved, {
      path: "/podman.sock",
      source: "PODMAN_SOCKET",
    });
  });

  it("treats empty variables as unset", () => {
    const resolved = resolveSocket(
      { PAAS_SOCKET: "", DOCKER_HOST: "", PODMAN_SOCKET: "" },
      probe([DOCKER_SOCKET]),
    );
    assert.deepStrictEqual(resolved, {
      path: DOCKER_SOCKET,
      source: "default",
    });
  });

  it("throws for an explicit socket the probe says is missing, even when /var/run/docker.sock exists", () => {
    const error = catchError(() =>
      resolveSocket({ PAAS_SOCKET: "/missing.sock" }, probe([DOCKER_SOCKET])),
    );
    assert.ok(error instanceof RuntimeUnavailableError);
    assert.equal(
      error.message,
      "cannot reach container engine at /missing.sock: socket not found",
    );
  });

  it("fails an explicit DOCKER_HOST whose path is missing without falling back", () => {
    assert.throws(
      () =>
        resolveSocket(
          { DOCKER_HOST: "unix:///missing.sock" },
          probe([DOCKER_SOCKET]),
        ),
      (error: unknown) =>
        error instanceof RuntimeUnavailableError &&
        error.message ===
          "cannot reach container engine at /missing.sock: socket not found",
    );
  });

  it("probes the default paths in order", () => {
    const all = [DOCKER_SOCKET, DOCKER_DESKTOP, PODMAN_USER];
    assert.deepStrictEqual(resolveSocket({}, probe(all)), {
      path: DOCKER_SOCKET,
      source: "default",
    });
    assert.deepStrictEqual(resolveSocket({}, probe([DOCKER_DESKTOP, PODMAN_USER])), {
      path: DOCKER_DESKTOP,
      source: "default",
    });
    assert.deepStrictEqual(resolveSocket({}, probe([PODMAN_USER])), {
      path: PODMAN_USER,
      source: "default",
    });
  });

  it("uses XDG_RUNTIME_DIR for the podman socket", () => {
    const resolved = resolveSocket(
      { XDG_RUNTIME_DIR: "/run/user/1000" },
      probe(["/run/user/1000/podman/podman.sock"]),
    );
    assert.deepStrictEqual(resolved, {
      path: "/run/user/1000/podman/podman.sock",
      source: "default",
    });
  });

  it("falls back to /run/user/<uid> when XDG_RUNTIME_DIR is unset or empty", () => {
    const expected = {
      path: PODMAN_USER,
      source: "default" as const,
    };
    assert.deepStrictEqual(resolveSocket({}, probe([PODMAN_USER])), expected);
    assert.deepStrictEqual(
      resolveSocket({ XDG_RUNTIME_DIR: "" }, probe([PODMAN_USER])),
      expected,
    );
  });

  it("lists every path it tried when nothing is found", () => {
    const error = catchError(() => resolveSocket({}, probe([])));
    assert.ok(error instanceof RuntimeUnavailableError);
    assert.equal(
      error.message,
      `no container engine socket found; tried ${DOCKER_SOCKET}, ${DOCKER_DESKTOP}, ${PODMAN_USER}; set PAAS_SOCKET`,
    );
  });
});

describe("nodeSocketProbe", () => {
  it("exposes a filesystem probe, the home directory and a numeric uid", () => {
    assert.equal(typeof nodeSocketProbe.exists, "function");
    assert.equal(typeof nodeSocketProbe.homedir, "string");
    assert.equal(typeof nodeSocketProbe.uid, "number");
  });
});
