#!/bin/sh
# Render deploy/vm/backend.env, litellm.env and backup.env from the backend and
# litellm Deployments running in a cluster, so the VM gets exactly the env prod
# runs. Run on a machine with kubectl access, then copy the files to the VM
# (they are 0600; keep them that way).
#
#   deploy/vm/render-env-from-k8s.sh --context <kube-context> --namespace <namespace>
#
# Options: --out-dir <dir> (default: this directory), --list-names (print the
# names in each skipped group). Values are never printed, only counts.
# Logic and tests: render_env_from_k8s.py, and
# backend/__tests__/unit/deployment/render_env_from_k8s_test.py.
set -eu
umask 077
command -v kubectl >/dev/null 2>&1 || { echo "kubectl not found" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo "python3 not found" >&2; exit 1; }
exec python3 -I "$(dirname "$0")/render_env_from_k8s.py" "$@"
