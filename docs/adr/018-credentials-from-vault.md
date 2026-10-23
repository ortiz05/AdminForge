# ADR-018: App-only credentials from HashiCorp Vault

Status: accepted (2026-10-23); amends ADR-011 and ADR-014 (where the automation and app identities' credentials live)

## Context

The automation identity's and each named app identity's client secret or certificate lived in the env file (on the
cluster: the `adminforge-env` Secret, the `adminforge-automation-cert` Secret). The owner wants every account that
reports and automations run as to come from a HashiCorp Vault keystore, so credentials are issued, rotated and audited
in one place and never copied into an env file. No Vault instance exists yet.

## Decision

- **AdminForge reads Vault itself**, off unless `AF_VAULT_ADDR` is set. It logs in with **Kubernetes auth** (a
  projected service-account token with audience `vault`, mounted only into the API container; the pod still mounts no
  Kubernetes API token), **AppRole** (role id + a secret-id file) or a **token file** (development, break-glass), with
  an optional Vault Enterprise namespace and CA bundle.
- **One KV version 2 secret per identity** at `<AF_VAULT_KV_MOUNT>/<AF_VAULT_PATH>/identities/<name>`
  (`automation` for the automation identity): `client_secret`, or `certificate_pem` (certificate + unencrypted private
  key), and optionally `client_id`, which must match the env file's. **Client ids stay in the env file**: they aren't
  secret, provisioning writes them, and start-up checks and the protected-apps list need them before Vault answers.
  With Vault on, the env file's client secrets and certificate paths must be empty (start-up refuses otherwise) — one
  source.
- **In memory only**: read at start, every `AF_VAULT_REFRESH_SECONDS` (default 300) and at once (at most every 30 s per
  identity) when Entra rejects a credential, so a rotation needs no restart. The Vault token is renewed before it
  expires, or the login repeated. While Vault is unreachable the last good credentials stay in use; an identity that
  never loaded fails its runs with `credential_unavailable`.
- **Never a value outside memory**: errors, logs, the `vaultCredentials` probe and `provision status` name paths and
  HTTP statuses only.
- Provisioning keeps writing new credentials to the env file; moving them into Vault is a documented `vault kv put`
  (a provisioning target for Vault can come later).

## Consequences

The pod needs egress to Vault (an installation's private-egress policy, as for any private address) and a Vault role
bound to the `adminforge` service account; a Vault outage delays nothing while the cached credentials stay valid, and
the platform probe warns. Vault's own audit log shows every read. The Read and Write apps' secrets (delegated sign-in)
still come from the env file: they belong to the portal's sign-in, not to unattended work.
