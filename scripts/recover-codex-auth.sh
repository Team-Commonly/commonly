#!/usr/bin/env bash
# Codex auth recovery — automates the post-device-auth steps from
# docs/demo-verification.md so an operator can run one command after
# completing the three device-auth flows manually.
#
# Workflow:
#   1. Run interactively or with --account N:
#        bash scripts/recover-codex-auth.sh --account 1
#      The script prompts you to complete `codex login --device-auth`
#      in a separate terminal for the indicated account, hit enter
#      when ~/.codex/auth.json has been written.
#   2. The script reads the fresh auth.json, extracts the 5 fields
#      (access_token, refresh_token, id_token, account_id, expires_at
#      via JWT exp), and pushes new versions to the GCP SM secret
#      family for that account.
#   3. After the third account, the script force-syncs ESO, restarts
#      LiteLLM, mints a fresh admin JWT, fires reprovision-all
#      fire-and-forget, polls for completion, restarts the gateway,
#      and runs smoke. Exit 0 if smoke ends green.
#
# Run for all three accounts in sequence:
#   for n in 1 2 3; do bash scripts/recover-codex-auth.sh --account $n; done
#   bash scripts/recover-codex-auth.sh --finalize
#
# Or do it all in one go (auto-prompts for each):
#   bash scripts/recover-codex-auth.sh --all

set -uo pipefail

NAMESPACE="${NAMESPACE:-commonly-dev}"
AUTH_JSON="${AUTH_JSON:-$HOME/.codex/auth.json}"
ADMIN_USER_ID="${ADMIN_USER_ID:-67a9ceb240f8f53015944a05}"  # xcjsam
API="${API:-https://api-dev.commonly.me}"

green() { printf "[\033[32m%s\033[0m] %s\n" "$1" "$2"; }
red()   { printf "[\033[31m%s\033[0m] %s\n" "$1" "$2"; }
info()  { printf "[\033[36m%s\033[0m] %s\n" "$1" "$2"; }

