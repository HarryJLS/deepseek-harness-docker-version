#!/usr/bin/env node
/**
 * Container entrypoint helper: prepare the dsh profile before the harness boots.
 *
 * Two jobs, both of which must happen before the Loader composes the tree:
 *
 * 1. Select the container bundle. `@deepseek-ai/dsh-bundle-docker` ships inside
 *    the image, so it needs no installation — only a place in the profile's
 *    ordered `dsh.profile.bundles` list, appended last so its layer wins.
 *
 * 2. Install the deployment's plugin roster from an npm registry. This is the
 *    flexibility half of the deployment: which plugins a production container
 *    runs is a live decision, not an image rebuild. The roster is the union of
 *    `DSH_PLUGINS` (comma or space separated package specs) and the Nacos entry
 *    named by `DSH_NACOS_PLUGINS_DATA_ID`, and each spec is handed to
 *    `dsh plugin add`, which forwards to pnpm inside the profile directory and
 *    appends any package declaring `dsh.bundle` to the list.
 *
 * The install runs HERE, before the harness starts, because the Loader resolves
 * a profile's modules once at composition: a package installed into a running
 * process is not mountable by it, however the mount is requested. Declaring a
 * plugin in Nacos therefore takes effect on the container's next start, which
 * is what makes this script — not a plugin — the right owner of the roster.
 *
 * Both steps are idempotent: a restarted container with an unchanged roster
 * re-runs them and converges on the same profile.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DSH_BIN = process.env.DSH_BIN ?? '/app/apps/cli/lib/bin.js'
const PROFILE = process.env.DSH_PROFILE ?? 'web'
const HOME_DIR = process.env.DSH_HOME ?? '/var/lib/dsh'
const CONTAINER_BUNDLE = '@deepseek-ai/dsh-bundle-docker'
const NACOS_CLIENT = '/app/packages/nacos/nacos-client/lib/index.js'
const ENV_FILE = process.env.DSH_RESOLVED_ENV ?? '/run/dsh-resolved.env'
const YAML_MODULE = '/app/packages/bundle/docker/node_modules/yaml/dist/index.js'

const profileDir = join(HOME_DIR, 'profiles', PROFILE)
const manifestPath = join(profileDir, 'package.json')

/**
 * Run one dsh subcommand, inheriting stdio so failures are visible in logs.
 * @param args - the subcommand and its arguments.
 * @param env - extra environment variables for this call only.
 * @returns the spawn result.
 */
function dsh(args, env = {}) {
  return spawnSync(process.execPath, [DSH_BIN, ...args], {
    stdio: 'inherit',
    env: { ...process.env, ...env },
  })
}

/**
 * Environment that authenticates the install against a private registry.
 *
 * npm and pnpm read a bearer token from a host-scoped `_authToken` key, which
 * has no command-line form — it must reach the child as configuration. The
 * npm-config environment convention (`npm_config_<key>`) supplies it without
 * writing a file, so the token never lands on disk in the profile, where a
 * later `pnpm` run or a support bundle would pick it up.
 *
 * A registry-less token is refused rather than ignored: it means the operator
 * expected authentication that would silently not happen, and a private
 * package would then fail with a 404 naming no cause.
 * @param registry - the configured registry URL, if any.
 * @param token - the configured bearer token, if any.
 * @returns the environment overlay for the install call.
 * @throws when a token is configured without a registry.
 */
function registryAuth(registry, token) {
  if (token === undefined || token === '') return {}
  if (registry === undefined) {
    throw new Error('entrypoint: a plugin-registry token needs a registry to scope it to')
  }
  const { host, pathname } = new URL(registry)
  // npm keys the token by host and path, without scheme, exactly as an .npmrc
  // line spells it: //host/path/:_authToken
  const scope = `//${host}${pathname.endsWith('/') ? pathname : `${pathname}/`}`
  return { [`npm_config_${scope}:_authToken`]: token }
}

/** Split a roster string on commas and whitespace, dropping empties. */
function splitSpecs(value) {
  return (value ?? '')
    .split(/[,\s]+/u)
    .map(entry => entry.trim())
    .filter(entry => entry !== '')
}

