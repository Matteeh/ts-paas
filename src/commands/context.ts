import type { Command } from "commander";

import type { Clock } from "../clock.js";
import { systemClock } from "../clock.js";
import type { EngineDeps } from "../deployments/types.js";
import { UsageError } from "../errors.js";
import type { Io } from "../output.js";
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
}

/** The error of the default runtime factory until a real adapter exists. */
export const NO_RUNTIME_MESSAGE = "no container runtime is configured yet";

/** The program's runtime factory until `docker-podman-adapter` replaces it. */
export function defaultRuntimeFactory(): ContainerRuntime {
  throw new Error(NO_RUNTIME_MESSAGE);
}

/** The context's clock, or the system clock when none was injected. */
export function contextClock(context: CommandContext): Clock {
  return context.clock ?? systemClock;
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
 * Resolve the runtime factory before opening the store, then run `fn` with
 * the store, the runtime and the context clock as engine dependencies.
 */
export async function withEngine<T>(
  context: CommandContext,
  fn: (deps: EngineDeps) => T | Promise<T>,
): Promise<T> {
  const runtime = (context.runtime ?? defaultRuntimeFactory)();
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
