import { readFileSync } from "node:fs";

export function packageVersion(): string {
  const packageJsonUrl = new URL("../package.json", import.meta.url);
  const packageJson = JSON.parse(readFileSync(packageJsonUrl, "utf8")) as {
    version: string;
  };
  return packageJson.version;
}