/**
 * Read the Nacos-declared roster, if the deployment has one.
 *
 * Nacos is optional here: a deployment that configures no Nacos, or whose entry
 * does not exist, gets an empty roster rather than a failed start — the plugin
 * list is not what the container needs to serve its first request. A
 * malformed entry IS fatal, because silently starting without the plugins an
 * operator declared is worse than not starting.
 *
 * @returns the declared registry (or undefined) and package specs.
 */
async function readNacosEntries(dataIds) {
  const host = process.env.DSH_NACOS_HOST
  if (host === undefined || host === '') return {}
  const { NacosConfigClient } = await import(NACOS_CLIENT)
  const client = new NacosConfigClient({
    host,
    port: Number(process.env.DSH_NACOS_PORT ?? 8848),
    namespace: process.env.DSH_NACOS_NAMESPACE ?? '',
    ...process.env.DSH_NACOS_USERNAME !== undefined && { username: process.env.DSH_NACOS_USERNAME },
    ...process.env.DSH_NACOS_PASSWORD !== undefined && { password: process.env.DSH_NACOS_PASSWORD },
  })
  client.setErrorHandler(error => {
    console.warn(`entrypoint: nacos read failed: ${String(error)}`)
  })
  const group = process.env.DSH_NACOS_GROUP ?? 'DEFAULT_GROUP'
  const out = {}
  try {
    await client.connect()
    for (const dataId of dataIds) {
      out[dataId] = (await client.read({ dataId, group })).content
    }
  } catch (error) {
    console.warn(`entrypoint: cannot reach Nacos; continuing without it (${String(error)})`)
    return {}
  } finally {
    client.close()
  }
  return out
}

/**
 * Environment variable each declared database field is published as, and the
 * `!!js` expression in the composition that reads it.
 *
 * Declared once so the settings entry's vocabulary and the container's
 * environment cannot drift apart: a field added here is readable from Nacos
 * and from the environment with no other change.
 */
const DATABASE_ENV = {
  url: 'DSH_MYSQL_URL',
  host: 'DSH_MYSQL_HOST',
  port: 'DSH_MYSQL_PORT',
  database: 'DSH_MYSQL_DB',
  user: 'DSH_MYSQL_USER',
  password: 'DSH_MYSQL_PASSWORD',
}

/**
 * What this deployment declares about itself in its Nacos settings entry: the
 * application name that scopes its rows, and how to reach the database.
 *
 * The settings entry is the declaring home. An application owns its Nacos, so
 * naming itself and its database credentials there keeps its whole identity in
 * one place and leaves the container's environment to say only where Nacos
 * lives. The environment remains the fallback for every field, for a
 * deployment that has no settings entry yet or pins a value outside Nacos.
 *
 * Credentials specifically belong here rather than in the container's
 * environment: rotating a database password becomes a Nacos edit and a
 * restart, not a redeploy, and the secret stops appearing in `docker inspect`
 * and in the compose file. Scope the entry's Nacos namespace accordingly — it
 * now holds a database password.
 *
 * Read once, at start, because these values are bound when each database
 * plugin opens its pool: a later change cannot move rows that are already
 * written, so it takes effect on the next start rather than pretending to be
 * live.
 * @param content - the settings entry body, or undefined when absent.
 * @returns the application name and every declared database field.
 */
