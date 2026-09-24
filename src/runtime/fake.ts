import { systemClock } from "../clock.js";
import type { Clock } from "../clock.js";
import {
  ContainerNotFoundError,
  ImageNotFoundError,
  NameConflictError,
  RuntimeError,
  RuntimeUnavailableError,
} from "./errors.js";
import { MANAGED_LABEL } from "./types.js";
import type {
  ContainerInfo,
  ContainerRuntime,
  ContainerSpec,
  ContainerState,
  ContainerSummary,
  EngineInfo,
  LogEntry,
  LogOptions,
} from "./types.js";

export interface FakeImageScript {
  exitCode?: number;
  exitAfterMs?: number;
  logs?: { stream: "stdout" | "stderr"; text: string }[];
}

export interface FakeRuntimeOptions {
  clock?: Clock;
  pullFailures?: string[];
  scripts?: Record<string, FakeImageScript>;
}

interface StoredContainer {
  id: string;
  name: string;
  image: string;
  labels: Record<string, string>;
  state: ContainerState;
  exitCode: number | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  restartCount: number;
  runToken: number;
  logs: LogEntry[];
}

export class FakeRuntime implements ContainerRuntime {
  unavailable = false;

  private readonly clock: Clock;
  private readonly pullFailures: Set<string>;
  private readonly scripts: Record<string, FakeImageScript>;
  private readonly pulled = new Set<string>();
  private readonly containers = new Map<string, StoredContainer>();
  private readonly networks = new Set<string>();
  private readonly volumes = new Set<string>();
  private nextId = 0;

  constructor(options: FakeRuntimeOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.pullFailures = new Set(options.pullFailures ?? []);
    this.scripts = options.scripts ?? {};
  }

  private check(): void {
    if (this.unavailable) {
      throw new RuntimeUnavailableError("runtime is unavailable");
    }
  }

  private find(idOrName: string): StoredContainer {
    const byId = this.containers.get(idOrName);
    if (byId !== undefined) {
      return byId;
    }
    for (const container of this.containers.values()) {
      if (container.name === idOrName) {
        return container;
      }
    }
    throw new ContainerNotFoundError(`container not found: ${idOrName}`);
  }

  async ping(): Promise<EngineInfo> {
    this.check();
    return { name: "fake", version: "0.0.0" };
  }

  async pullImage(ref: string): Promise<void> {
    this.check();
    if (this.pullFailures.has(ref)) {
      throw new ImageNotFoundError(`image not found: ${ref}`);
    }
    this.pulled.add(ref);
  }

  async createContainer(spec: ContainerSpec): Promise<string> {
    this.check();
    if (!this.pulled.has(spec.image)) {
      throw new ImageNotFoundError(`image not found: ${spec.image}`);
    }
    for (const container of this.containers.values()) {
      if (container.name === spec.name) {
        throw new NameConflictError(`container name already in use: ${spec.name}`);
      }
    }
    this.nextId += 1;
    const id = `fake-${this.nextId}`;
    this.containers.set(id, {
      id,
      name: spec.name,
      image: spec.image,
      labels: { ...spec.labels, [MANAGED_LABEL]: "true" },
      state: "created",
      exitCode: null,
      startedAt: null,
      finishedAt: null,
      restartCount: 0,
      runToken: 0,
      logs: [],
    });
    return id;
  }

  async startContainer(idOrName: string): Promise<void> {
    this.check();
    const container = this.find(idOrName);
    if (container.state === "running") {
      return;
    }
    container.state = "running";
    container.exitCode = null;
    container.finishedAt = null;
    container.startedAt = this.clock.now();
    container.runToken += 1;
    const token = container.runToken;

    const script = this.scripts[container.image];
    if (script?.logs !== undefined) {
      for (const line of script.logs) {
        container.logs.push({
          stream: line.stream,
          time: this.clock.now(),
          text: line.text,
        });
      }
    }

    if (script?.exitCode !== undefined) {
      const exitCode = script.exitCode;
      const delay = script.exitAfterMs;
      if (delay !== undefined && delay > 0) {
        void this.clock.sleep(delay).then(() => {
          if (container.state === "running" && container.runToken === token) {
            container.state = "exited";
            container.exitCode = exitCode;
            container.finishedAt = this.clock.now();
          }
        });
      } else {
        container.state = "exited";
        container.exitCode = exitCode;
        container.finishedAt = this.clock.now();
      }
    }
  }

  async stopContainer(
    idOrName: string,
    _options?: { timeoutSeconds?: number },
  ): Promise<void> {
    this.check();
    const container = this.find(idOrName);
    if (container.state !== "running") {
      return;
    }
    container.state = "exited";
    container.exitCode = 0;
    container.finishedAt = this.clock.now();
  }

  async removeContainer(
    idOrName: string,
    options?: { force?: boolean },
  ): Promise<void> {
    this.check();
    const container = this.find(idOrName);
    if (container.state === "running" && options?.force !== true) {
      throw new RuntimeError(
        `container is running, use force to remove: ${container.id}`,
      );
    }
    this.containers.delete(container.id);
  }

  async inspectContainer(idOrName: string): Promise<ContainerInfo> {
    this.check();
    const container = this.find(idOrName);
    return {
      id: container.id,
      name: container.name,
      image: container.image,
      labels: { ...container.labels },
      state: container.state,
      exitCode: container.exitCode,
      startedAt:
        container.startedAt === null
          ? null
          : new Date(container.startedAt.getTime()),
      finishedAt:
        container.finishedAt === null
          ? null
          : new Date(container.finishedAt.getTime()),
      restartCount: container.restartCount,
    };
  }

  async listContainers(
    labels: Record<string, string>,
  ): Promise<ContainerSummary[]> {
    this.check();
    const wanted = Object.entries(labels);
    const result: ContainerSummary[] = [];
    for (const container of this.containers.values()) {
      if (wanted.every(([key, value]) => container.labels[key] === value)) {
        result.push({
          id: container.id,
          name: container.name,
          image: container.image,
          labels: { ...container.labels },
          state: container.state,
        });
      }
    }
    return result;
  }

  async containerLogs(
    idOrName: string,
    options: LogOptions = {},
  ): Promise<LogEntry[]> {
    this.check();
    const container = this.find(idOrName);
    let entries = container.logs;
    if (options.since !== undefined) {
      const since = options.since.getTime();
      entries = entries.filter((entry) => entry.time.getTime() >= since);
    }
    if (options.tail !== undefined) {
      entries = options.tail <= 0 ? [] : entries.slice(-options.tail);
    }
    return entries.map((entry) => ({
      stream: entry.stream,
      time: new Date(entry.time.getTime()),
      text: entry.text,
    }));
  }

  async ensureNetwork(name: string): Promise<void> {
    this.check();
    this.networks.add(name);
  }

  async ensureVolume(name: string): Promise<void> {
    this.check();
    this.volumes.add(name);
  }
}
