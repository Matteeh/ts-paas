# Spec Delta

## REMOVED Requirements

### Requirement: Runtime factory

**Reason**: The placeholder factory that failed with `no container runtime is configured yet` is replaced by the Docker adapter.
**Migration**: See `Default container runtime`; commands get the Docker adapter and ping it before opening the state database.

## ADDED Requirements

### Requirement: Default container runtime

Commands that need a container runtime SHALL get it from the one runtime factory the program is built with, and SHALL ping it before they open the state database. The default factory SHALL be the Docker adapter on the resolved socket. An unresolvable or unreachable engine SHALL be an operation failure with the adapter's message, leaving state untouched. Tests SHALL inject a fake runtime and a shared clock.

#### Scenario: Unreachable engine
- **WHEN** app `web` exists, `PAAS_SOCKET` names a missing path, and a user runs `paas deploy web`
- **THEN** stderr is exactly `paas: cannot reach container engine at <path>: socket not found` and a newline, the exit code is 1, and no deployment is created

### Requirement: Doctor command

`paas doctor` SHALL print lines `socket:`, `engine:` (name and version), `api:`, and `paas-net:` (`present` or `missing`), each label padded to 10 characters, with `-` for an unknown value. It SHALL not create the network or open the state database. `--json` SHALL print `{socket, engine, version, apiVersion, paasNet}`. An unresolvable or unreachable engine SHALL exit 1 with the adapter's message.

#### Scenario: Doctor on the fake
- **WHEN** `paas doctor` runs on the fake runtime without `paas-net`
- **THEN** stdout is `socket:   -`, `engine:   fake 0.0.0`, `api:      -`, `paas-net: missing`, and the exit code is 0

#### Scenario: Engine unreachable
- **WHEN** `PAAS_SOCKET` names a missing path and a user runs `paas doctor`
- **THEN** stderr is `paas: cannot reach container engine at <path>: socket not found` and a newline, and the exit code is 1