async function resolveDeployment(content) {
  const fallback = { appName: process.env.DSH_APP_NAME ?? 'dsh', database: {} }
  if (content === undefined || content.trim() === '') return fallback
  const { parse } = await import(YAML_MODULE)
  const deployment = parse(content)?.deployment
  if (deployment === undefined || deployment === null) return fallback

  const declaredName = deployment.appName
  const appName = typeof declaredName === 'string' && declaredName.trim() !== ''
    ? declaredName.trim()
    : fallback.appName
  if (appName !== fallback.appName || typeof declaredName === 'string') {
    console.log(`entrypoint: deployment.appName = ${appName} (from the settings entry)`)
  }

  // Only a field the entry actually declares is published. Writing an empty
  // value for an absent one would override the container's environment with
  // nothing, which is the opposite of a fallback.
  const database = {}
  for (const field of Object.keys(DATABASE_ENV)) {
    const value = deployment.database?.[field]
    if (value === undefined || value === null || String(value).trim() === '') continue
    database[field] = String(value).trim()
  }
  if (Object.keys(database).length > 0) {
    // The password is deliberately not among the names logged.
    console.log(`entrypoint: deployment.database declares ${Object.keys(database).join(', ')}`)
  }
  return { appName, database }
}

/**
 * Publish the resolved values to the environment the harness will start with.
 *
 * The entrypoint sources this file before `exec`, because a variable this
 * script sets cannot reach a sibling process: the harness reads `DSH_APP_NAME`
 * and the `DSH_MYSQL_*` fields through the `!!js` expressions in its
 * composition, so the values have to be in the environment rather than passed
 * as arguments.
 *
 * The file holds a database password. It is written under `/run`, which is a
 * tmpfs the container discards on stop, and is read by exactly one shell.
 * @param resolved - the application name and declared database fields.
 */
function publishResolvedEnv({ appName, database }) {
  const lines = [`export DSH_APP_NAME=${JSON.stringify(appName)}`]
  for (const [field, variable] of Object.entries(DATABASE_ENV)) {
    if (database[field] === undefined) continue
    lines.push(`export ${variable}=${JSON.stringify(database[field])}`)
  }
  writeFileSync(ENV_FILE, `${lines.join('\n')}\n`)
}

/**
 * Parse the Nacos-declared plugin roster.
 * @param content - the roster entry body, or undefined when absent.
 * @param dataId - the entry name, for diagnostics.
 * @returns the declared registry, token, and package specs.
 */
async function parseRoster(content, dataId) {
  // A deployment that declares no roster is the normal case, not an error: the
  // entry is absent until an operator creates one.
  if (content === undefined || content.trim() === '') return { packages: [] }
  const { parse } = await import(YAML_MODULE)
  const document = parse(content)
  if (document === null || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error(`entrypoint: ${dataId} must be a YAML mapping with a 'packages' list`)
  }
  const packages = Array.isArray(document.packages) ? document.packages : []
  for (const spec of packages) {
    if (typeof spec !== 'string' || spec.trim() === '') {
      throw new Error(`entrypoint: ${dataId} lists a package that is not a string: ${JSON.stringify(spec)}`)
    }
  }
  console.log(`entrypoint: ${dataId} declares ${String(packages.length)} plugin package(s)`)
  return {
    ...typeof document.registry === 'string' && { registry: document.registry },
    ...typeof document.token === 'string' && { token: document.token },
    packages: packages.map(spec => spec.trim()),
  }
}

/**
 * Materialize the profile. `--dump-default-config` composes the bundle layers
 * and exits without binding anything, which is the cheapest way to make dsh
 * create the profile directory using its own initialization rules rather than
 * hand-writing a manifest this script would then have to keep in step.
 */
function ensureProfile() {
  if (existsSync(manifestPath)) return
  mkdirSync(HOME_DIR, { recursive: true })
  const probe = spawnSync(
    process.execPath,
    [DSH_BIN, '--profile', PROFILE, '--dump-default-config'],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  )
  if (!existsSync(manifestPath)) {
    throw new Error(
      `entrypoint: dsh did not create ${manifestPath} (exit ${String(probe.status)})`,
    )
  }
}

/** Append the container bundle to the profile's ordered bundle list, once. */
function selectContainerBundle() {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const bundles = manifest.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) {
    throw new Error(`entrypoint: ${manifestPath} has no dsh.profile.bundles list`)
  }
  if (bundles.includes(CONTAINER_BUNDLE)) return
  // Last in the list is last applied, so the container layer overrides the
  // base and web-app rows it restates.
  bundles.push(CONTAINER_BUNDLE)
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`entrypoint: selected ${CONTAINER_BUNDLE}`)
}

