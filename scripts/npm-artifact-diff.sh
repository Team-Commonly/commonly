#!/usr/bin/env bash
# Does the tarball this tree would publish differ from one already on npm?
#
#   scripts/npm-artifact-diff.sh <package dir> <published version>
#
# Exit 0: identical apart from package.json's "version". Exit 1: they differ
# (the differing paths are printed). Exit 2: it could not compare. The version
# field is set aside because, since TASK-466, the repo's package.json version is
# only a floor and npm-publish.yml stamps the real one into the tarball.
#
# Used twice: by npm-publish.yml to decide whether main holds anything
# unpublished, and by package-version-guard.yml to prove a published version
# was built from the commit its tag names (#979 / #1017: one version, two
# artifacts).
set -uo pipefail

# Exit 1 means ONLY "compared, and the files differ": the publish job reads it
# as permission to publish. Every step that fails before the comparison is
# finished is a 2, so a broken compare can never pass for a difference.
cannot() { echo "::error::npm-artifact-diff: $*"; exit 2; }

dir=${1:-}; want=${2:-}
[ -n "$dir" ] && [ -n "$want" ] || cannot "usage: npm-artifact-diff.sh <package dir> <published version>"
cd "$dir" || cannot "no such package dir: $dir"
name=$(node -p "require('./package.json').name") || cannot "cannot read $dir/package.json"
work=$(mktemp -d) || cannot "mktemp failed"
trap 'rm -rf -- "${work:?}"' EXIT
mkdir -p "$work/local" "$work/registry" "$work/tgz-local" "$work/tgz-registry" || cannot "cannot create work dirs"

# The cli copies its skill in at prepublishOnly, which `npm pack` does not run.
npm run --silent --if-present prepublishOnly >/dev/null || cannot "prepublishOnly failed in $dir"
npm pack --silent --pack-destination "$work/tgz-local" >/dev/null || cannot "npm pack failed in $dir"
# package-version-guard runs right after npm-publish, and npm can take a few
# minutes to serve a version it has just accepted, so a failed fetch is retried
# (default 10 tries, 30 s apart, about 5 minutes) before it counts as a 2.
attempts=${NPM_FETCH_ATTEMPTS:-10}; delay=${NPM_FETCH_RETRY_DELAY:-30}; try=1
# A bad setting fails at once: `[ -ge ]` on a non-number errors, which would
# keep the loop from ever reaching its last try.
case $attempts in ''|*[!0-9]*|0) cannot "NPM_FETCH_ATTEMPTS must be a whole number of at least 1" ;; esac
case $delay in ''|*[!0-9]*) cannot "NPM_FETCH_RETRY_DELAY must be a whole number of seconds" ;; esac
until ( cd "$work" && npm pack --silent "$name@$want" --pack-destination "$work/tgz-registry" >/dev/null ); do
  [ "$try" -ge "$attempts" ] && cannot "could not fetch $name@$want from npm after $attempts attempts"
  echo "· $name@$want not fetchable yet (try $try of $attempts); retrying in ${delay}s"
  rm -f -- "$work"/tgz-registry/*.tgz
  try=$((try + 1)); sleep "$delay"
done
tar -xzf "$work"/tgz-local/*.tgz -C "$work/local" || cannot "cannot extract the local tarball"
tar -xzf "$work"/tgz-registry/*.tgz -C "$work/registry" || cannot "cannot extract the registry tarball"
for side in local registry; do
  node -e "const f=process.argv[1],j=require(f);j.version='0.0.0';require('fs').writeFileSync(f,JSON.stringify(j,null,2))" "$work/$side/package/package.json" \
    || cannot "cannot normalize the $side package.json"
done
# diff: 0 same, 1 different, anything else trouble (2 = I/O error). Its status
# is taken inside the group, so a redirect that cannot open diff.txt (which
# also returns 1, without running diff) is caught here and never read as
# "different".
rc=
{ diff -rq "$work/local/package" "$work/registry/package"; rc=$?; } >"$work/diff.txt" \
  || cannot "cannot write the diff output"
case "$rc" in
  0) echo "· $name: this tree packs the same files as $want"; exit 0 ;;
  1) echo "· $name: this tree differs from $want:"
     sed 's|'"$work"'/||g' "$work/diff.txt"
     exit 1 ;;
  *) cannot "diff failed (exit $rc) comparing with $want" ;;
esac
