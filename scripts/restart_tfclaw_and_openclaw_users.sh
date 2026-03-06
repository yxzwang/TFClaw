#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SCIHARNESS_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
exec "${SCIHARNESS_ROOT}/restart_tfclaw_and_openclaw_users.sh" "$@"
