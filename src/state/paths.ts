import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The directory paas keeps its state in. `$PAAS_HOME` wins when set and
 * non-empty; otherwise `~/.paas`.
 */
export function paasHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.PAAS_HOME;
  if (home !== undefined && home !== "") {
    return home;
  }
  return join(homedir(), ".paas");
}

/** The full path of the state database: `<paasHome>/state.db`. */
export function stateDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(paasHome(env), "state.db");
}
