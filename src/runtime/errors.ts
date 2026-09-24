export class RuntimeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ImageNotFoundError extends RuntimeError {}

export class ContainerNotFoundError extends RuntimeError {}

export class NameConflictError extends RuntimeError {}

export class RuntimeUnavailableError extends RuntimeError {}

export class PortInUseError extends RuntimeError {
  readonly address: string | null;

  constructor(message: string, address: string | null, options?: { cause?: unknown }) {
    super(message, options);
    this.address = address;
  }
}
