#!/bin/sh
# The only thing Deploy Staging can run on the VM (docs/deployment/vm-staging.md).
#
# Installed root-owned as /usr/local/sbin/commonly-staging-ci. The CI user's
# authorized_keys line forces `sudo /usr/local/sbin/commonly-staging-ci`, and
# sudoers lets that user run this one file and nothing else, so the CI key can
# do exactly what the cases below allow, with the command it asked for in
# SSH_ORIGINAL_COMMAND:
#
#   up <40-hex sha>   check out that commit in the staging checkout, but only if
#                     it is on origin/main, then start staging at its image tag
#   journey | down | status
#
# Because `up` refuses anything not on main, a leaked key can only put a main
# commit on staging.
set -eu
umask 022

CHECKOUT=/opt/commonly-staging
REPO=https://github.com/Team-Commonly/commonly.git

# Only the cases below are accepted. The request is split on whitespace (IFS),
# with globbing off, and each word is validated below.
set -f
# shellcheck disable=SC2086
set -- ${SSH_ORIGINAL_COMMAND:-}
set +f

case "${1:-}" in
  up)
    [ $# -eq 2 ] || { echo "usage: up <sha>" >&2; exit 2; }
    printf '%s' "$2" | grep -Eq '^[0-9a-f]{40}$' || { echo "up needs a full 40-character sha" >&2; exit 2; }
    SHA=$2
    git -C "$CHECKOUT" fetch -q "$REPO" main
    git -C "$CHECKOUT" update-ref refs/remotes/origin/main FETCH_HEAD
    git -C "$CHECKOUT" fetch -q "$REPO" "$SHA"
    git -C "$CHECKOUT" merge-base --is-ancestor "$SHA" refs/remotes/origin/main \
      || { echo "$SHA is not on main; refusing" >&2; exit 3; }
    git -C "$CHECKOUT" checkout -q --detach "$SHA"
    exec "$CHECKOUT/deploy/vm/staging/staging.sh" up "$(printf '%s' "$SHA" | cut -c1-8)"
    ;;
  journey|down|status)
    [ $# -eq 1 ] || { echo "usage: $1" >&2; exit 2; }
    exec "$CHECKOUT/deploy/vm/staging/staging.sh" "$1"
    ;;
  *)
    echo "allowed: up <sha> | journey | down | status" >&2
    exit 2
    ;;
esac