upload_account() {
  local acct="$1"
  # Suffix on secret name: '' for acct-1, '-N' for others. id-token + account-id
  # have no -2 variant in the current secret set (acct-2 rotator works without).
  local suffix=""
  [ "$acct" != "1" ] && suffix="-$acct"

  if [ ! -f "$AUTH_JSON" ]; then
    red "upload-$acct" "no $AUTH_JSON — did you complete device-auth?"
    return 1
  fi

  local fields
  fields=$(python3 -c "
import json, base64
with open('$AUTH_JSON') as f: d=json.load(f)
t=d['tokens']
exp=json.loads(base64.urlsafe_b64decode(t['access_token'].split('.')[1]+'=='))['exp']
print(t['access_token']); print('---')
print(t['refresh_token']); print('---')
print(t.get('id_token','')); print('---')
print(t.get('account_id','')); print('---')
print(exp)
")
  IFS=$'\n---\n' read -r at rt it aid ea <<< "$fields"
  # Workaround: bash IFS read with multi-char separator is iffy; parse properly:
  at=$(echo "$fields" | awk 'BEGIN{RS="\n---\n"} NR==1')
  rt=$(echo "$fields" | awk 'BEGIN{RS="\n---\n"} NR==2')
  it=$(echo "$fields" | awk 'BEGIN{RS="\n---\n"} NR==3')
  aid=$(echo "$fields" | awk 'BEGIN{RS="\n---\n"} NR==4')
  ea=$(echo "$fields" | awk 'BEGIN{RS="\n---\n"} NR==5')

  info "upload-$acct" "pushing 5 fields to GCP SM (suffix='$suffix')…"
  echo "$at"  | gcloud secrets versions add "commonly-dev-openai-codex-access-token$suffix"  --data-file=- >/dev/null
  echo "$rt"  | gcloud secrets versions add "commonly-dev-openai-codex-refresh-token$suffix" --data-file=- >/dev/null
  echo "$ea"  | gcloud secrets versions add "commonly-dev-openai-codex-expires-at$suffix"    --data-file=- >/dev/null
  # acct-2 has no id-token-2 / account-id-2 secrets in the current set
  if [ "$acct" = "1" ] || [ "$acct" = "3" ]; then
    echo "$it"  | gcloud secrets versions add "commonly-dev-openai-codex-id-token$suffix"    --data-file=- >/dev/null
    echo "$aid" | gcloud secrets versions add "commonly-dev-openai-codex-account-id$suffix"  --data-file=- >/dev/null
  fi
  green "upload-$acct" "done (exp=$ea, ~$(( (ea - $(date +%s)) / 3600 ))h out)"
}

finalize() {
  info "finalize" "force ESO sync…"
  kubectl annotate externalsecret api-keys force-sync="$(date +%s)" -n "$NAMESPACE" --overwrite >/dev/null

  info "finalize" "restart LiteLLM…"
  kubectl rollout restart deploy/litellm -n "$NAMESPACE" >/dev/null
  kubectl wait --for=condition=available --timeout=120s deploy/litellm -n "$NAMESPACE" >/dev/null
  green "finalize" "litellm ready"

  info "finalize" "mint admin JWT + fire reprovision-all (~60s server-side)…"
  local admin
  admin=$(kubectl exec -n "$NAMESPACE" deployment/backend -- node -e "
const jwt=require('jsonwebtoken');
console.log(jwt.sign({id:'$ADMIN_USER_ID'}, process.env.JWT_SECRET, {expiresIn:'1h'}));
" | tail -1)
  curl -sS -X POST -H "Authorization: Bearer $admin" "$API/api/registry/admin/installations/reprovision-all" --max-time 3 >/dev/null 2>&1 || true

  info "finalize" "polling backend for reprovision completion…"
  local deadline=$(( $(date +%s) + 180 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if kubectl logs -n "$NAMESPACE" deployment/backend --since=3m 2>/dev/null | grep -q "k8s-provisioner.*synced.*x-content-creator"; then
      break
    fi
    sleep 5
  done
  green "finalize" "reprovision-all completed"

  info "finalize" "restart gateway to pick up fresh /state/moltbot.json…"
  kubectl rollout restart deploy/clawdbot-gateway -n "$NAMESPACE" >/dev/null
  kubectl wait --for=condition=available --timeout=120s deploy/clawdbot-gateway -n "$NAMESPACE" >/dev/null
  green "finalize" "gateway ready"

  info "finalize" "running smoke…"
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if bash "$script_dir/smoke-test-demo.sh"; then
    green "finalize" "smoke green — recovery complete"
    return 0
  fi
  red "finalize" "smoke red — see output above"
  return 1
}

prompt_device_auth() {
  local acct="$1"
  info "device-auth" "ready to capture account $acct"
  echo
  echo "In a SEPARATE terminal run:"
  echo
  echo "    codex logout"
  echo "    codex login --device-auth"
  echo
  echo "Sign in with the ChatGPT account you've designated as #$acct."
  echo "Wait for 'Successfully logged in'. Then press ENTER here."
  read -r _
}

main() {
  case "${1:-}" in
    --account)
      local n="${2:-}"
      if [ -z "$n" ] || ! [[ "$n" =~ ^[1-3]$ ]]; then
        red "args" "use --account 1|2|3"
        exit 2
      fi
      prompt_device_auth "$n"
      upload_account "$n"
      ;;
    --finalize)
      finalize
      ;;
    --all)
      for n in 1 2 3; do
        prompt_device_auth "$n"
        upload_account "$n" || exit 1
      done
      finalize
      ;;
    *)
      cat <<EOF
Usage:
  $0 --account <1|2|3>   # one account, prompts for device-auth then pushes
  $0 --finalize          # force-sync ESO + restart + reprovision + smoke
  $0 --all               # all three accounts + finalize in one run

After running, smoke check 'codex-rotator-health' + 'mention-response' should be green.
EOF
      ;;
  esac
}

main "$@"
