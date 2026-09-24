/** Base class for every error the app-state store raises. */
export class StateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Rejected repository input; `field` names the offending field. */
export class ValidationError extends StateError {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.field = field;
  }
}

export class AppNotFoundError extends StateError {
  constructor(name: string) {
    super(`app "${name}" not found`);
  }
}

export class AppExistsError extends StateError {
  constructor(name: string) {
    super(`app "${name}" already exists`);
  }
}

export class HostnameInUseError extends StateError {
  constructor(hostname: string, app: string) {
    super(`hostname "${hostname}" is already used by app "${app}"`);
  }
}

export class AppRunningError extends StateError {
  constructor(name: string) {
    super(`app "${name}" has a running deployment; stop the app first`);
  }
}

export class DeploymentNotFoundError extends StateError {
  constructor(id: string) {
    super(`deployment "${id}" not found`);
  }
}

export class DeploymentFinishedError extends StateError {
  constructor(id: string, status: string) {
    super(`deployment "${id}" is already ${status}`);
  }
}

/** A stored schema is newer than the migrations this build knows. */
export class SchemaTooNewError extends StateError {
  readonly found: number;
  readonly supported: number;

  constructor(found: number, supported: number) {
    super(
      `state database schema version ${found} is newer than this paas supports (${supported}); upgrade paas`,
    );
    this.found = found;
    this.supported = supported;
  }
}
