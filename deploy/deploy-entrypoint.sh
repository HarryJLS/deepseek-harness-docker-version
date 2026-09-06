#!/bin/sh
# Container entrypoint: prepare the profile, then hand PID 1 to the harness.
#
# `exec` matters — the harness must receive the container's stop signal
# directly so its bounded shutdown runs instead of being killed after the
# grace period.
set -e

node /usr/local/bin/prepare-profile.mjs

# The application name is declared in the Nacos settings entry, which only the
# preparation step above can read. A variable it exports cannot reach a sibling
# process, so it writes the resolved value here and this shell sources it into
# the environment the harness inherits.
DSH_RESOLVED_ENV="${DSH_RESOLVED_ENV:-/run/dsh-resolved.env}"
. "${DSH_RESOLVED_ENV}"

exec node "${DSH_BIN}" --profile "${DSH_PROFILE}" --no-open "$@"
