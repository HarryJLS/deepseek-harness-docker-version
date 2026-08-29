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
 *    runs is a live decision, not an image rebuild. The roster arrives as
 *    `DSH_PLUGINS` (comma or space separated package specs) and each entry is
 *    handed to `dsh plugin add`, which forwards to pnpm inside the profile
 *    directory and appends any package declaring `dsh.bundle` to the list.
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

const profileDir = join(HOME_DIR, 'profiles', PROFILE)
const manifestPath = join(profileDir, 'package.json')

/** Run one dsh subcommand, inheriting stdio so failures are visible in logs. */
function dsh(args) {
  return spawnSync(process.execPath, [DSH_BIN, ...args], { stdio: 'inherit' })
}

/** Split the roster env var on commas and whitespace, dropping empties. */
function roster() {
  return (process.env.DSH_PLUGINS ?? '')
    .split(/[,\s]+/u)
    .map(entry => entry.trim())
    .filter(entry => entry !== '')
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

/** Install every rostered plugin package into the profile. */
function installRoster() {
  const packages = roster()
  if (packages.length === 0) return
  console.log(`entrypoint: installing ${String(packages.length)} plugin package(s) from the registry`)
  const result = dsh(['plugin', '--profile', PROFILE, 'add', ...packages])
  if (result.status !== 0) {
    throw new Error(`entrypoint: plugin install failed with exit ${String(result.status)}`)
  }
}

ensureProfile()
selectContainerBundle()
installRoster()
