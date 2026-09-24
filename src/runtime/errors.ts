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
