# Spec Delta

## ADDED Requirements

### Requirement: Failed start leaves no container

When `ingressUp` creates `paas-caddy` and starting it fails, it SHALL force-remove that container, ignoring errors from the removal, and fail with the start's error. A `paas-caddy` that existed before the call and fails to start SHALL be left in place.

#### Scenario: Busy port on first up
- **WHEN** ingress is brought up and starting the new `paas-caddy` fails with `PortInUseError`
- **THEN** `ingressUp` fails with that error, no `paas-caddy` exists, and the admin API was never called

#### Scenario: Existing container fails to start
- **WHEN** `paas-caddy` exists but has exited, and starting it fails
- **THEN** `ingressUp` fails with the start's error and `paas-caddy` still exists
