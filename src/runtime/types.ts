export const MANAGED_LABEL = "paas.managed";

export type RestartPolicy = "no" | "always" | "unless-stopped" | "on-failure";

export interface PublishedPort {
  hostIp: string;
  hostPort: number;
  containerPort: number;
  protocol?: "tcp" | "udp";
}

export interface VolumeMount {
  volume: string;
  path: string;
  readOnly?: boolean;
}

export interface ContainerSpec {
  name: string;
  image: string;
  env?: Record<string, string>;
  labels?: Record<string, string>;
  network?: string;
  internalPort?: number;
  restartPolicy?: RestartPolicy;
  publish?: PublishedPort[];
  volumes?: VolumeMount[];
}

export type ContainerState = "created" | "running" | "exited";

export interface ContainerSummary {
  id: string;
  name: string;
  image: string;
  labels: Record<string, string>;
  state: ContainerState;
}

export interface ContainerInfo extends ContainerSummary {
  exitCode: number | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  restartCount: number;
}

export interface EngineInfo {
  name: string;
  version: string;
  apiVersion?: string;
  endpoint?: string;
}

export interface LogEntry {
  stream: "stdout" | "stderr";
  time: Date;
  text: string;
}

export interface LogOptions {
  tail?: number;
  since?: Date;
}

export interface ContainerRuntime {
  ping(): Promise<EngineInfo>;
  pullImage(ref: string): Promise<void>;
  createContainer(spec: ContainerSpec): Promise<string>;
  startContainer(idOrName: string): Promise<void>;
  stopContainer(idOrName: string, options?: { timeoutSeconds?: number }): Promise<void>;
  removeContainer(idOrName: string, options?: { force?: boolean }): Promise<void>;
  inspectContainer(idOrName: string): Promise<ContainerInfo>;
  listContainers(labels: Record<string, string>): Promise<ContainerSummary[]>;
  containerLogs(idOrName: string, options?: LogOptions): Promise<LogEntry[]>;
  ensureNetwork(name: string): Promise<void>;
  networkExists(name: string): Promise<boolean>;
  ensureVolume(name: string): Promise<void>;
}
