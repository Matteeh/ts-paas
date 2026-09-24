# Tasks

## 1. Runtime

- [x] 1. When the engine refuses to create or start a container because a host port is taken, the adapter fails with PortInUseError naming the address

## 2. Ingress

- [x] 2. When ingressUp creates paas-caddy and cannot start it, it removes that container and fails with the start's error

## 3. CLI

- [x] 3. When Caddy has stopped or a host port is busy, reconcile brings Caddy back and every command explains the busy port

## 4. Docs

- [x] 4. When a reader tries paas on rootless Podman 3.4, the docs steer them away from podman restart and explain leaked port forwarders
