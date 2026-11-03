/**
 * Latchkey hosted-MCP entry (TASK-330, F07). Latchkey runs CI for coding agents;
 * its MCP server takes a bearer `lk_live_` API key, so this is an operator-key
 * entry: no issuer, client or scopes, and the key's own reach (read-only by
 * default, dispatch opt-in) is chosen when it is created in Latchkey's dashboard.
 *
 * Pinned from a tools/list taken with the walk key at 2026-11-03T20:00:22.871Z
 * (fixtures/hostedMcp/latchkey-tools-list-2026-11-03.json). Latchkey annotated
 * none of its 19 tools on 11-01 and all 22 on 11-03, so each read is pinned on
 * the vendor's own readOnlyHint and each write is class `write`, which the
 * broker parks for the key owner's approval. apply_migration is not pinned:
 * operator-key intake refuses a key carrying migration:apply. Starting or
 * cancelling compute is marked irreversible, so it parks even on a write grant.
 * The dashboard is the management page the vendor's MCP manifest declares
 * (latchkey.dev/.well-known/mcp/manifest.json); there is no revocation endpoint.
 */
import type { HostedMcpEntry } from '../../services/hostedMcpEntryService';

export const LATCHKEY_ENTRY: HostedMcpEntry = {
  id: 'latchkey',
  title: 'Latchkey',
  description: 'CI runs, failure context and jobs in your Latchkey workspace.',
  connectNotice: 'Create a key in Latchkey under Settings, API keys and agents. A default key only reads; '
    + 'turn on dispatch for the tools that start or cancel runs.',
  credentialMode: 'operator_key',
  resource: 'https://latchkey.dev/mcp',
  accessPage: 'https://latchkey.dev/dashboard',
  revoke: { page: 'https://latchkey.dev/dashboard' },
  tools: [
    {
      name: 'list_failed_runs',
      upstreamName: 'list_failed_runs',
      description: "List CI runs on Latchkey runners that self-heal could not fix.",
      class: 'read',
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        properties: {
          repository: {
            description: "Restrict to one repository, in \"owner/repo\" form.",
            type: "string",
          },
          verdict: {
            description: "Restrict by self-heal verdict: \"passthrough\" = self-heal judged it a real code issue and did not touch it; \"heal\" = self-heal tried a fix (these are surfaced only when the fix did not work).",
            type: "string",
            enum: [
              "heal",
              "passthrough",
              "unknown",
            ],
          },
          since: {
            description: "ISO 8601 timestamp; only runs decided at or after this time.",
            type: "string",
          },
          limit: {
            description: "Maximum runs to return (default 20).",
            type: "integer",
            minimum: 1,
            maximum: 100,
          },
          include_diagnosis: {
            description: "Add exit_code, root_cause and failing_file to each entry, so you can tell what broke without fetching a bundle per run. One extra batched query. Null on a run with no recorded diagnosis (a deterministic passthrough has none). Default false.",
            type: "boolean",
          },
        },
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'get_failure_bundle',
      upstreamName: 'get_failure_bundle',
      description: "Read the full failure context of one failed run: what self-heal decided and the error output.",
      class: 'read',
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        properties: {
          attempt_id: {
            description: "The attempt_id of a run from list_failed_runs.",
            type: "string",
          },
        },
        required: [
          "attempt_id",
        ],
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'list_heals',
      upstreamName: 'list_heals',
      description: "List this workspace's self-heal records and their outcomes.",
      class: 'read',
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        properties: {
          since: {
            description: "ISO 8601 timestamp; only heals decided at or after this time.",
            type: "string",
          },
          until: {
            description: "ISO 8601 timestamp; only heals decided at or before this time.",
            type: "string",
          },
          repository: {
            description: "Restrict to one repository, in \"owner/repo\" form.",
            type: "string",
          },
          outcome: {
            description: "Restrict to one outcome: \"fixed\", \"failed\" or \"passthrough\".",
            type: "string",
            enum: [
              "fixed",
              "failed",
              "passthrough",
            ],
          },
          limit: {
            description: "Maximum heals to return (default 20).",
            type: "integer",
            minimum: 1,
            maximum: 100,
          },
          cursor: {
            description: "The next_cursor of an earlier answer, to read the next page.",
            type: "string",
          },
        },
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'get_heal',
      upstreamName: 'get_heal',
      description: "Read one self-heal record in full.",
      class: 'read',
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        properties: {
          attempt_id: {
            description: "The attempt_id of a heal from list_heals or list_failed_runs, or from heals on get_job_status.",
            type: "string",
          },
        },
        required: [
          "attempt_id",
        ],
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'dispatch_workflow',
      upstreamName: 'dispatch_workflow',
      description: "Start a GitHub Actions workflow run in one of this organization's monitored repositories.",
      class: 'write',
      irreversible: true,
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        properties: {
          repo: {
            description: "Repository in \"owner/repo\" form. Must be monitored by this organization.",
            type: "string",
          },
          workflow_file: {
            description: "The workflow file name under .github/workflows, e.g. \"ci.yml\". The workflow must declare the workflow_dispatch trigger.",
            type: "string",
          },
          ref: {
            description: "The branch or tag to run on, e.g. \"main\".",
            type: "string",
          },
          inputs: {
            description: "Optional workflow_dispatch inputs, as declared by the workflow.",
            type: "object",
            propertyNames: {
              type: "string",
            },
            additionalProperties: {
              type: "string",
            },
          },
        },
        required: [
          "repo",
          "workflow_file",
          "ref",
        ],
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    {
      name: 'run_workflow',
      upstreamName: 'run_workflow',
      description: "Start a run of one Latchkey CI workflow file on a branch or tag.",
      class: 'write',
      irreversible: true,
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        properties: {
          repo: {
            description: "Repository in \"owner/repo\" form, connected to Latchkey CI in this workspace.",
            type: "string",
          },
          workflow: {
            description: "The workflow file, e.g. \"deploy.yml\" or \".latchkey/workflows/deploy.yml\".",
            type: "string",
            minLength: 1,
          },
          ref: {
            description: "The branch or tag to run at. A name that is both is the branch: send refs/tags/<name> for the tag. Default: the repository's default branch.",
            type: "string",
          },
          inputs: {
            description: "The values of the inputs the file declares, each as text.",
            type: "object",
            propertyNames: {
              type: "string",
            },
            additionalProperties: {
              type: "string",
            },
          },
          op_id: {
            description: "Optional, 1 to 64 letters, digits, - or _. To retry a start without starting a second run, send the same op_id with repo, workflow, ref and inputs as first sent. Any change to them starts a run of its own.",
            type: "string",
            pattern: "^[A-Za-z0-9_-]{1,64}$",
          },
        },
        required: [
          "repo",
          "workflow",
        ],
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    {
      name: 'get_run_status',
      upstreamName: 'get_run_status',
      description: "Read the status and conclusion of one run.",
      class: 'read',
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        properties: {
          repo: {
            description: "Repository in \"owner/repo\" form: the repository the run belongs to. For a GitHub Actions run id it must be monitored by this workspace.",
            type: "string",
          },
          run_id: {
            description: "A Latchkey run id (lkrun-...), or a GitHub Actions run id: numeric, \"run-<id>\", or a full Actions run URL.",
            type: "string",
          },
          attempt: {
            description: "Optional, with a Latchkey run id only: the attempt to read, from 1 to the run's latest attempt. Omitted, the answer lists the latest attempt.",
            type: "integer",
            minimum: 1,
            maximum: 9007199254740991,
          },
        },
        required: [
          "repo",
          "run_id",
        ],
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'tail_run_logs',
      upstreamName: 'tail_run_logs',
      description: "Read the last log lines of one job in a completed run.",
      class: 'read',
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        properties: {
          repo: {
            description: "Repository in \"owner/repo\" form. Must be monitored by this organization.",
            type: "string",
          },
          run_id: {
            description: "The GitHub Actions run id — numeric, \"run-<id>\", or a full Actions run URL.",
            type: "string",
          },
          job_name: {
            description: "Which job to read. Defaults to the first failed job, else the first job.",
            type: "string",
          },
        },
        required: [
          "repo",
          "run_id",
        ],
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'run_job',
      upstreamName: 'run_job',
      description: "Run one shell command on a fresh Latchkey runner. It is billed compute.",
      class: 'write',
      irreversible: true,
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        properties: {
          command: {
            description: "The shell command to run, e.g. \"node --version\". Runs via bash on the runner.",
            type: "string",
          },
          runner_size: {
            description: "Runner size tier (default small).",
            type: "string",
            enum: [
              "small",
              "medium",
              "large",
              "xlarge",
            ],
          },
          env: {
            description: "Environment variables for the command. Names must not start with LATCHKEY_, and values must not contain a NUL byte.",
            type: "object",
            propertyNames: {
              type: "string",
            },
            additionalProperties: {
              type: "string",
            },
          },
          timeout_seconds: {
            description: "Kill the job after this many seconds, between 30 and 10800 (default 1800).",
            type: "integer",
            minimum: -9007199254740991,
            maximum: 9007199254740991,
          },
          batch: {
            description: "Batch this job belongs to: a name of 1 to 64 characters that groups the jobs of one piece of work. Shown on the job and kept on its billing row. A batch name cannot hold / or %, and cannot be . or .. alone.",
            type: "string",
          },
          budget_usd: {
            description: "Stop the job once it has cost this many US dollars at its size's list rate, counted in whole minutes from when the command starts, with at most two decimal places. A budget too small for one minute on the size is refused. No default.",
            type: "number",
          },
        },
        required: [
          "command",
        ],
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    {
      name: 'set_batch_budget',
      upstreamName: 'set_batch_budget',
      description: "Set or lower the dollar budget of a batch of jobs.",
      class: 'write',
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        properties: {
          batch: {
            description: "The batch to budget: the name of 1 to 64 characters its jobs are created with, matched exactly. A batch name cannot hold / or %, and cannot be . or .. alone.",
            type: "string",
          },
          budget_usd: {
            description: "The batch's budget in US dollars with at most two decimal places. Refused when it is above the batch's current budget.",
            type: "number",
          },
          max_concurrent: {
            description: "How many of the batch's jobs may run at once, a whole number from 1 to 1000. The batch's other jobs wait in the queue, and their status says why. Refused when it is above the batch's current limit. Left out, the batch keeps the limit it has.",
            type: "number",
          },
        },
        required: [
          "batch",
          "budget_usd",
        ],
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    {
      name: 'list_jobs',
      upstreamName: 'list_jobs',
      description: "List this workspace's jobs, newest first.",
      class: 'read',
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        properties: {
          state: {
            description: "Which jobs to list: \"active\" for every job that is queued, provisioning or running, or \"all\" for the newest jobs in any state. Default \"all\".",
            type: "string",
            enum: [
              "active",
              "all",
            ],
          },
          limit: {
            description: "How many jobs to return with state \"all\", between 1 and 100 (default 20). Ignored with state \"active\", which returns every active job up to 100.",
            type: "integer",
            minimum: 1,
            maximum: 100,
          },
          batch: {
            description: "Only the jobs created in this batch: the name of 1 to 64 characters its jobs were created with, matched exactly after trimming. A batch name cannot hold / or %, and cannot be . or .. alone.",
            type: "string",
          },
          before: {
            description: "With state \"all\", only the jobs queued before this: the next_before of an earlier answer, a job id, or a time such as 2026-10-19T12:00:00Z. Ignored with state \"active\".",
            type: "string",
          },
        },
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'get_batch',
      upstreamName: 'get_batch',
      description: "Read one batch of jobs: its budget, what it has cost and its jobs.",
      class: 'read',
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        properties: {
          batch: {
            description: "The batch to read: the name of 1 to 64 characters its jobs were created with, matched exactly after trimming. A batch name cannot hold / or %, and cannot be . or .. alone.",
            type: "string",
          },
          limit: {
            description: "How many of its jobs to return, between 1 and 100 (default 20).",
            type: "integer",
            minimum: 1,
            maximum: 100,
          },
          before: {
            description: "Only the jobs queued before this: the next_before of an earlier answer, a job id, or a time such as 2026-10-19T12:00:00Z.",
            type: "string",
          },
        },
        required: [
          "batch",
        ],
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'get_job_status',
      upstreamName: 'get_job_status',
      description: "Read the current state of one job.",
      class: 'read',
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        properties: {
          job_id: {
            description: "The job_id returned by run_job or listed by list_jobs (or the latchkey CLI).",
            type: "string",
            pattern: "^cli-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
          },
        },
        required: [
          "job_id",
        ],
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'get_job_logs',
      upstreamName: 'get_job_logs',
      description: "Read a job's log output in ordered chunks.",
      class: 'read',
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        properties: {
          job_id: {
            description: "The job_id returned by run_job or listed by list_jobs (or the latchkey CLI).",
            type: "string",
            pattern: "^cli-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
          },
          cursor: {
            description: "Where to continue from: the previous response's next_cursor, passed back verbatim (an opaque \"<chunk index>:<offset>\" string). Omit to start at the beginning of the log, or set tail instead to start at its end.",
            anyOf: [
              {
                type: "integer",
                minimum: 0,
                maximum: 9007199254740991,
              },
              {
                type: "string",
                pattern: "^\\d{1,15}(:\\d{1,15})?$",
              },
            ],
          },
          max_bytes: {
            description: "Maximum serialized log bytes to return in one call, between 1000 and 327680 (default 20000). Measured on the emitted result, so escape-heavy output (ANSI colour, newlines) yields fewer characters per call than plain text does. Whole chunks ship while they fit and a chunk too big for the budget is returned clipped. Reading forward, the rest follows next_cursor; with tail, the earliest chunk returned is clipped at its start and the output before it is left out.",
            type: "integer",
            minimum: 1000,
            maximum: 327680,
          },
          tail: {
            description: "Read the end of the log instead of its beginning: returns the latest output, up to max_bytes, and a next_cursor at the end. Pass that cursor back without tail to read only output written since. Cannot be combined with cursor.",
            type: "boolean",
          },
          include_steps: {
            description: "Also return the job's step list, with each step's status and its range of log chunks. Only a job of a workflow file has steps; for a single command the list is null.",
            type: "boolean",
          },
        },
        required: [
          "job_id",
        ],
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'cancel_job',
      upstreamName: 'cancel_job',
      description: "Cancel one queued or running job.",
      class: 'write',
      irreversible: true,
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        properties: {
          job_id: {
            description: "The job_id returned by run_job or listed by list_jobs (or the latchkey CLI).",
            type: "string",
            pattern: "^cli-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
          },
        },
        required: [
          "job_id",
        ],
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    {
      name: 'plan_migration',
      upstreamName: 'plan_migration',
      description: "Propose how a repository's GitHub Actions pipelines would move to Latchkey CI, without changing anything.",
      class: 'read',
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        properties: {
          repository: {
            description: "Repository in \"owner/name\" form, connected to Latchkey CI in this workspace.",
            type: "string",
          },
          answers: {
            description: "Answers to the steps, jobs and changes that need a person, each naming its pipeline by its GitHub Actions file and the item as the plan names it.",
            type: "array",
            items: {
              type: "object",
              properties: {
                pipeline: {
                  description: "The pipeline the item is in: its GitHub Actions file, as the plan gives it in source.",
                  type: "string",
                },
                job: {
                  description: "The id of the job the item is in, as the plan gives it. Leave it out for a change to the whole pipeline.",
                  type: "string",
                },
                step: {
                  description: "The step's number in its job, as the plan gives it in index. Only for an answer to a step.",
                  type: "number",
                },
                at: {
                  description: "Where the change is made, as the plan gives it in at. Only for an answer to a change.",
                  type: "string",
                },
                answer: {
                  description: "One of the answers the plan lists for that item in answers.",
                  type: "string",
                },
                dry_run_command: {
                  description: "For a dry_run answer only: the command Latchkey writes as its own run: step right after the answered step, in that step's directory, under its condition and with its plain variables but none of its secrets, run in its place only while its pipeline is on trial. At most 2,048 characters.",
                  type: "string",
                },
              },
              required: [
                "pipeline",
                "answer",
              ],
            },
          },
          moves: {
            description: "Which pipelines move, one entry for each pipeline whose default you change.",
            type: "array",
            items: {
              type: "object",
              properties: {
                pipeline: {
                  description: "The pipeline: its GitHub Actions file, as the plan gives it in source.",
                  type: "string",
                },
                moves: {
                  description: "True to move the pipeline to Latchkey CI, false to keep it on GitHub Actions.",
                  type: "boolean",
                },
              },
              required: [
                "pipeline",
                "moves",
              ],
            },
          },
        },
        required: [
          "repository",
        ],
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'get_migration',
      upstreamName: 'get_migration',
      description: "Read a repository's newest migration and where its pull request stands.",
      class: 'read',
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        properties: {
          repository: {
            description: "Repository in \"owner/name\" form, connected to Latchkey CI in this workspace.",
            type: "string",
          },
        },
        required: [
          "repository",
        ],
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'list_trial_verdicts',
      upstreamName: 'list_trial_verdicts',
      description: "List how a repository's trial runs compared with GitHub Actions.",
      class: 'read',
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        properties: {
          repository: {
            description: "The repository, as owner/name.",
            type: "string",
          },
          verdict: {
            description: "Only the runs that read this verdict at their latest attempt with one.",
            type: "string",
            enum: [
              "same",
              "fails_only_on_latchkey",
              "fails_only_on_code_host",
              "not_compared",
            ],
          },
          limit: {
            description: "How many runs to return, between 1 and 50 (default 20).",
            type: "integer",
            minimum: 1,
            maximum: 50,
          },
          before: {
            description: "Only the runs older than this: the next_before of an earlier answer.",
            type: "string",
          },
        },
        required: [
          "repository",
        ],
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'list_latchkey_steps',
      upstreamName: 'list_latchkey_steps',
      description: "List the Latchkey steps a workflow file can use, with their versions and inputs.",
      class: 'read',
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        properties: {},
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'list_environments',
      upstreamName: 'list_environments',
      description: "List the branches each environment of a repository accepts and whether its jobs need approval.",
      class: 'read',
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        properties: {
          repository: {
            description: "The repository, as owner/name.",
            type: "string",
          },
        },
        required: [
          "repository",
        ],
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'validate_workflow',
      upstreamName: 'validate_workflow',
      description: "Check a Latchkey workflow file without starting anything.",
      class: 'read',
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        properties: {
          file: {
            description: "The workflow file's whole text, as it would be committed, at most 128 KiB.",
            type: "string",
          },
        },
        required: [
          "file",
        ],
      },
      annotations: { readOnlyHint: true },
    },
  ],
};
