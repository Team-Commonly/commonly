#!/usr/bin/env bash
# Demo health capstone. Single command to assert the demo account is in
# a reviewer-ready state end-to-end. Wraps:
#
#   1. reset-demo-account.sh — clean residue + run smoke
#   2. (optional) reviewer-journey.spec.ts — 9-beat Playwright walkthrough
#      against the deployed instance. Only runs when DEMO_TOKEN +
#      DEMO_BASE_URL are exported AND playwright is on PATH (or
#      installable via `npx playwright`).
#
# Exits non-zero if ANY phase fails. Pipe-safe — phases are sequential
# so a failure in (1) halts before (2).
#
# Usage:
#   bash scripts/verify-demo.sh                # reset + smoke only
#   DEMO_TOKEN=eyJ... DEMO_BASE_URL=https://app-dev.commonly.me \
#     DEMO_POD=69f841a9063269526de0437c \
#     bash scripts/verify-demo.sh              # also run reviewer-journey
#
# Output: phase-by-phase status with a final OK / FAIL summary.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
banner() { printf "\n\033[1m==== %s ====\033[0m\n" "$1"; }
ok()     { printf "[\033[32mOK\033[0m] %s\n" "$1"; }
err()    { printf "[\033[31mFAIL\033[0m] %s\n" "$1"; }

PHASES_RUN=0
PHASES_FAIL=0

# Phase 1: reset + smoke (always runs)
banner "Phase 1 — reset-to-baseline + smoke"
PHASES_RUN=$((PHASES_RUN+1))
if bash "$SCRIPT_DIR/reset-demo-account.sh"; then
  ok "reset + smoke green"
else
  err "reset or smoke red"
  PHASES_FAIL=$((PHASES_FAIL+1))
fi

# Phase 2: optional Playwright reviewer-journey
banner "Phase 2 — reviewer-journey (Playwright, optional)"
if [ -n "${DEMO_TOKEN:-}" ] && [ -n "${DEMO_BASE_URL:-}" ]; then
  PHASES_RUN=$((PHASES_RUN+1))
  REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
  if [ -d "$REPO_ROOT/node_modules/@playwright/test" ]; then
    PLAYWRIGHT_BIN="npx playwright"
  elif command -v playwright >/dev/null 2>&1; then
    PLAYWRIGHT_BIN="playwright"
  else
    err "playwright not installed locally — run 'npm i -D @playwright/test' at repo root, or skip this phase"
    PHASES_FAIL=$((PHASES_FAIL+1))
    PLAYWRIGHT_BIN=""
  fi
  if [ -n "$PLAYWRIGHT_BIN" ]; then
    cd "$REPO_ROOT"
    # Pass through DEMO_TOKEN + DEMO_BASE_URL; the spec itself reads them.
    if $PLAYWRIGHT_BIN test e2e/reviewer-journey.spec.ts --reporter=line; then
      ok "reviewer-journey 9 beats green"
    else
      err "reviewer-journey had red beats"
      PHASES_FAIL=$((PHASES_FAIL+1))
    fi
  fi
else
  echo "[skip] DEMO_TOKEN or DEMO_BASE_URL not set — Playwright phase skipped."
  echo "[skip]   To enable: export DEMO_TOKEN + DEMO_BASE_URL (and DEMO_POD)."
fi

banner "Summary"
if [ "$PHASES_FAIL" -eq 0 ]; then
  ok "$PHASES_RUN/$PHASES_RUN phases green — demo is reviewer-ready"
  exit 0
else
  err "$PHASES_FAIL/$PHASES_RUN phase(s) red"
  exit 1
fi
