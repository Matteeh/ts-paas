# Integration testing against Docker and Podman

`pnpm verify` never talks to a real container engine. It runs the adapter against a stubbed client and the rest of paas against an in-memory fake. The integration tier is where `DockerRuntime` meets a real engine. It runs the same contract suite as the fake ([`tests/support/runtime-contract.ts`](../tests/support/runtime-contract.ts)) against whichever engine paas finds.

Run it after any change to `src/runtime/docker.ts`, `src/runtime/socket.ts`, `src/runtime/docker-logs.ts` or the contract suite, and on every engine you care about.

## What it does

`pnpm test:integration` runs every `tests/integration/*.itest.ts` file. The `.itest.ts` suffix keeps these files out of `pnpm verify`, which only runs `*.test.ts`.

- Without `PAAS_INTEGRATION=1`, the file registers one skipped test and exits 0. This is safe on any machine.
- With `PAAS_INTEGRATION=1`, it:
  - resolves the engine socket the same way the `paas` CLI does;
  - pulls `registry.k8s.io/pause:3.10` (about 300 KB, multi-arch, runs until stopped, writes no logs);
  - tries to pull the missing image `docker.io/library/paas-contract-missing-image:0`, and expects the pull to fail;
  - creates, starts, stops and removes containers named `contract-<engine>-...`, plus one network and one volume.

Everything it creates carries the label `paas.test=true` and is removed after every test, even when the test fails. The pulled `pause` image is the only thing left behind.

The run needs network access to `registry.k8s.io` and Docker Hub. It takes about 10 seconds once the image is cached.

## Ingress test

`tests/integration/ingress.itest.ts` is a second `.itest.ts` file, so `pnpm test:integration` runs it alongside the runtime contract. Without `PAAS_INTEGRATION=1` it registers one skipped test, exactly like the contract file.

With `PAAS_INTEGRATION=1` it brings up a real Caddy and routes a real app through it:

- It pulls `docker.io/library/caddy:2` and `docker.io/traefik/whoami:v1.11.0`.
- It binds host port 18080 to Caddy's HTTP port 80 and host port 18443 to its HTTPS port 443, and publishes Caddy's admin port as 12019 on `127.0.0.1` only.
- It uses its own container `paas-test-caddy`, volume `paas-test-caddy-data` and admin port, so it leaves a real `paas-caddy` alone. Everything it creates carries `paas.test=ingress`, and only that is removed afterwards, even when the test fails, so it can run in parallel with the contract suite, which uses `paas.test=true`.
- It deploys `whoami` with the hostname `whoami.localhost`, requests it on the host port with that `Host` header and expects a 200 whose body contains `Hostname: `, then checks that `Host: other.localhost` is not routed to it.

On Podman 3.4, a 502 from that request means containers on `paas-net` cannot resolve each other by name: that Podman's CNI networks need the `dnsname` plugin (Ubuntu package `golang-github-containernetworking-plugin-dnsname`). Install it, remove `paas-net`, and run again.

## Before you run it

1. Install dependencies: `pnpm install`.
2. Start an engine (see below) and check that paas finds it:

   ```sh
   pnpm exec tsx src/cli.ts doctor
   ```

   Expected output, for example:

   ```text
   socket:   /var/run/docker.sock
   engine:   docker 24.0.7
   api:      1.43
   paas-net: missing
   ```

   `doctor` only reads: it never creates `paas-net` or touches the state database. If it exits 1, fix that first. The error names the socket it tried.

## Which engine paas talks to

The first match wins:

1. `PAAS_SOCKET`
2. `DOCKER_HOST`, only when it is a `unix://` value. Other schemes such as `tcp://` are ignored.
3. `PODMAN_SOCKET`
4. The first of these default paths that exists:
   - `/var/run/docker.sock`
   - `~/.docker/run/docker.sock`
   - `$XDG_RUNTIME_DIR/podman/podman.sock`, or `/run/user/<uid>/podman/podman.sock` when `XDG_RUNTIME_DIR` is unset

The first three are explicit settings. If one of them is set but its path does not exist, paas fails with `cannot reach container engine at <path>: socket not found`. It does not fall back to the default paths.

