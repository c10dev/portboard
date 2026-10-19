#!/bin/sh
# One-command deploy (test → restart → smoke checks → push, rollback on failure). Logic: scripts/deploy.ts.
# exec, so the shell never reads this file again after a rollback checks out another tree.
exec node "$(dirname "$0")/deploy.ts" "$@"
