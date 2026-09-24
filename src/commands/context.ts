import type { Command } from "commander";

import { UsageError } from "../errors.js";
import type { Io } from "../output.js";
import { openStore, type Store } from "../state/db.js";
import { ValidationError } from "../state/errors.js";
import { stateDbPath } from "../state/paths.js";

export interface CommandContext {
  io: Io;
  env: NodeJS.ProcessEnv;
}

/**
 * Open the state database the context's environment resolves to, run `fn`,
 * and close the store before returning, whether or not `fn` threw.
 */
export async function withStore<T>(
  context: CommandContext,
  fn: (store: Store) => T | Promise<T>,
): Promise<T> {
  const store = openStore(stateDbPath(context.env));
  try {
    return await fn(store);
  } finally {
    store.close();
  }
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