/**
 * Install every rostered plugin package into the profile.
 *
 * The environment and the Nacos entry are one roster, de-duplicated by spec so
 * a package named in both is installed once. The registry comes from the entry,
 * else `DSH_NPM_REGISTRY`; without either, pnpm uses its own default.
 * @param declared - the Nacos-declared registry, token, and packages.
 */
function installRoster(declared) {
  const packages = [...new Set([...splitSpecs(process.env.DSH_PLUGINS), ...declared.packages])]
  removeDropped(packages)
  if (packages.length > 0) {
    const registry = declared.registry ?? process.env.DSH_NPM_REGISTRY
    const registryArgs = registry === undefined ? [] : ['--registry', registry]
    console.log(
      `entrypoint: installing ${String(packages.length)} plugin package(s)`
      + `${registry === undefined ? '' : ` from ${registry}`}`,
    )
    const result = dsh(
      ['plugin', '--profile', PROFILE, 'add', ...registryArgs, ...packages],
      registryAuth(registry, declared.token ?? process.env.DSH_NPM_TOKEN),
    )
    if (result.status !== 0) {
      throw new Error(`entrypoint: plugin install failed with exit ${String(result.status)}`)
    }
  }
  // Recorded even for an empty roster: the record is what the NEXT start diffs
  // against, so skipping it would re-remove an already-removed package forever.
  rememberRoster(packages)
}

/**
 * The package NAME a pnpm spec installs, which is what uninstalling needs: a
 * version range, a tarball path, and a registry name all resolve to one name,
 * and only the name is addressable once installed.
 * @param spec - one pnpm package spec.
 * @returns the package name, or undefined when the spec names no package
 *   directly (a path or URL, whose installed name is not derivable from it).
 */
function specName(spec) {
  if (/^(?:file:|link:|https?:|git\+|github:)/u.test(spec) || spec.startsWith('.') || spec.startsWith('/')) {
    return undefined
  }
  const at = spec.lastIndexOf('@')
  return at > 0 ? spec.slice(0, at) : spec
}

/**
 * Uninstall the packages a previous start installed from the roster and this
 * one no longer declares.
 *
 * The roster is declarative: removing a line means the plugin should be gone,
 * and leaving it installed would keep mounting it through its own bundle layer.
 * Only packages THIS script recorded are removed — a package an operator added
 * by hand is not the roster's to reclaim.
 * @param packages - the specs this start declares.
 */
function removeDropped(packages) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const previous = manifest.dsh?.roster ?? []
  const declaredNames = new Set(packages.map(specName).filter(name => name !== undefined))
  const dropped = previous.filter(name => !declaredNames.has(name))
  if (dropped.length === 0) return
  console.log(`entrypoint: removing ${String(dropped.length)} plugin package(s) dropped from the roster`)
  const result = dsh(['plugin', '--profile', PROFILE, 'remove', ...dropped])
  if (result.status !== 0) {
    throw new Error(`entrypoint: plugin removal failed with exit ${String(result.status)}`)
  }
}

/**
 * Record which packages the roster owns, so a later start can tell a package it
 * installed from one an operator added by hand.
 * @param packages - the specs this start installed.
 */
function rememberRoster(packages) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const names = [...new Set(packages.map(specName).filter(name => name !== undefined))].sort()
  manifest.dsh = { ...manifest.dsh, roster: names }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

const SETTINGS_DATA_ID = process.env.DSH_NACOS_SETTINGS_DATA_ID ?? 'dsh-settings.yaml'
const ROSTER_DATA_ID = process.env.DSH_NACOS_PLUGINS_DATA_ID ?? 'dsh-plugin-roster.yml'

ensureProfile()
selectContainerBundle()

const entries = await readNacosEntries([SETTINGS_DATA_ID, ROSTER_DATA_ID])
publishResolvedEnv(await resolveDeployment(entries[SETTINGS_DATA_ID]))
installRoster(await parseRoster(entries[ROSTER_DATA_ID], ROSTER_DATA_ID))
