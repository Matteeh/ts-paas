# Tasks

## 1. State

- [x] 1. When ingress settings are read or changed, the store keeps them in a settings table with defaults and validation

## 2. Ingress core

- [x] 2. When paas state holds apps with hostnames, a pure function builds Caddy's JSON config and an admin client can push and read it
- [x] 3. When ingress is brought up, down, inspected or synced, paas manages the Caddy container and pushes config only through the admin client

## 3. Deployment hook

- [x] 4. When a new deployment turns running, deploy awaits an optional onRunning hook before replacing the previous deployment

## 4. CLI

- [x] 5. When a user runs paas ingress up, down or status, the CLI manages Caddy through an injectable admin client
- [x] 6. When a user deploys or stops an app while ingress is up, paas pushes the new routes and reports a failed push

## 5. Integration

- [x] 7. When the integration tier runs with PAAS_INTEGRATION=1, it routes a hostname through a real Caddy to a small HTTP container
