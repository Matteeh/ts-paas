# ingress Specification

## Purpose
The `ingress` capability makes apps with a hostname reachable through one Caddy container that paas manages. paas configures Caddy only through its admin API, never by letting a proxy read the container socket, so routing is a pure function of paas state.

## Requirements

### Requirement: Caddy container

`ingressUp` SHALL ensure the network `paas-net`, the volume `paas-caddy-data`, and a running container `paas-caddy` from `docker.io/library/caddy:2` on `paas-net`, with restart policy `unless-stopped` and the label `paas.ingress=caddy`. It SHALL publish the HTTP host port to container port 80 and the HTTPS host port to container port 443 on every host address, and mount the volume at `/data`, where Caddy keeps certificates.

#### Scenario: First up
- **WHEN** ingress is brought up on the fake runtime with default settings
- **THEN** container `paas-caddy` is running on `paas-net`, publishes host ports 80 and 443 to container ports 80 and 443, and mounts `paas-caddy-data` at `/data`

### Requirement: Admin API on loopback only

Container port 2019 SHALL be published only on host address `127.0.0.1`, host port 2019. The container SHALL set `CADDY_ADMIN=0.0.0.0:2019` so Caddy's admin API listens where the port is published, and every pushed config SHALL set `admin.listen` to `0.0.0.0:2019`. The admin API has no authentication; app containers on `paas-net` can reach it.

#### Scenario: Admin binding
- **WHEN** ingress is brought up
- **THEN** container port 2019 is published on `127.0.0.1:2019` and on no other host address

#### Scenario: Pushed config keeps the admin listener
- **WHEN** any config is built
- **THEN** its `admin.listen` is `0.0.0.0:2019`

### Requirement: Idempotent up

`ingressUp` SHALL leave a running `paas-caddy` whose `paas.ingress.http-port` and `paas.ingress.https-port` labels match the settings as it is, start a stopped one, and remove and recreate one whose labels differ. It SHALL pull the image only when it creates the container. It SHALL then push the current config and report `created`, `recreated`, `started` or `unchanged`.

#### Scenario: Up twice
- **WHEN** ingress is brought up twice with the same settings
- **THEN** the second call reports `unchanged`, pulls nothing, and the container keeps its id

#### Scenario: Port change recreates
- **WHEN** ingress is up with HTTP port 80 and is brought up again with HTTP port 8080
- **THEN** it reports `recreated` and the new container publishes host port 8080 to container port 80

#### Scenario: Stopped container starts
- **WHEN** `paas-caddy` exists but is stopped and ingress is brought up
- **THEN** it reports `started`, the container keeps its id, and the config is pushed

### Requirement: Ingress down

`ingressDown` SHALL stop and remove `paas-caddy` and SHALL keep the volume `paas-caddy-data`. When the container does not exist it SHALL succeed and report that nothing was removed.

#### Scenario: Down keeps certificates
- **WHEN** ingress is up and is brought down
- **THEN** `paas-caddy` no longer exists and the volume `paas-caddy-data` still does

### Requirement: Config generation

`buildCaddyConfig` SHALL be a pure function of the TLS mode and a list of routes. It SHALL produce one HTTP server, `paas`, with one route per input route, ordered by hostname, each matching its hostname exactly and reverse-proxying to its upstream. `desiredRoutes` SHALL give one route per app that has a hostname and a running deployment, with upstream `<container name>:<app port>` of its newest running deployment.

#### Scenario: Redeploy points at the new container
- **WHEN** app `web` (hostname `web.localhost`, port 8080) has running deployments A and then B
- **THEN** its only route dials `web-<B>:8080`

#### Scenario: Apps without a route
- **WHEN** app `api` has a running deployment but no hostname, and app `web` has a hostname but only a stopped deployment
- **THEN** the config has no routes

### Requirement: TLS modes

In TLS mode `off`, the default, the server SHALL listen on `:80` with automatic HTTPS disabled, serving plain HTTP for any hostname, including `.localhost` ones. In mode `auto`, it SHALL listen on `:443` with automatic HTTPS on, so Caddy obtains certificates for the hostnames and redirects HTTP to HTTPS.

#### Scenario: TLS off
- **WHEN** a config is built in mode `off`
- **THEN** server `paas` listens on `[":80"]` and has `automatic_https.disable` set to `true`

#### Scenario: TLS auto
- **WHEN** a config is built in mode `auto`
- **THEN** server `paas` listens on `[":443"]` and has no `automatic_https` field

### Requirement: Pushing config

`syncIngress` SHALL push the config built from the stored TLS mode and `desiredRoutes` to Caddy's `POST /load` when `paas-caddy` is running, and SHALL do nothing when it is missing or not running. A failed push SHALL reject with the admin client's error and change no paas state.

#### Scenario: No Caddy, no push
- **WHEN** `paas-caddy` does not exist and `syncIngress` runs
- **THEN** it resolves without calling the admin API

### Requirement: Waiting for the admin API

After ensuring the container, `ingressUp` SHALL retry a push that cannot reach the admin API every 250 ms on the injected clock, for up to 10 seconds, and then fail with the last error. An admin API that answers with an error status SHALL fail at once.

#### Scenario: Caddy is still starting
- **WHEN** the first two pushes cannot reach the admin API and the third succeeds
- **THEN** `ingressUp` resolves after the clock advances 500 ms

### Requirement: Admin client

`HttpCaddyAdmin` SHALL send the config as JSON to `POST <base>/load` and read it from `GET <base>/config/`, over `node:http`, with no `Origin`, `Referer` or `Sec-Fetch-*` header: Caddy enforces origins whenever one is present. A request that cannot connect SHALL fail with `AdminUnreachableError`, `cannot reach Caddy admin API at <base>: <cause>`. A non-2xx response SHALL fail with `AdminRequestError`, `Caddy admin API answered <status>: <first line of body>`.

#### Scenario: Caddy rejects the config
- **WHEN** `POST /load` answers 400 with body `{"error":"bad config"}`
- **THEN** the push fails with `AdminRequestError` whose message starts `Caddy admin API answered 400: `

#### Scenario: Server that enforces origins
- **WHEN** the admin API answers 403 to any request carrying `Origin`, `Referer` or a `Sec-Fetch-*` header
- **THEN** `load` and `getConfig` both succeed

### Requirement: Ingress status

`ingressStatus` SHALL report the container as `running`, `stopped` or `missing`, the stored TLS mode and ports, and, only while it runs, the routes Caddy serves as hostname and upstream pairs, read from `GET /config/`. Routes it cannot parse SHALL be left out.

#### Scenario: Status reads Caddy
- **WHEN** Caddy runs with a pushed config holding a route for `web.localhost`
- **THEN** status reports `running` and one route with hostname `web.localhost` and that route's upstream

### Requirement: Code ownership
<!-- source: src/ingress/** -->
The ingress capability SHALL own Caddy config generation, the Caddy admin clients, and the Caddy container lifecycle.

#### Scenario: Codebase ownership boundaries
- **WHEN** file ownership is resolved for ingress
- **THEN** system maps `src/ingress/**` to ingress
