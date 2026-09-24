import Docker from "dockerode";

import { demuxDockerLogs, filterLogs } from "./docker-logs.js";
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

export interface DockerRuntimeOptions {
  socketPath: string;
  /** The engine client; tests inject a stub. Never connects in the constructor. */
  client?: Docker;
  /** Added to every container, network and volume this runtime creates. */
  labels?: Record<string, string>;
}

interface DockerError extends Error {
  statusCode?: number;
  code?: string;
  json?: { message?: string };
}

interface PullEvent {
  error?: unknown;
  errorDetail?: { message?: string } | unknown;
}

type ErrorKind = "pull" | "create" | "container";

const ZERO_TIME = "0001-01-01T00:00:00Z";

function isStatus(error: unknown, status: number): boolean {
  return (error as DockerError).statusCode === status;
}

function isPodmanMissingImage(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("manifest unknown") ||
    lower.includes("does not exist") ||
    lower.includes("access denied") ||
    lower.includes("access to the resource is denied")
  );
}

function engineMessage(error: unknown): string {
  const shaped = error as DockerError;
  return shaped.json?.message ?? shaped.message ?? String(error);
}

function pullEventMessage(event: PullEvent): string {
  if (event.errorDetail !== undefined && event.errorDetail !== null) {
    const detail = event.errorDetail as { message?: unknown };
    if (typeof detail.message === "string") {
      return detail.message;
    }
  }
  if (event.error instanceof Error) {
    return event.error.message;
  }
  if (typeof event.error === "string") {
    return event.error;
  }
  return "image pull failed";
}

function mapState(status: string): ContainerState {
  switch (status) {
    case "created":
      return "created";
    case "running":
    case "restarting":
    case "paused":
      return "running";
    default:
      return "exited";
  }
}

function parseTime(value: string | undefined): Date | null {
  if (value === undefined || value === ZERO_TIME) {
    return null;
  }
  return new Date(value);
}

