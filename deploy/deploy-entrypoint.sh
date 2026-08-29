#!/bin/sh
# Container entrypoint: prepare the profile, then hand PID 1 to the harness.
#
# `exec` matters — the harness must receive the container's stop signal
# directly so its bounded shutdown runs instead of being killed after the
# grace period.
set -e

node /usr/local/bin/prepare-profile.mjs

exec node "${DSH_BIN}" --profile "${DSH_PROFILE}" --no-open "$@"
