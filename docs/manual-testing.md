# Trying ingress and reconcile on a real engine

`pnpm verify` proves reconcile against the in-memory fake, and `pnpm test:integration` proves the runtime and one routed request against a real engine. Neither breaks a running app on purpose. This guide does: it deploys a real app behind Caddy, breaks it the way a crash, a reboot or a stray `docker` command would, and checks that `paas status` notices and `paas reconcile` repairs it.

It takes about five minutes per engine. Every command and output below was recorded on Docker Engine 24.0.7 and rootless Podman 3.4.4 (WSL 2, Ubuntu 22.04) after change 011. Deployment ids, container ids and times will differ on your machine.

## Before you start

1. Finish "Before you run it" in [integration-testing.md](integration-testing.md#before-you-run-it), so `paas doctor` finds your engine.
2. Work in a shell at the repository root, with a throwaway state directory and the engine you want to test:

   ```sh
   export PAAS_HOME=$(mktemp -d)
   export PAAS_SOCKET=/var/run/docker.sock                  # Docker
   # export PAAS_SOCKET=$XDG_RUNTIME_DIR/podman/podman.sock # rootless Podman
   paas() { pnpm exec tsx src/cli.ts "$@"; }
   ```

   A fresh `PAAS_HOME` keeps your real apps out of it. The shell function runs the CLI from source; with a build you can use `node dist/cli.js` instead.
3. Make sure no `paas-caddy` container exists (`docker ps -a --filter name=paas-caddy`). This guide brings up the real one, with its admin API on `127.0.0.1:2019`.
4. Pick two free host ports. This guide uses 18080 and 18443, because rootless Podman cannot bind ports below 1024 and 8080 is often taken. If a port is in use, `paas ingress up` fails with `Bind for 0.0.0.0:<port> failed: port is already allocated` and leaves `paas-caddy` created but not running; run it again with other ports and it reports `recreated`.

## 1. A healthy app behind Caddy

```console
$ paas ingress up --http-port 18080 --https-port 18443
ingress is up (created): http 18080, https 18443, tls off, routes 0
$ paas apps create whoami --image docker.io/traefik/whoami:v1.11.0 --port 80 --host whoami.localhost
$ paas deploy whoami
...
whoami is running (deployment 8d4f016de041)
$ paas ingress status
caddy:    running
tls:      off
http:     18080
https:    18443
routes:   1
  whoami.localhost -> whoami-8d4f016de041:80
$ curl -s -H "Host: whoami.localhost" http://127.0.0.1:18080/ | head -1
Hostname: 6abcb2db0829
$ paas reconcile
nothing to reconcile
```

Keep the image reference fully qualified: Podman does not resolve short names. Sending the `Host` header avoids depending on how your machine resolves `.localhost`.

**Check:** `curl` prints `Hostname: <container id>`, and reconcile finds nothing to do.

## 2. The container disappears

Simulates `docker rm -f`, or a crash that took the container with it.

```console
$ docker rm -f whoami-8d4f016de041
$ paas status
APP     STATUS   CONTAINER     IMAGE                             UPTIME
whoami  running  6abcb2db0829  docker.io/traefik/whoami:v1.11.0  18s
paas: warning: state and engine disagree on 2 item(s); run paas reconcile --dry-run
$ paas reconcile --dry-run --redeploy
dry run: nothing was changed
fail: whoami deployment 8d4f016de041 (container disappeared)
redeploy: whoami (planned)
push-ingress: paas-caddy (planned)
$ paas reconcile --redeploy
fail: whoami deployment 8d4f016de041 (container disappeared)
redeploy: whoami (deployment 887861d2a929 is running)
push-ingress: paas-caddy (1 routes)
$ curl -s -H "Host: whoami.localhost" http://127.0.0.1:18080/ | head -1
Hostname: 05bcb38a7431
```

**Check:**
- `paas status` still prints the stored state on stdout. The warning goes to stderr, and the exit code stays 0.
- The dry run changes nothing: run `paas status` again and the warning is still there.
- After the real run, `paas ingress status` routes to the new container, and `curl` shows its id.

## 3. Caddy restarts and forgets its routes

Simulates a host reboot or an engine restart. paas pushes Caddy's config through its admin API, and Caddy does not keep that config across a restart.

On Docker, restart the container and let reconcile push the config again:

```console
$ docker restart paas-caddy
$ paas ingress status
...
routes:   0
$ paas status
...
paas: warning: state and engine disagree on 1 item(s); run paas reconcile --dry-run
$ paas reconcile
push-ingress: paas-caddy (1 routes)
$ curl -s -H "Host: whoami.localhost" http://127.0.0.1:18080/ | head -1
Hostname: 05bcb38a7431
```

On rootless Podman 3.4, restarting would fail to rebind the published port and leak a `containers-rootlessport` forwarder (see [Podman 3.4 port forwarders](#podman-34-port-forwarders)). Kill Caddy instead. Rootless Podman 3.4 ignores restart policies, so it stays `Exited (137)`, and reconcile starts it again:

```console
$ podman kill --signal KILL paas-caddy
$ paas ingress status
...
routes:   0
$ paas status
...
paas: warning: state and engine disagree on 1 item(s); run paas reconcile --dry-run
$ paas reconcile
start-ingress: paas-caddy (started, 1 routes)
$ curl -s -H "Host: whoami.localhost" http://127.0.0.1:18080/ | head -1
Hostname: 05bcb38a7431
```

**Check:** before the reconcile, `curl` still gets HTTP 200, but the page is Caddy's default welcome page, not whoami. Look for `Hostname:` in the body, not the status code.

## 4. The container stops, and an orphan is left

Simulates `docker stop`, or an app that crashed and was not restarted.

```console
$ docker stop whoami-887861d2a929
$ paas reconcile --dry-run --prune --redeploy
dry run: nothing was changed
fail: whoami deployment 887861d2a929 (container exited with code 2)
prune: whoami-887861d2a929 (planned)
redeploy: whoami (planned)
push-ingress: paas-caddy (planned)
$ paas reconcile
fail: whoami deployment 887861d2a929 (container exited with code 2)
orphan: whoami-887861d2a929 (app whoami; use --prune to remove)
push-ingress: paas-caddy (0 routes)
$ paas reconcile --prune
prune: whoami-887861d2a929 (removed)
push-ingress: paas-caddy (0 routes)
$ paas reconcile
nothing to reconcile
$ paas deploy whoami
```

**Check:**
- The exit code in the `fail` line is whatever the app returned on `SIGTERM`. whoami returns 2.
- Once its deployment has failed, the stopped container is an orphan. Without `--prune` it is only reported and left alone.
- `paas-caddy` never appears as an orphan.

`--redeploy` only redeploys apps that the same run failed. Here, the plain `paas reconcile` already marked whoami failed, so a later `--redeploy` does nothing for it, and the app stays down until `paas deploy whoami`. Pass `--redeploy` on the first run when you want the app back.

## 5. Clean up

```console
$ paas stop whoami
$ paas apps delete whoami
$ paas ingress down
removed paas-caddy; kept volume paas-caddy-data
$ docker volume rm paas-caddy-data
$ docker network rm paas-net
$ rm -rf "$PAAS_HOME"
$ docker ps -a --filter label=paas.managed=true
```

`paas ingress down` keeps the volume on purpose, because it holds Caddy's certificates. Remove it only when you are done testing. On Podman, use `podman` for the last four commands. The final listing should be empty.

## Podman 3.4 port forwarders

A container that the `podman` command started or restarted can leave a `containers-rootlessport` process holding its published host ports after the container stops or is removed. The forwarder is what binds the port, and nothing cleans it up when the container goes away, so the port stays busy even though `podman ps -a` shows no container using it. paas never starts containers through the `podman` command, so the containers it manages do not leak forwarders this way.

When paas reports a busy host port, confirm the leak and release it:

```console
$ ss -ltnp | grep :28080
LISTEN 0  4096  0.0.0.0:28080  0.0.0.0:*  users:(("exe",pid=12345,fd=8))
$ tr '\0' ' ' < /proc/12345/cmdline
/path/to/containers-rootlessport ...
$ podman ps -a
CONTAINER ID  IMAGE  COMMAND  CREATED  STATUS  PORTS  NAMES
$ kill 12345
```

`ss` names the pid that holds the port, the command line confirms it is a `containers-rootlessport` process, and `podman ps -a` shows no container using that port. If both hold, `kill <pid>` frees the port.

On WSL 2, Windows relays these ports, so a leaked forwarder also blocks Docker Desktop, which reports `Ports are not available`.

## Recording results

If something behaves differently from this guide, note the engine and version from `paas doctor`, the command, and its full output. Then add a row to [Known results](integration-testing.md#known-results) or open a queue item, as changes 008 and 010 did.
