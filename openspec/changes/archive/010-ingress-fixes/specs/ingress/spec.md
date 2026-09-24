# Spec Delta

## MODIFIED Requirements

### Requirement: Admin client

`HttpCaddyAdmin` SHALL send the config as JSON to `POST <base>/load` and read it from `GET <base>/config/`, over `node:http`, with no `Origin`, `Referer` or `Sec-Fetch-*` header: Caddy enforces origins whenever one is present. A request that cannot connect SHALL fail with `AdminUnreachableError`, `cannot reach Caddy admin API at <base>: <cause>`. A non-2xx response SHALL fail with `AdminRequestError`, `Caddy admin API answered <status>: <first line of body>`.

#### Scenario: Caddy rejects the config
- **WHEN** `POST /load` answers 400 with body `{"error":"bad config"}`
- **THEN** the push fails with `AdminRequestError` whose message starts `Caddy admin API answered 400: `

#### Scenario: Server that enforces origins
- **WHEN** the admin API answers 403 to any request carrying `Origin`, `Referer` or a `Sec-Fetch-*` header
- **THEN** `load` and `getConfig` both succeed
