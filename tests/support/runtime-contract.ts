import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ContainerNotFoundError,
  ImageNotFoundError,
  NameConflictError,
  RuntimeError,
} from "../../src/runtime/errors.js";
import { MANAGED_LABEL } from "../../src/runtime/types.js";
import type { ContainerRuntime } from "../../src/runtime/types.js";

export interface ContractHarness {
  runtime: ContainerRuntime;
  images: { present: string; missing: string };
  teardown?(): Promise<void>;
}

export function runtimeContract(
  label: string,
  factory: () => Promise<ContractHarness>,
): void {
  describe(`container runtime contract: ${label}`, () => {
    let nameCounter = 0;
    const safeLabel = label.replace(/[^a-zA-Z0-9_.-]/g, "-");
    const nextName = (tag: string): string => {
      nameCounter += 1;
      return `contract-${safeLabel}-${tag}-${nameCounter}`;
    };

    const withHarness = (
      body: (harness: ContractHarness) => Promise<void>,
    ): (() => Promise<void>) => {
      return async () => {
        const harness = await factory();
        try {
          await body(harness);
        } finally {
          await harness.teardown?.();
        }
      };
    };

    it(
      "reports the engine name and version",
      withHarness(async ({ runtime }) => {
        const info = await runtime.ping();
        assert.equal(typeof info.name, "string");
        assert.ok(info.name.length > 0);
        assert.equal(typeof info.version, "string");
        assert.ok(info.version.length > 0);
      }),
    );

    it(
      "pulls a present image and rejects a missing image",
      withHarness(async ({ runtime, images }) => {
        await runtime.pullImage(images.present);
        await assert.rejects(
          runtime.pullImage(images.missing),
          ImageNotFoundError,
        );
      }),
    );

    it(
      "rejects creating a container from an image that was never pulled",
      withHarness(async ({ runtime }) => {
        await assert.rejects(
          runtime.createContainer({
            name: nextName("never-pulled"),
            image: "runtime-contract-never-pulled:1",
          }),
          ImageNotFoundError,
        );
      }),
    );

    it(
      "ensures a network and a volume idempotently",
      withHarness(async ({ runtime }) => {
        const network = nextName("net");
        const volume = nextName("vol");
        await runtime.ensureNetwork(network);
        await runtime.ensureNetwork(network);
        await runtime.ensureVolume(volume);
        await runtime.ensureVolume(volume);
      }),
    );

    it(
      "creates a container that can be inspected by id and by name",
      withHarness(async ({ runtime, images }) => {
        await runtime.pullImage(images.present);
        const name = nextName("inspect");
        const labels = { "paas.app": "web", custom: "yes" };
        const id = await runtime.createContainer({
          name,
          image: images.present,
          labels,
        });
        assert.equal(typeof id, "string");
        assert.ok(id.length > 0);

        const byId = await runtime.inspectContainer(id);
        const byName = await runtime.inspectContainer(name);
        assert.equal(byId.id, id);
        assert.equal(byName.id, id);
        assert.equal(byId.name, name);
        assert.equal(byId.image, images.present);
        assert.equal(byId.state, "created");
        assert.equal(byId.exitCode, null);
        assert.equal(byId.startedAt, null);
        assert.equal(byId.finishedAt, null);
        assert.equal(byId.restartCount, 0);
        assert.deepStrictEqual(byId.labels, {
          ...labels,
          [MANAGED_LABEL]: "true",
        });
      }),
    );

    it(
      "rejects a duplicate container name, even after the first exited",
      withHarness(async ({ runtime, images }) => {
        await runtime.pullImage(images.present);
        const name = nextName("conflict");
        const id = await runtime.createContainer({ name, image: images.present });
        await assert.rejects(
          runtime.createContainer({ name, image: images.present }),
          NameConflictError,
        );
        await runtime.startContainer(id);
        await runtime.stopContainer(id);
        await assert.rejects(
          runtime.createContainer({ name, image: images.present }),
          NameConflictError,
        );
      }),
    );

    it(
      "moves a container through start, idempotent start, stop and idempotent stop",
      withHarness(async ({ runtime, images }) => {
        await runtime.pullImage(images.present);
        const id = await runtime.createContainer({
          name: nextName("lifecycle"),
          image: images.present,
        });

        await runtime.startContainer(id);
        const running = await runtime.inspectContainer(id);
        assert.equal(running.state, "running");
        const startedAt = running.startedAt?.getTime() ?? null;
        assert.notEqual(startedAt, null);

        await runtime.startContainer(id);
        const stillRunning = await runtime.inspectContainer(id);
        assert.equal(stillRunning.state, "running");
        assert.equal(stillRunning.startedAt?.getTime(), startedAt);

        await runtime.stopContainer(id, { timeoutSeconds: 1 });
        const stopped = await runtime.inspectContainer(id);
        assert.equal(stopped.state, "exited");
        assert.equal(typeof stopped.exitCode, "number");
        assert.notEqual(stopped.finishedAt, null);

        await runtime.stopContainer(id, { timeoutSeconds: 1 });
        const stillStopped = await runtime.inspectContainer(id);
        assert.equal(stillStopped.state, "exited");
        assert.equal(stillStopped.exitCode, stopped.exitCode);
      }),
    );

    it(
      "requires force to remove a running container",
      withHarness(async ({ runtime, images }) => {
        await runtime.pullImage(images.present);
        const id = await runtime.createContainer({
          name: nextName("remove"),
          image: images.present,
        });
        await runtime.startContainer(id);

        await assert.rejects(runtime.removeContainer(id), RuntimeError);
        const stillRunning = await runtime.inspectContainer(id);
        assert.equal(stillRunning.state, "running");

        await runtime.removeContainer(id, { force: true });
        await assert.rejects(
          runtime.inspectContainer(id),
          ContainerNotFoundError,
        );

        const stoppedId = await runtime.createContainer({
          name: nextName("remove-stopped"),
          image: images.present,
        });
        await runtime.removeContainer(stoppedId);
        await assert.rejects(
          runtime.inspectContainer(stoppedId),
          ContainerNotFoundError,
        );
      }),
    );

    it(
      "reports unknown containers as not found",
      withHarness(async ({ runtime }) => {
        const unknown = nextName("unknown");
        await assert.rejects(
          runtime.startContainer(unknown),
          ContainerNotFoundError,
        );
        await assert.rejects(
          runtime.stopContainer(unknown),
          ContainerNotFoundError,
        );
        await assert.rejects(
          runtime.removeContainer(unknown),
          ContainerNotFoundError,
        );
        await assert.rejects(
          runtime.inspectContainer(unknown),
          ContainerNotFoundError,
        );
        await assert.rejects(
          runtime.containerLogs(unknown),
          ContainerNotFoundError,
        );
      }),
    );

    it(
      "lists exactly the containers carrying every requested label",
      withHarness(async ({ runtime, images }) => {
        await runtime.pullImage(images.present);
        const nameA = nextName("list-a");
        const nameB = nextName("list-b");
        const nameC = nextName("list-c");

        await runtime.createContainer({
          name: nameA,
          image: images.present,
          labels: { x: "1", y: "1" },
        });
        await runtime.createContainer({
          name: nameB,
          image: images.present,
          labels: { x: "1" },
        });
        const idC = await runtime.createContainer({
          name: nameC,
          image: images.present,
          labels: { x: "1", y: "1" },
        });
        await runtime.startContainer(idC);
        await runtime.stopContainer(idC);

        const listed = await runtime.listContainers({ x: "1", y: "1" });
        const names = listed.map((container) => container.name).sort();
        assert.deepStrictEqual(names, [nameA, nameC].sort());
        const a = listed.find((container) => container.name === nameA);
        assert.equal(a?.state, "created");
        const c = listed.find((container) => container.name === nameC);
        assert.equal(c?.state, "exited");
      }),
    );

    it(
      "returns logs oldest first and honors tail and since",
      withHarness(async ({ runtime, images }) => {
        await runtime.pullImage(images.present);
        const id = await runtime.createContainer({
          name: nextName("logs"),
          image: images.present,
        });
        await runtime.startContainer(id);

        const logs = await runtime.containerLogs(id);
        for (let index = 1; index < logs.length; index += 1) {
          const previous = logs[index - 1] as {
            time: Date;
          };
          const current = logs[index] as { time: Date };
          assert.ok(previous.time.getTime() <= current.time.getTime());
        }

        const tailed = await runtime.containerLogs(id, { tail: 1 });
        assert.deepStrictEqual(tailed, logs.slice(-1));

        const newestTime =
          logs.length > 0
            ? (logs[logs.length - 1] as { time: Date }).time.getTime()
            : Date.now();
        const none = await runtime.containerLogs(id, {
          since: new Date(newestTime + 3_600_000),
        });
        assert.equal(none.length, 0);
      }),
    );
  });
}
