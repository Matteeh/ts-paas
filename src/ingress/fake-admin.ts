import type { CaddyAdmin } from "./admin.js";
import type { CaddyConfig } from "./config.js";

/** In-memory `CaddyAdmin` for tests. */
export class FakeCaddyAdmin implements CaddyAdmin {
  readonly loads: CaddyConfig[] = [];
  failures: Error[] = [];
  onLoad?: (config: CaddyConfig) => void | Promise<void>;
  private current: unknown = null;

  async load(config: CaddyConfig): Promise<void> {
    const failure = this.failures.shift();
    if (failure !== undefined) {
      throw failure;
    }
    await this.onLoad?.(config);
    this.loads.push(config);
    this.current = config;
  }

  async getConfig(): Promise<unknown> {
    return this.current;
  }
}