To target one engine when several are running, set `PAAS_SOCKET`:

```sh
PAAS_SOCKET=/var/run/docker.sock PAAS_INTEGRATION=1 pnpm test:integration
PAAS_SOCKET=$XDG_RUNTIME_DIR/podman/podman.sock PAAS_INTEGRATION=1 pnpm test:integration
```

The suite name shows which socket it used: `container runtime contract: docker (/var/run/docker.sock)`.

## Docker

### Linux

Install Docker Engine and add yourself to the `docker` group (`sudo usermod -aG docker $USER`, then log in again). If you skip the group, the error names `EACCES` on `/var/run/docker.sock`.

### Windows with WSL 2 (Docker Desktop)

1. Start Docker Desktop.
2. Under Settings → Resources → WSL Integration, enable your distro.
3. In the distro, check that `/var/run/docker.sock` exists and that `docker version` shows a server.

Docker Desktop adds a label of its own (`desktop.docker.io/wsl-distro=<distro>`) to every container. The contract suite tolerates extra labels, so this is expected.

### Run

```sh
PAAS_INTEGRATION=1 pnpm test:integration
```

## Rootless Podman

paas talks to Podman through its Docker-compatible API socket.

### Linux, or Podman installed inside WSL (recommended)

This is the setup the project targets: rootless Podman on Linux.

1. On WSL only, enable systemd once. Add this to `/etc/wsl.conf`:

   ```ini
   [boot]
   systemd=true
   ```

   Then run `wsl --shutdown` from Windows and reopen the distro.
2. Install Podman and start its user socket:

   ```sh
   sudo apt install podman            # Ubuntu 22.04 ships Podman 3.4; 24.04 ships 4.9
   systemctl --user enable --now podman.socket
   ls $XDG_RUNTIME_DIR/podman/podman.sock
   ```

3. If Docker is also running, `/var/run/docker.sock` wins the default order, so point paas at Podman explicitly:

   ```sh
   export PAAS_SOCKET=$XDG_RUNTIME_DIR/podman/podman.sock
   pnpm exec tsx src/cli.ts doctor    # engine: podman <version>
   PAAS_INTEGRATION=1 pnpm test:integration
   ```

### Podman for Windows (Podman machine)

**Not usable from inside WSL so far; prefer Podman installed inside WSL (above).** Podman for Windows runs the engine in its own WSL distro, `podman-machine-default`, not in yours. It offers the Docker-compatible API only on the Windows side:

