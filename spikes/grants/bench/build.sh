#!/bin/sh
# Build every artifact the report measures and print their sizes.
#
# Usage: bench/build.sh
#   needs `go` on PATH (the scratch toolchain), and SEA_NODE pointing at an
#   official Node binary that supports --build-sea (Node >= 25.5), and
#   optionally SEA_TARGETS for cross-platform single executables.
# Output goes to go/dist, ts/dist and bench/out, all gitignored.
set -eu
cd "$(dirname "$0")/.."
mkdir -p go/dist ts/dist bench/out
SIZES=bench/out/sizes.txt
: > "$SIZES"

size() { stat -f %z "$1"; }
gz() { gzip -9 -c "$1" | wc -c | tr -d ' '; }
row() { printf '%s\t%s\t%s\n' "$1" "$(size "$2")" "$(gz "$2")" | tee -a "$SIZES"; }

printf 'artifact\tbytes\tgzip -9 bytes\n' | tee -a "$SIZES"

# Go: CGO off so every target is one static file with no libc dependency
# (darwin always links libSystem, which ships with the OS).
(cd go && CGO_ENABLED=0 go build -trimpath -o dist/broker-darwin-arm64 .)
(cd go && CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o dist/broker-darwin-arm64-stripped .)
row go-darwin-arm64 go/dist/broker-darwin-arm64
row go-darwin-arm64-stripped go/dist/broker-darwin-arm64-stripped
for target in darwin/amd64 linux/amd64 linux/arm64 windows/amd64; do
  os=${target%/*}; arch=${target#*/}; ext=; [ "$os" = windows ] && ext=.exe
  (cd go && CGO_ENABLED=0 GOOS=$os GOARCH=$arch go build -trimpath -o "dist/broker-$os-$arch$ext" .)
  (cd go && CGO_ENABLED=0 GOOS=$os GOARCH=$arch go build -trimpath -ldflags='-s -w' -o "dist/broker-$os-$arch-stripped$ext" .)
  row "go-$os-$arch" "go/dist/broker-$os-$arch$ext"
  row "go-$os-$arch-stripped" "go/dist/broker-$os-$arch-stripped$ext"
done

# TS package: what `npm pack` would ship (no install, no registry contact).
(cd ts && npm pack --dry-run --json 2>/dev/null) > bench/out/npm-pack.json
(cd ts && npm pack --pack-destination dist >/dev/null 2>&1)
row ts-npm-tarball "$(ls ts/dist/*.tgz | head -1)"
row ts-broker.js ts/broker.js

# TS single executable: the host Node's own binary plus the script as a blob.
if [ -n "${SEA_NODE:-}" ]; then
  cat > ts/dist/sea-config.json <<EOF
{ "main": "broker.js", "mainFormat": "module", "output": "dist/broker-sea", "disableExperimentalSEAWarning": true }
EOF
  (cd ts && "$SEA_NODE" --build-sea dist/sea-config.json)
  # --build-sea leaves the copied binary's signature invalid on macOS; re-sign ad hoc.
  codesign --sign - --force ts/dist/broker-sea 2>/dev/null
  row ts-sea-darwin-arm64 ts/dist/broker-sea
  row node-binary-used-for-sea "$SEA_NODE"
  # Other targets: the sea config's "executable" names that platform's official
  # node binary, and the host node injects the blob. Built here, not run here.
  # SEA_TARGETS="linux-x64=/path/to/node win-x64=/path/to/node.exe ..."
  for spec in ${SEA_TARGETS:-}; do
    name=${spec%%=*}; exe=${spec#*=}; ext=; case $name in win-*) ext=.exe;; esac
    printf '{ "main": "broker.js", "mainFormat": "module", "output": "dist/broker-sea-%s%s", "executable": "%s", "disableExperimentalSEAWarning": true }\n' \
      "$name" "$ext" "$exe" > "ts/dist/sea-$name.json"
    (cd ts && "$SEA_NODE" --build-sea "dist/sea-$name.json")
    row "ts-sea-$name" "ts/dist/broker-sea-$name$ext"
  done
fi