function toContainerInfo(info: Docker.ContainerInspectInfo): ContainerInfo {
  const state = mapState(info.State.Status);
  return {
    id: info.Id,
    name: info.Name.replace(/^\//, ""),
    image: info.Config.Image,
    labels: info.Config.Labels ?? {},
    state,
    exitCode: state === "exited" ? info.State.ExitCode : null,
    startedAt: parseTime(info.State.StartedAt),
    finishedAt: parseTime(info.State.FinishedAt),
    restartCount: info.RestartCount,
  };
}

function toContainerSummary(
  info: Docker.ContainerInfo,
  state: ContainerState,
): ContainerSummary {
  return {
    id: info.Id,
    name: (info.Names[0] ?? "").replace(/^\//, ""),
    image: info.Image,
    labels: info.Labels ?? {},
    state,
  };
}

function labelFilters(labels: Record<string, string>): { label: string[] } {
  return {
    label: Object.entries(labels).map(([key, value]) => `${key}=${value}`),
  };
}

/**
 * The Docker Engine adapter. It talks to Docker Engine and to Podman's
 * Docker-compatible API through dockerode over a Unix socket. This is the
 * only module that imports dockerode; constructing it does not connect.
 */
export class DockerRuntime implements ContainerRuntime {
  readonly socketPath: string;

  private readonly client: Docker;
  private readonly labels: Record<string, string>;

  constructor(options: DockerRuntimeOptions) {
    this.socketPath = options.socketPath;
    this.client =
      options.client ?? new Docker({ socketPath: options.socketPath });
    this.labels = options.labels ?? {};
  }

  private mapPullMessage(message: string, cause: unknown): RuntimeError {
    if (isPodmanMissingImage(message)) {
      return new ImageNotFoundError(message, { cause });
    }
    return new RuntimeError(message, { cause });
  }

  private mapError(error: unknown, kind: ErrorKind): RuntimeError {
    if (error instanceof RuntimeError) {
      return error;
    }
    const shaped = error as DockerError;
    if (shaped.statusCode === undefined && typeof shaped.code === "string") {
      return new RuntimeUnavailableError(
        `cannot reach container engine at ${this.socketPath}: ${shaped.code}`,
        { cause: error },
      );
    }
    const message = engineMessage(error);
    if (shaped.statusCode === 404) {
      if (kind === "container") {
        return new ContainerNotFoundError(message, { cause: error });
      }
      return new ImageNotFoundError(message, { cause: error });
    }
    if (kind === "create" && shaped.statusCode === 409) {
      return new NameConflictError(message, { cause: error });
    }
    if (
      kind === "create" &&
      shaped.statusCode === 500 &&
      message.toLowerCase().includes("already in use")
    ) {
      return new NameConflictError(message, { cause: error });
    }
    if (kind === "pull" && shaped.statusCode === 500) {
      return this.mapPullMessage(message, error);
    }
    return new RuntimeError(message, { cause: error });
  }

  async ping(): Promise<EngineInfo> {
    try {
      const version = await this.client.version();
      const components = version.Components ?? [];
      const isPodman = components.some(
        (component) => component.Name === "Podman Engine",
      );
      return {
        name: isPodman ? "podman" : "docker",
        version: version.Version,
        apiVersion: version.ApiVersion,
        endpoint: this.socketPath,
      };
    } catch (error) {
      throw this.mapError(error, "container");
    }
  }

  async pullImage(ref: string): Promise<void> {
    try {
      const stream = await this.client.pull(ref);
      await new Promise<void>((resolve, reject) => {
        this.client.modem.followProgress(
          stream,
          (error: unknown, output: PullEvent[]) => {
            if (error) {
              reject(error);
              return;
            }
            const failed = (output ?? []).find(
              (event) =>
                event.error !== undefined || event.errorDetail !== undefined,
            );
            if (failed !== undefined) {
              reject(
                this.mapPullMessage(pullEventMessage(failed), failed),
              );
              return;
            }
            resolve();
          },
        );
      });
    } catch (error) {
      throw this.mapError(error, "pull");
    }
  }

  private createBody(spec: ContainerSpec): Docker.ContainerCreateOptions {
    const labels: Record<string, string> = {
      ...spec.labels,
      ...this.labels,
      [MANAGED_LABEL]: "true",
    };
    const body: Docker.ContainerCreateOptions = {
      name: spec.name,
      Image: spec.image,
      Labels: labels,
    };

    if (spec.env !== undefined && Object.keys(spec.env).length > 0) {
      body.Env = Object.entries(spec.env).map(([key, value]) => `${key}=${value}`);
    }

    const exposed: NonNullable<
      Docker.ContainerCreateOptions["ExposedPorts"]
    > = {};
    if (spec.internalPort !== undefined) {
      exposed[`${spec.internalPort}/tcp`] = {};
    }
    for (const port of spec.publish ?? []) {
      exposed[`${port.containerPort}/${port.protocol ?? "tcp"}`] = {};
    }
    if (Object.keys(exposed).length > 0) {
      body.ExposedPorts = exposed;
    }

    const hostConfig: Docker.HostConfig = {};
    if (spec.restartPolicy !== undefined) {
      hostConfig.RestartPolicy = { Name: spec.restartPolicy };
    }
    if (spec.publish !== undefined && spec.publish.length > 0) {
      const bindings: Record<
        string,
        Array<{ HostIp: string; HostPort: string }>
      > = {};
      for (const port of spec.publish) {
        bindings[`${port.containerPort}/${port.protocol ?? "tcp"}`] = [
          { HostIp: port.hostIp, HostPort: String(port.hostPort) },
        ];
      }
      hostConfig.PortBindings = bindings;
    }
    if (spec.volumes !== undefined && spec.volumes.length > 0) {
      hostConfig.Binds = spec.volumes.map((mount) =>
        mount.readOnly === true
          ? `${mount.volume}:${mount.path}:ro`
          : `${mount.volume}:${mount.path}`,
      );
    }
    if (spec.network !== undefined) {
      hostConfig.NetworkMode = spec.network;
    }
    if (Object.keys(hostConfig).length > 0) {
      body.HostConfig = hostConfig;
    }
    return body;
  }

  async createContainer(spec: ContainerSpec): Promise<string> {
    try {
      const container = await this.client.createContainer(this.createBody(spec));
      return container.id;
    } catch (error) {
      throw this.mapError(error, "create");
    }
  }

  async startContainer(idOrName: string): Promise<void> {
    try {
      await this.client.getContainer(idOrName).start();
    } catch (error) {
      if (isStatus(error, 304)) {
        return;
      }
      throw this.mapError(error, "container");
    }
  }

  async stopContainer(
    idOrName: string,
    options?: { timeoutSeconds?: number },
  ): Promise<void> {
    const stopOptions =
      options?.timeoutSeconds !== undefined ? { t: options.timeoutSeconds } : {};
    try {
      await this.client.getContainer(idOrName).stop(stopOptions);
    } catch (error) {
      if (isStatus(error, 304)) {
        return;
      }
      throw this.mapError(error, "container");
    }
  }

  async removeContainer(
    idOrName: string,
    options?: { force?: boolean },
  ): Promise<void> {
    try {
      await this.client
        .getContainer(idOrName)
        .remove({ force: options?.force === true });
    } catch (error) {
      throw this.mapError(error, "container");
    }
  }

  async inspectContainer(idOrName: string): Promise<ContainerInfo> {
    try {
      const info = await this.client.getContainer(idOrName).inspect();
      return toContainerInfo(info);
    } catch (error) {
      throw this.mapError(error, "container");
    }
  }

  async listContainers(
    labels: Record<string, string>,
  ): Promise<ContainerSummary[]> {
    try {
      const infos = await this.client.listContainers({
        all: true,
        filters: labelFilters(labels),
      });
      const summaries: ContainerSummary[] = [];
      for (const info of infos) {
        let inspected: Docker.ContainerInspectInfo;
        try {
          inspected = await this.client.getContainer(info.Id).inspect();
        } catch (error) {
          if (isStatus(error, 404)) {
            continue;
          }
          throw this.mapError(error, "container");
        }
        summaries.push(
          toContainerSummary(info, mapState(inspected.State.Status)),
        );
      }
      return summaries;
    } catch (error) {
      throw this.mapError(error, "container");
    }
  }

  async containerLogs(
    idOrName: string,
    options: LogOptions = {},
  ): Promise<LogEntry[]> {
    try {
      const container = this.client.getContainer(idOrName);
      const info = await container.inspect();
      const tty = info.Config.Tty === true;
      const logOptions: Docker.ContainerLogsOptions = {
        follow: false,
        stdout: true,
        stderr: true,
        timestamps: true,
      };
      if (options.since !== undefined) {
        logOptions.since = Math.floor(options.since.getTime() / 1000);
      } else {
        logOptions.tail = (options.tail ?? "all") as number;
      }
      const data = await container.logs(
        logOptions as Docker.ContainerLogsOptions & { follow?: false },
      );
      const entries = demuxDockerLogs(data, { tty });
      return filterLogs(entries, options);
    } catch (error) {
      throw this.mapError(error, "container");
    }
  }

  async ensureNetwork(name: string): Promise<void> {
    try {
      try {
        await this.client.getNetwork(name).inspect();
        return;
      } catch (error) {
        if (!isStatus(error, 404)) {
          throw error;
        }
      }
      try {
        await this.client.createNetwork({
          Name: name,
          Driver: "bridge",
          Labels: { ...this.labels },
        });
      } catch (error) {
        if (isStatus(error, 409)) {
          return;
        }
        throw error;
      }
    } catch (error) {
      throw this.mapError(error, "container");
    }
  }

  async networkExists(name: string): Promise<boolean> {
    try {
      await this.client.getNetwork(name).inspect();
      return true;
    } catch (error) {
      if (isStatus(error, 404)) {
        return false;
      }
      throw this.mapError(error, "container");
    }
  }

  async ensureVolume(name: string): Promise<void> {
    try {
      try {
        await this.client.getVolume(name).inspect();
        return;
      } catch (error) {
        if (!isStatus(error, 404)) {
          throw error;
        }
      }
      try {
        await this.client.createVolume({
          Name: name,
          Labels: { ...this.labels },
        });
      } catch (error) {
        if (isStatus(error, 409)) {
          return;
        }
        throw error;
      }
    } catch (error) {
      throw this.mapError(error, "container");
    }
  }

  async removeLabelled(labels: Record<string, string>): Promise<void> {
    const filters = labelFilters(labels);
    let containers: Docker.ContainerInfo[];
    try {
      containers = await this.client.listContainers({ all: true, filters });
    } catch (error) {
      throw this.mapError(error, "container");
    }
    for (const container of containers) {
      try {
        await this.client.getContainer(container.Id).remove({ force: true });
      } catch (error) {
        if (!isStatus(error, 404)) {
          throw this.mapError(error, "container");
        }
      }
    }

    let networks: Docker.NetworkInspectInfo[];
    try {
      networks = await this.client.listNetworks({ filters });
    } catch (error) {
      throw this.mapError(error, "container");
    }
    for (const network of networks) {
      try {
        await this.client.getNetwork(network.Name).remove();
      } catch (error) {
        if (!isStatus(error, 404)) {
          throw this.mapError(error, "container");
        }
      }
    }

    let volumes: { Volumes: Docker.VolumeInspectInfo[]; Warnings: string[] };
    try {
      volumes = await this.client.listVolumes({ filters });
    } catch (error) {
      throw this.mapError(error, "container");
    }
    for (const volume of volumes.Volumes ?? []) {
      try {
        await this.client.getVolume(volume.Name).remove();
      } catch (error) {
        if (!isStatus(error, 404)) {
          throw this.mapError(error, "container");
        }
      }
    }
  }
}
