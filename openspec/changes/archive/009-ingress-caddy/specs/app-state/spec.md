# Spec Delta

## ADDED Requirements

### Requirement: Ingress settings

Migration 2 SHALL add a `settings` table of text keys and values. `getIngressSettings` SHALL return the TLS mode (`off` or `auto`) and the HTTP and HTTPS host ports, defaulting to `off`, 80 and 443 for unset values. `setIngressSettings` SHALL store only the values it is given. Invalid values SHALL fail with `ValidationError` naming `tls`, `httpPort` or `httpsPort`, and store nothing.

#### Scenario: Defaults
- **WHEN** a new database is opened
- **THEN** `getIngressSettings` returns TLS mode `off`, HTTP port 80 and HTTPS port 443

#### Scenario: Partial update survives reopening
- **WHEN** only the HTTP port is set to 8080 and the file database is reopened
- **THEN** the settings are TLS mode `off`, HTTP port 8080 and HTTPS port 443

#### Scenario: Ports must differ
- **WHEN** the stored HTTP port is 8080 and the HTTPS port is set to 8080
- **THEN** it fails with `ValidationError` whose `field` is `httpsPort`, and the HTTPS port stays 443

#### Scenario: Unknown TLS mode
- **WHEN** the TLS mode is set to `on`
- **THEN** it fails with `ValidationError` whose `field` is `tls`
