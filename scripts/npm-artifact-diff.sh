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
set -euo pipefail

dir=${1:?package dir}; want=${2:?published version}
cd "$dir"
name=$(node -p "require('./package.json').name")
work=$(mktemp -d)
trap 'rm -rf -- "${work:?}"' EXIT
mkdir -p "$work/local" "$work/registry" "$work/tgz-local" "$work/tgz-registry"

# The cli copies its skill in at prepublishOnly, which `npm pack` does not run.
npm run --silent --if-present prepublishOnly >/dev/null
npm pack --silent --pack-destination "$work/tgz-local" >/dev/null || { echo "::error::npm pack failed in $dir"; exit 2; }
( cd "$work" && npm pack --silent "$name@$want" --pack-destination "$work/tgz-registry" >/dev/null ) \
  || { echo "::error::could not fetch $name@$want from npm"; exit 2; }
tar -xzf "$work"/tgz-local/*.tgz -C "$work/local"
tar -xzf "$work"/tgz-registry/*.tgz -C "$work/registry"
for side in local registry; do
  node -e "const f=process.argv[1],j=require(f);j.version='0.0.0';require('fs').writeFileSync(f,JSON.stringify(j,null,2))" "$work/$side/package/package.json"
done
if diff -rq "$work/local/package" "$work/registry/package" >"$work/diff.txt"; then
  echo "· $name: this tree packs the same files as $want"
  exit 0
fi
echo "· $name: this tree differs from $want:"
sed 's|'"$work"'/||g' "$work/diff.txt"
exit 1
