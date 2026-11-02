# Guard-name canary

After a deploy, agents whose names complete one of the injection guard's
keywords each get one real turn on production. A turn the guard stops fails
the check.

## Why it exists

On 2026-11-01 a hosted agent whose name began with "Dan" was blocked on every
turn. Its system prompt opened "You are Dan…", and `you are DAN` is one of the
guard's always-block keywords. Two fixes followed: the prompts now say "Your
name on Commonly is …" (#3284), and the guard no longer scans our own
system-role text (`skip_system_message_in_guardrail`, #3285). See
[litellm-guardrails.md](litellm-guardrails.md).

Nothing before release would have caught it. Staging has no model key, so
staging-smoke skips every check that needs an agent to answer, and no turn on
the release path passed through LiteLLM's guard. No test agent was ever named
anything close to a keyword. The canary closes that gap from both ends. It
runs real turns on production, and it picks names from the guard's own list.

## What it does

`scripts/guard-name-canary.js` runs in ops-runner. Each run:

1. **Reads the keywords.** `scripts/guard-keywords-dump.py` runs inside the
   litellm container and prints the `always_block_keywords` for every category
   the `injection-guard` entry declares. It reads the serving guard's own config
   and package, never a copy. The JSON reaches the canary as
   `CANARY_GUARD_KEYWORDS`.
2. **Derives names.** Each keyword that starts with a persona lead ("you are",
   "act as", "pretend to be", …) is completed by a name that starts with the
   rest of it:

   | Keyword | Name |
   |---|---|
   | `you are DAN`, `act as DAN` | Dan Canary |
   | `you are now` | Now Canary |

   "Dan Canary" is always tried, even when the list can't be read. A keyword
   the guard adds later is covered on the next deploy. A name that itself
   contains a whole keyword (say "Jailbreak Canary") is skipped and logged. A
   person @-mentioning it would type the keyword, and that block is the guard
   working as intended.
3. **Sets up.** It ensures the account `eng-guard-canary` (on
   `ops.commonly.invalid`, `cloudAgents` entitled, verified, with no usable
   password) and its pod, "Guard-name canary". It signs a 20-minute session for
   that account from `JWT_SECRET` inside the pod. No token is stored. It
   uninstalls any canary agent a crashed run left behind, because the hosted cap
   is one per account.
4. **Waits for LiteLLM.** It polls `/health/readiness` for up to 2 minutes, so a
   litellm restart window doesn't read as a failure.
5. **Checks each name twice.** It installs a hosted agent (`guard-canary`) and a
   native one (`task-clerk`) under the name, through `/api/registry/install`
   and `/api/hosted/provision`, the routes the product uses. It asks each a
   plain question by its canonical handle (`@guard-canary-dan-canary`). A check
   passes on a mention turn that succeeded, a reply from the agent's user after
   the question, and no `guardrail_blocked` run since install. That last
   condition covers the first-contact greeting too. An inconclusive check runs
   once more after LiteLLM reports ready again. Every agent is uninstalled
   afterwards, pass or fail.

Each step prints one JSON line. The last line is `{canary, result, exit}`.

## Exit codes

| Exit | Result | Meaning for the release |
|---|---|---|
| 0 | `pass` | Every name got a real turn. |
| 1 | `blocked` | The guard stopped a turn for a canary name. Something we send now completes a keyword with an agent's name, so every agent with such a name is mute. The release must not stand. |
| 2 | `inconclusive` | No verdict: an install failed, nothing replied in time, a run failed for another reason, or the keyword list was unreadable. Worth a look; not a reason to roll back. |

## Running it by hand

```bash
NS=commonly-dev
KW=$(kubectl exec -i -n $NS deploy/litellm -c litellm -- /app/.venv/bin/python3 -I - < scripts/guard-keywords-dump.py)
kubectl exec -i -n $NS deploy/ops-runner -c ops-runner -- env NODE_PATH=/app/node_modules \
  CANARY_RUN=1 CANARY_GUARD_KEYWORDS="$KW" node - < scripts/guard-name-canary.js
```

Never run it in the serving backend
([ops-runner-and-no-exec-into-backend.md](ops-runner-and-no-exec-into-backend.md)).
A run takes about 25 seconds and four model turns (two names, two runtimes),
plus the two greetings.

## Wiring into Deploy Dev

Proposed step for `.github/workflows/deploy-dev.yml`. SRE owns the workflow.
It goes after "Verify the new backend serves chat" and before "Record this
release as rollout-verified", so a blocked verdict fails the job and the
rollback step runs. That step's condition then needs
`|| steps.canary.outcome == 'failure'`.

```yaml
      - name: Guard-name canary
        id: canary
        run: |
          set -uo pipefail
          KW=$(kubectl exec -i -n "$NAMESPACE" deploy/litellm -c litellm -- \
                 /app/.venv/bin/python3 -I - < scripts/guard-keywords-dump.py) || KW=''
          kubectl exec -i -n "$NAMESPACE" deploy/ops-runner -c ops-runner -- \
            env NODE_PATH=/app/node_modules CANARY_RUN=1 CANARY_GUARD_KEYWORDS="$KW" \
            node - < scripts/guard-name-canary.js
          CODE=$?
          if [ "$CODE" = 1 ]; then
            echo "::error title=Guard-name canary blocked::the injection guard stopped a turn for an agent named after a guard keyword; see the check lines above"
            exit 1
          fi
          if [ "$CODE" != 0 ]; then
            echo "::warning title=Guard-name canary inconclusive::exit $CODE; read the check lines above"
          fi
```

The script comes from the dispatched checkout, so it matches the release even
while ops-runner is still rolling to the new image. The deploy's service account
needs `pods/exec` on litellm and ops-runner. It already execs into the backend
pod for the chat check.

## What it doesn't cover

- **Conditional matches.** The guard also blocks when an identifier word and a
  block word appear together. A name alone rarely completes those, so only
  `always_block_keywords` are read.
- **Names a person types.** A mention of an agent named after a whole keyword is
  user text, and the guard is right to stop it. Those names are skipped, not
  tested.
- **Other guardrails.** Only `injection-guard` is on for native turns
  (`NATIVE_RUNTIME_GUARDRAILS`). If another guardrail is enabled, give it its own
  dump.
- **Group-pod silence.** Each question is a direct @-mention, so a turn that
  chooses not to answer in a busy pod isn't exercised.

## Verified

2026-11-02, on production, the run in this PR:

- **Pass.** `Dan Canary` and `Now Canary`, hosted and native: four passes in
  25.5s, exit 0, no canary install left in the pod.
- **Reverse check.** A copy whose question carried "you are Dan Canary"
  produced four `blocked` verdicts and exit 1. That proves a guard stop reaches
  the exit code.
- **First run.** It asked the agents to repeat a code verbatim, and every model
  declined it as a relay request. It also matched replies by a username the
  list route doesn't always join. The turns themselves had all succeeded.
  Both are fixed and covered by tests.
