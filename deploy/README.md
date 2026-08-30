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
| Live | application name, plugin roster | Nacos `dsh-settings.yaml` / `dsh-plugin-roster.yml` | restart the container |

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

**Plugins.** Declare the roster in the Nacos entry `dsh-plugin-roster.yml` and
restart the container:

```yaml
registry: https://npm.internal.example.com/
packages:
  - dsh-plugin-example@1.2.0
  - '@acme/dsh-internal-tools'
```

Each spec is installed into the profile from `registry` (else `DSH_NPM_REGISTRY`,
else pnpm's default). A package declaring `dsh.bundle` also becomes an active
configuration layer; one that does not is installed as a plain dependency and
says so in the log.

The roster is declarative for the packages it installs: dropping a line
uninstalls that package on the next start. Only packages a previous start
installed from the roster are removed — one an operator added by hand with
`dsh plugin add` is left alone.

`DSH_PLUGINS` still works and is merged with the entry, for a deployment that
pins its plugins to the image's environment rather than to Nacos:

```yaml
environment:
  DSH_PLUGINS: 'dsh-plugin-example@1.2.0 @acme/dsh-internal-tools'
```

**A roster change needs a restart, and that is not a limitation of the entry.**
The Loader resolves a profile's modules once, at composition: a package
installed into a running process is not mountable by it, however the mount is
requested. The install therefore runs in the entrypoint, before the harness
starts. What Nacos buys is central editing — no redeploy, no environment change,
one entry per application — not a restart-free install.

Mounting is a different matter and IS live: for a package already installed,
`dsh-plugins.yml` mounts, unmounts, disables, and reconfigures it without a
restart. Do not `insert` a package that already declares its own `dsh.bundle` —
it would mount twice, and a plugin holding a named resource fails the second
time.

**Anything static.** Edit the bundle patch, rebuild, redeploy.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `DSH_PORT` | `3080` | listen port inside the container |
| `DSH_APP_NAME` | `dsh` | fallback application name; the settings entry's `deployment.appName` wins |
| `DSH_NACOS_HOST` / `DSH_NACOS_PORT` | `nacos` / `8848` | Nacos address; the gRPC port is derived |
| `DSH_NACOS_NAMESPACE` / `DSH_NACOS_GROUP` | `` / `DEFAULT_GROUP` | Nacos namespace and group |
| `DSH_NACOS_SETTINGS_DATA_ID` | `dsh-settings.yaml` | settings entry |
| `DSH_NACOS_CREDENTIALS_DATA_ID` | `dsh-credentials.yaml` | credentials entry |
| `DSH_NACOS_USERNAME` / `DSH_NACOS_PASSWORD` | unset | Nacos auth, when enabled |
| `DSH_POSTGRES_URL` | unset | full connection string; wins over the discrete fields |
| `DSH_POSTGRES_HOST` / `_PORT` / `_DB` / `_USER` / `_PASSWORD` | `postgres` / `5432` / `dsh` / `dsh` / unset | discrete connection fields |
| `DSH_POSTGRES_SCHEMA` | derived from `DSH_APP_NAME` | overrides the derived schema with an exact name |
| `DSH_PLUGINS` | empty | plugin specs installed at start, merged with the Nacos roster |
| `DSH_NACOS_PLUGINS_DATA_ID` | `dsh-plugin-roster.yml` | roster entry |
| `DSH_NPM_REGISTRY` | unset | registry used when the roster entry names none |

- [Configuration guide (zh)](CONFIGURATION-GUIDE.zh.md) — step-by-step setup, every Nacos entry with a worked example, multi-application deployment, plugin publishing, and troubleshooting.

## Operational notes

- **Nacos 3.x requires `NACOS_AUTH_TOKEN`** to be a Base64 string even when
  auth is disabled; the server exits at startup without it.
- **The credentials entry holds secrets.** Scope its Nacos namespace to this
  deployment.
- **The database is the single source of truth for sessions.** Several replicas
  may share one database; each keeps its own derived variant cache.
- **Several applications share one database, but each owns its Nacos.** Every
  entry is named the same in every deployment, so an application built on this
  image makes no naming decision; its own Nacos (namespace or server) is what
  separates its configuration. The database is the shared backend, so name the
  application in the settings entry's `deployment.appName` — its tables then
  land in a schema of that name. They must not share a schema —
  `kv_record`'s primary key is `(unit, tbl, key)` and carries no application
  column, so two applications writing the same unit overwrite each other. The
  database role needs `CREATE` on the database to make each schema on first
  start.
- **Renaming an application does not migrate it.** A changed `deployment.appName`
  points the container at an empty schema on its next start; the previous one is
  left in place. The name is read once at start, because the schema is chosen
  when each PostgreSQL plugin opens its pool.
- **`prepare-profile.mjs` runs before the harness** and is idempotent: a
  restarted container with an unchanged roster converges on the same profile.
