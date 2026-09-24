/** Base class for every error the deployments capability raises. */
export class DeployError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class DeploymentInProgressError extends DeployError {
  constructor(app: string, deploymentId: string) {
    super(`app "${app}" already has deployment ${deploymentId} in progress`);
  }
}

export class AppNotRunningError extends DeployError {
  constructor(app: string) {
    super(`app "${app}" has no running deployment`);
  }
}
