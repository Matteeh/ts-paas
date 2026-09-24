import type { Command } from "commander";

import type { Clock } from "../clock.js";
import { systemClock } from "../clock.js";
import type { EngineDeps } from "../deployments/types.js";
import { UsageError } from "../errors.js";
import type { CaddyAdmin } from "../ingress/admin.js";
import { DEFAULT_ADMIN_URL, HttpCaddyAdmin } from "../ingress/admin.js";
import type { Io } from "../output.js";
import { DockerRuntime } from "../runtime/docker.js";
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
    throw error;
  }
}
