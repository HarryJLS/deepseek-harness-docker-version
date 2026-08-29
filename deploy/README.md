---
description: "Operator guide for the containerized DeepSeek Harness deployment: what is configured where, how to run the stack, and how to change a running deployment without redeploying."
kind: "deployment-reference"
---

# Containerized deployment

This directory deploys DeepSeek Harness as a container that owns **no writable
volume**. Every path the harness would normally keep under `$DSH_HOME` is served
by one of two backing services, so a replaced container starts clean and loses
nothing.

## The configuration split

The deployment answers one question before any other: does a value have to be
readable *before* a remote configuration source can be contacted?

- **Yes → static.** It ships with the image in
  [`packages/bundle/docker/cordis.patch.yml`](../packages/bundle/docker/cordis.patch.yml).
  The bind address, the Nacos coordinates, and the database URL are all in this
  class, because reading them from Nacos would be circular.
- **No → live.** It lives in Nacos and reaches a running container within
  seconds, with no restart and no redeploy.

| Class | Holds | Where | Changing it |
|---|---|---|---|
| Static | bind host/port, access gates, Nacos + PostgreSQL coordinates, which plugins are mounted | `cordis.patch.yml` in the image | rebuild and redeploy |
| Live | model routes and every user-settings namespace | Nacos `dsh-settings.yaml` | edit in the Nacos console |
| Live | API keys and authorization grants | Nacos `dsh-credentials.yaml` | edit in the Nacos console |
| Live | the plugin roster | `DSH_PLUGINS` | restart the container |

## Durable state

| State | Backend | Table |
|---|---|---|
| Session event logs | PostgreSQL | `dsh.session`, `dsh.session_event` |
| `ctx.storage` documents | PostgreSQL | `dsh.kv_unit`, `dsh.kv_record`, `dsh.kv_global` |
| Attachment images | PostgreSQL | `dsh.attachment_object` |
| User settings | Nacos | `dsh-settings.yaml` |
| Credentials | Nacos | `dsh-credentials.yaml` |

Derived model-request image variants deliberately stay on the container's own
filesystem: each is a deterministic function of (reference, route policy), so a
replaced container regenerates identical bytes. Only what cannot be recomputed
is made durable.

## Run it

```sh
DSH_CLIENT_COMMIT_HASH=$(git rev-parse HEAD) \
  docker compose -f deploy/docker-compose.yml up -d --build
```

The commit hash is passed explicitly because the build context excludes `.git`;
the repository's own `repositoryCommitHash` reads that variable before shelling
out to git.

| Service | Port | Purpose |
|---|---|---|
| `dsh` | 3080 | the harness Web UI and `/api` |
| `nacos` | 8848 / 9848 / 8080 | config API / its derived gRPC port / the console |
| `postgres` | — | not published; reached over the compose network |

Nacos 3.x serves its console on **8080**, not on 8848 as 2.x did.

## Access control

The container binds every interface and **both request gates are open**: any
client that can reach the published port drives an agent with shell access.
There is no authentication in front of it.

Publish port 3080 only onto a network that already answers for access. To close
it again, set `requireAuth: true` and drop `allowAnyHost` in the bundle patch's
`connection` row; the harness then requires its browser-session token and
accepts only the authorities listed in `trustedHosts`.

## Change a running deployment

**Settings and credentials.** Edit `dsh-settings.yaml` or
`dsh-credentials.yaml` in the Nacos console. The container holds a gRPC
subscription and applies the change within seconds — no restart. The inherited
process environment still outranks the stored credential document, so a key
supplied through the container's environment stays authoritative and a write
beneath it is refused rather than silently ignored.

**Plugins.** Set `DSH_PLUGINS` to a comma- or space-separated list of package
specs and restart the container. Each is installed from the registry into the
profile; a package declaring `dsh.bundle` also becomes an active configuration
layer. One that does not is installed as a plain dependency and says so in the
log.

```yaml
environment:
  DSH_PLUGINS: 'dsh-plugin-example@1.2.0 @acme/dsh-internal-tools'
```

**Anything static.** Edit the bundle patch, rebuild, redeploy.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `DSH_PORT` | `3080` | listen port inside the container |
| `DSH_NACOS_HOST` / `DSH_NACOS_PORT` | `nacos` / `8848` | Nacos address; the gRPC port is derived |
| `DSH_NACOS_NAMESPACE` / `DSH_NACOS_GROUP` | `` / `DEFAULT_GROUP` | Nacos namespace and group |
| `DSH_NACOS_SETTINGS_DATA_ID` | `dsh-settings.yaml` | settings entry |
| `DSH_NACOS_CREDENTIALS_DATA_ID` | `dsh-credentials.yaml` | credentials entry |
| `DSH_NACOS_USERNAME` / `DSH_NACOS_PASSWORD` | unset | Nacos auth, when enabled |
| `DSH_POSTGRES_URL` | unset | full connection string; wins over the discrete fields |
| `DSH_POSTGRES_HOST` / `_PORT` / `_DB` / `_USER` / `_PASSWORD` | `postgres` / `5432` / `dsh` / `dsh` / unset | discrete connection fields |
| `DSH_PLUGINS` | empty | plugin roster installed at start |

## Operational notes

- **Nacos 3.x requires `NACOS_AUTH_TOKEN`** to be a Base64 string even when
  auth is disabled; the server exits at startup without it.
- **The credentials entry holds secrets.** Scope its Nacos namespace to this
  deployment.
- **The database is the single source of truth for sessions.** Several replicas
  may share one database; each keeps its own derived variant cache.
- **`prepare-profile.mjs` runs before the harness** and is idempotent: a
  restarted container with an unchanged roster converges on the same profile.
