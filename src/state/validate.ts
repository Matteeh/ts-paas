import { ValidationError } from "./errors.js";

const APP_NAME = /^[a-z][a-z0-9-]{0,39}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HOST_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;

/** 1 to 40 lowercase letters, digits and hyphens, starting with a letter. */
export function validateAppName(name: string): string {
  if (typeof name !== "string" || !APP_NAME.test(name)) {
    throw new ValidationError("name", `invalid app name "${name}"`);
  }
  return name;
}

/** A non-empty image reference containing no whitespace. */
export function validateImage(image: string): string {
  if (typeof image !== "string" || image.length === 0 || /\s/.test(image)) {
    throw new ValidationError("image", `invalid image reference "${image}"`);
  }
  return image;
}

/** An integer from 1 to 65535. */
export function validatePort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ValidationError("port", `invalid port ${port}`);
  }
  return port;
}

/** A valid DNS name, returned lowercased. */
export function validateHostname(hostname: string): string {
  if (
    typeof hostname !== "string" ||
    hostname.length === 0 ||
    hostname.length > 253
  ) {
    throw new ValidationError("hostname", `invalid hostname "${hostname}"`);
  }

  const lower = hostname.toLowerCase();
  for (const label of lower.split(".")) {
    if (label.length === 0 || label.length > 63 || !HOST_LABEL.test(label)) {
      throw new ValidationError("hostname", `invalid hostname "${hostname}"`);
    }
  }
  return lower;
}

/** Env keys are identifiers; values are any string. */
export function validateEnv(env: Record<string, string>): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!ENV_KEY.test(key)) {
      throw new ValidationError("env", `invalid environment key "${key}"`);
    }
    if (typeof value !== "string") {
      throw new ValidationError("env", `invalid environment value for "${key}"`);
    }
    parsed[key] = value;
  }
  return parsed;
}
