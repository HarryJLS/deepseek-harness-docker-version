/**
 * `@deepseek-ai/dsh-bundle-docker` — the container-deployment layer as a
 * profile bundle. The package's substance is `cordis.patch.yml`, declared by
 * the `dsh.bundle.patch` manifest field and resolved by the profile composer
 * through that field; this module carries no runtime API.
 *
 * The manifest's `dependencies` are load-bearing rather than incidental: the
 * Loader resolves a row's plugin module from the profile directory, so every
 * package this patch names must be reachable as a dependency of some bundle
 * the profile lists. A plugin added here without its dependency entry fails
 * boot with a module-resolution error.
 *
 * @module @deepseek-ai/dsh-bundle-docker
 */

export {}
