#!/bin/sh
# Run every timing and memory measurement on one machine. Implementations are
# interleaved (round-robin) so background load on a shared machine lands on
# each of them alike; bench/summarize.js takes the median across rounds.
#
# Usage: NODE22=... NODE24=... NODE26=... bench/run-all.sh
#   NODEnn point at official Node binaries; bench/build.sh must have run first.
# Results: bench/out/{coldstart,startcpu,load}.jsonl (gitignored).
set -eu
cd "$(dirname "$0")/.."
OUT=bench/out
RUNS=${RUNS:-30}
ROUNDS=${ROUNDS:-3}
CLIENTS=${CLIENTS:-32}
SECONDS_=${SECONDS_:-30}
TS=$PWD/ts/broker.js
SEA=$PWD/ts/dist/broker-sea
GO=$PWD/go/dist/broker-darwin-arm64-stripped
GO_FULL=$PWD/go/dist/broker-darwin-arm64

{ date -u; sysctl -n machdep.cpu.brand_string hw.ncpu hw.memsize; sw_vers -productVersion; uptime; } > $OUT/conditions.txt

node bench/coldstart.js "$RUNS" "$(cat <<EOF
[["go-stripped","$GO"],["go-unstripped","$GO_FULL"],["ts-sea-node26","$SEA"],
 ["ts-node22","$NODE22","$TS"],["ts-node24","$NODE24","$TS"],["ts-node26","$NODE26","$TS"]]
EOF
)" | tee $OUT/coldstart.jsonl

node bench/startcpu.js 20 "$(cat <<EOF
[["go-stripped","$GO"],["go-unstripped","$GO_FULL"],["ts-sea-node26","$SEA"],
 ["ts-node22","$NODE22","$TS"],["ts-node24","$NODE24","$TS"],["ts-node26","$NODE26","$TS"]]
EOF
)" | tee $OUT/startcpu.jsonl

: > $OUT/load.jsonl
round=1
while [ $round -le "$ROUNDS" ]; do
  node bench/load.js direct "$CLIENTS" "$SECONDS_" | tee -a $OUT/load.jsonl
  node bench/load.js go-stripped "$CLIENTS" "$SECONDS_" -- "$GO" | tee -a $OUT/load.jsonl
  node bench/load.js ts-node22 "$CLIENTS" "$SECONDS_" -- "$NODE22" "$TS" | tee -a $OUT/load.jsonl
  node bench/load.js ts-node24 "$CLIENTS" "$SECONDS_" -- "$NODE24" "$TS" | tee -a $OUT/load.jsonl
  node bench/load.js ts-sea-node26 "$CLIENTS" "$SECONDS_" -- "$SEA" | tee -a $OUT/load.jsonl
  GOMAXPROCS=1 node bench/load.js go-stripped-gomaxprocs1 "$CLIENTS" "$SECONDS_" -- "$GO" | tee -a $OUT/load.jsonl
  round=$((round + 1))
done
uptime >> $OUT/conditions.txt
