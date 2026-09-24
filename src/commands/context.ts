import type { Command } from "commander";

import type { Clock } from "../clock.js";
import { systemClock } from "../clock.js";
import type { EngineDeps } from "../deployments/types.js";
import { UsageError } from "../errors.js";
import type { CaddyAdmin } from "../ingress/admin.js";
import { DEFAULT_ADMIN_URL, HttpCaddyAdmin } from "../ingress/admin.js";
import type { Io } from "../output.js";
import { DockerRuntime } from "../runtime/docker.js";
import { PortInUseError } from "../runtime/errors.js";
import { resolveSocket } from "../runtime/socket.js";
import type { ContainerRuntime } from "../runtime/types.js";
import { openStore, type Store } from "../state/db.js";
import { ValidationError } from "../state/errors.js";
import { stateDbPath } from "../state/paths.js";

export interface CommandContext {
  io: Io;
  env: NodeJS.ProcessEnv;
  /** The container runtime factory; defaults to {@link defaultRuntimeFactory}. */
  runtime?: () => ContainerRuntime;
  /** The clock shared by the store, the runtime and the engine. */
  clock?: Clock;
  /** The Caddy admin factory; defaults to {@link HttpCaddyAdmin} on loopback. */
  admin?: () => CaddyAdmin;
}

/** The default runtime factory: the Docker adapter on the resolved socket. */
export function defaultRuntimeFactory(env: NodeJS.ProcessEnv): ContainerRuntime {
  return new DockerRuntime({ socketPath: resolveSocket(env).path });
}

/** The context's runtime, or {@link defaultRuntimeFactory} when none was injected. */
export function getRuntime(context: CommandContext): ContainerRuntime {
  return context.runtime
    ? context.runtime()
    : defaultRuntimeFactory(context.env);
}

/** The context's clock, or the system clock when none was injected. */
export function contextClock(context: CommandContext): Clock {
  return context.clock ?? systemClock;
}

/** The context's Caddy admin client, or the default loopback one. */
export function getAdmin(context: CommandContext): CaddyAdmin {
  return context.admin
    ? context.admin()
    : new HttpCaddyAdmin(DEFAULT_ADMIN_URL);
}

/**
 * Open the state database the context's environment resolves to, run `fn`,
 * and close the store before returning, whether or not `fn` threw.
 */
export async function withStore<T>(
  context: CommandContext,
  fn: (store: Store) => T | Promise<T>,
): Promise<T> {
  const store = openStore(stateDbPath(context.env), {
    clock: contextClock(context),
  });
  try {
    return await fn(store);
  } finally {
    store.close();
  }
}

/**
 * Resolve and ping the runtime before opening the store, then run `fn` with
 * the store, the runtime and the context clock as engine dependencies. An
 * unreachable engine fails before the store is opened, leaving state alone.
 */
export async function withEngine<T>(
  context: CommandContext,
  fn: (deps: EngineDeps) => T | Promise<T>,
): Promise<T> {
  const runtime = getRuntime(context);
  await runtime.ping();
  return withStore(context, (store) => {
    const deps: EngineDeps = {
      store,
      runtime,
      clock: contextClock(context),
    };
    return fn(deps);
  });
}

const BUSY_PORT_HINT =
  ' (on rootless Podman a leftover containers-rootlessport process can hold it; see docs/manual-testing.md)';

/**
 * The message a command prints when it fails. A busy host port names the
 * address and how to find the process holding it; every other error keeps
 * its own message.
 */
export function explainError(error: unknown): string {
  if (error instanceof PortInUseError) {
    const first = error.message.split("\n", 1)[0];
    const message =
      first === undefined || first === "" ? error.message : first;
    if (error.address === null) {
      return `a host port is already in use (${message}); find what holds it with "ss -ltnp"${BUSY_PORT_HINT}`;
    }
    const port = error.address.slice(error.address.lastIndexOf(":") + 1);
    return `host port ${error.address} is already in use; find what holds it with "ss -ltnp | grep :${port}"${BUSY_PORT_HINT}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Report a usage error through the failing command, then throw. */
export function failUsage(command: Command, message: string): never {
  command.error(`error: ${message}`, { exitCode: 2, code: "paas.usage" });
}

/**
 * Run a command action. Store validation errors and flag parsing errors are
 * usage errors; every other error is rethrown as an operation failure.
 */
export async function runAction(
  command: Command,
  fn: () => void | Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof ValidationError || error instanceof UsageError) {
      failUsage(command, error.message);
    }
    if (error instanceof PortInUseError) {
      throw new Error(explainError(error));
    }
    throw error;
  }
}