- a named pipe, `\\.\pipe\podman-machine-default`;
- a Windows AF_UNIX socket under `%LOCALAPPDATA%\Temp\podman\`.

`podman.exe machine inspect` shows both paths. A WSL 2 distro cannot connect to either. That fits running paas as a Windows program, not paas inside WSL.

Observed on 2026-09-24 with Podman 5.8.7:

- After `podman machine init` and `podman machine start`, no socket appeared in another WSL distro (there was no `/mnt/wsl/podman-sockets/`).
- The first start failed with `API forwarding ... not available ... CreateFile \\.\pipe\podman-machine-default: All pipe instances are busy` and `machine did not transition into running state`.
- The recovery to try is `podman machine stop`, `wsl --terminate podman-machine-default`, then `podman machine start`.

If a later Podman version shares a Unix socket with other distros, point `PAAS_SOCKET` at it and record the result below.

## Cleaning up after an interrupted run

Each test cleans up in `finally` and in an `after` hook, but a killed process (Ctrl-C twice, a crash) can leave resources behind. Everything the suite creates is labelled `paas.test=true`:

```sh
docker ps -aq --filter label=paas.test=true | xargs -r docker rm -f
docker network ls -q --filter label=paas.test=true | xargs -r docker network rm
docker volume ls -q --filter label=paas.test=true | xargs -r docker volume rm
```

For Podman, use `podman` instead of `docker`; the flags are the same. Never remove by any other label. `paas.managed=true` also marks your real paas apps.

## Recording results and engine differences

Where Docker and Podman behave differently, the adapter must still behave the same through `ContainerRuntime`. Every known difference is written into the `Docker and Podman differences` requirement in [`openspec/specs/container-runtime/spec.md`](../openspec/specs/container-runtime/spec.md).

When a run fails:

1. Rerun it a few times to see whether the failure is consistent.
2. Reproduce it outside the suite with a short script against `DockerRuntime`, to rule out the test itself.
3. Record it below with the engine, version and date. The fix goes through an osq change that updates the spec, the adapter, and, if needed, the contract suite. Do not special-case an engine silently.

### Known results

| Date | Engine | Setup | Result |
|---|---|---|---|
| 2026-09-24 | Docker Engine 24.0.7, API 1.43 | Docker Desktop, WSL 2 (Ubuntu 22.04) | 11 of 12 pass. `lists exactly the containers carrying every requested label` fails consistently. See below. |
| 2026-09-24 | Podman for Windows 5.8.7 | Podman machine, rootless, reached from Ubuntu 22.04 on WSL 2 | Not run: the machine failed to start (pipe busy), and it offers no socket a WSL distro can use. |
| 2026-09-24 | Podman 3.4.4, API 1.40, rootless | Ubuntu 22.04 package on WSL 2, `podman.socket` user unit | 10 of 12 pass. `pulls a present image and rejects a missing image` and `rejects a duplicate container name` fail consistently. See below. |
| 2026-09-24 | Docker Engine 24.0.7, API 1.43 | Docker Desktop, WSL 2 (Ubuntu 22.04), after change 008 | 12 of 12, three runs. |
| 2026-09-24 | Podman 3.4.4, API 1.40, rootless | Ubuntu 22.04 package on WSL 2, after change 008 | 12 of 12, three runs. |

The three failures below were fixed in change 008 (`adapter-engine-fixes`) and are recorded in the `Docker and Podman differences` requirement.

**Docker: container list lags behind inspect.** Right after `stopContainer` returns, `inspectContainer` reports `exited`, but `listContainers` (Docker's `/containers/json`) can still report `running` for a moment. The list view is eventually consistent. Reproduced outside the suite with `DockerRuntime` directly: stop takes about 400 ms, and the list shows the stale state immediately afterwards. The contract requires list and inspect to agree, so since change 008 the adapter takes each listed container's state from `inspect`. Podman 3.4.4 does not show this lag.

**Podman: a missing image fails inside the pull stream.** Podman answers the pull request itself with success, then reports the failure as an error event in the stream: `requested access to the resource is denied` / `unauthorized: authentication required`. The adapter applies its "image not found" message rules only to HTTP 500 responses, so this becomes a plain `RuntimeError` instead of `ImageNotFoundError`. Since change 008, errors inside the stream go through the same message rules.

**Podman 3.4: a name conflict is a 500, not a 409.** Creating a container with a name in use returns HTTP 500 with `that name is already in use`. The adapter treats only 409 as a name conflict. Since change 008, a create error whose message says the name is already in use is a `NameConflictError`. Whether newer Podman versions return 409 is still unchecked.

**Minor:** the suite used to be labelled `docker (<socket>)` on every engine. Since change 008 it carries the engine name from `ping`, for example `podman (/run/user/1000/podman/podman.sock)`.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `no container engine socket found; tried ...` | No engine is running, or its socket is not at a default path. Start the engine, or set `PAAS_SOCKET`. |
| `cannot reach container engine at <path>: socket not found` | An explicit `PAAS_SOCKET`, `DOCKER_HOST` or `PODMAN_SOCKET` points at a missing path. Explicit settings never fall back. |
| `cannot reach container engine at <path>: EACCES` | No permission on the socket. On Linux, join the `docker` group. For Podman, use the rootless socket under `$XDG_RUNTIME_DIR`. |
| `cannot reach container engine at <path>: ECONNREFUSED` | The socket file exists but the engine behind it is stopped. Restart Docker Desktop, or `systemctl --user restart podman.socket`. |
| Pull fails with a rate-limit message | Docker Hub rate limits anonymous pulls. Only the missing-image check hits Docker Hub. Wait, or `docker login`. |
| Podman refuses an image with a short-name error | Podman requires fully qualified references. The suite already uses them; check any image you added. |
