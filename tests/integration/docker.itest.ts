import { after, test } from "node:test";

import { DockerRuntime } from "../../src/runtime/docker.js";
import { resolveSocket } from "../../src/runtime/socket.js";
import { engineLabel, runtimeContract } from "../support/runtime-contract.js";

if (process.env.PAAS_INTEGRATION !== "1") {
  test(
    "docker integration",
    { skip: "set PAAS_INTEGRATION=1 to run" },
    () => {},
  );
} else {
  const socketPath = resolveSocket(process.env).path;
  const runtime = new DockerRuntime({
    socketPath,
    labels: { "paas.test": "true" },
  });

  after(async () => {
    await runtime.removeLabelled({ "paas.test": "true" });
  });

  const info = await runtime.ping();

  runtimeContract(engineLabel(info), async () => ({
    runtime,
    images: {
      present: "registry.k8s.io/pause:3.10",
      missing: "docker.io/library/paas-contract-missing-image:0",
    },
    teardown: async () => {
      await runtime.removeLabelled({ "paas.test": "true" });
    },
  }));
}
