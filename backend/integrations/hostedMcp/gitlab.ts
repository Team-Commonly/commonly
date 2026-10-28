/**
 * GitLab.com hosted MCP. Pinned from a consenting tools/list capture at
 * 2026-10-19T07:10:55.663Z against https://gitlab.com/api/v4/mcp.
 * The entry is GitLab.com-specific: a self-managed instance may disable DCR.
 * Tool descriptions are Commonly-authored; schemas and annotations match the capture.
 * Every mutator is classed write; hosted grants use write-with-confirm.
 * Excludes save_merge_request: its description can run GitLab quick actions
 * such as /merge or /close without a schema change or separate card.
 */
import type { HostedMcpEntry } from '../../services/hostedMcpEntryService';

export const GITLAB_ENTRY: HostedMcpEntry = {
  id: 'gitlab',
  title: 'GitLab',
  description: 'Projects, issues and merge requests on GitLab.com.',
  resource: 'https://gitlab.com/api/v4/mcp',
  issuer: 'https://gitlab.com',
  client: 'dcr',
  scopes: ['mcp'],
  revoke: {
    page: 'https://gitlab.com/-/user_settings/applications',
    endpoint: 'https://gitlab.com/oauth/revoke',
  },
  tools: [
    {
      name: 'get_job',
      upstreamName: 'get_job',
      description: 'Read one CI job and optional log.',
      class: 'read',
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "ID or full path of the project",
          },
          job_id: {
            type: "integer",
            description: "ID of the job",
          },
          include: {
            type: "array",
            description: "Facet to include alongside the job, one per call: log or artifacts.",
            items: {
              type: "string",
              enum: [
                "log",
                "artifacts",
              ],
            },
            maxItems: 1,
          },
          byte_offset: {
            type: "integer",
            minimum: 0,
            description: "Byte offset to start reading the job's log from. Only applies when include is log. Default is 0.",
          },
          byte_limit: {
            type: "integer",
            minimum: 1,
            maximum: 512000,
            description: "Maximum number of bytes of the job's log to return. Only applies when include is log. Default and max is 512000.",
          },
        },
        required: [
          "id",
          "job_id",
        ],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: 'accept_merge_request',
      upstreamName: 'accept_merge_request',
      description: 'Merge a merge request or schedule its merge.',
      class: 'write',
      irreversible: true,
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "GitLab URL of the merge request. Provide this, or project_id and merge_request_iid.",
          },
          project_id: {
            type: "string",
            description: "ID or path of the project. Required if url is not provided.",
          },
          merge_request_iid: {
            type: "integer",
            description: "Internal ID of the merge request. Required if url is not provided.",
          },
          sha: {
            type: "string",
            description: "Head SHA guard. When it no longer matches the merge request head, the merge is refused instead of merging content you have not seen. Pass the diff_head_sha returned by get_merge_request.",
          },
          strategy: {
            type: "string",
            enum: [
              "merge_train",
              "add_to_merge_train_when_checks_pass",
              "merge_when_checks_pass",
            ],
            description: "Auto-merge strategy. When given, arms auto-merge instead of merging immediately.",
          },
          squash: {
            type: "boolean",
            description: "Squash the commits into a single commit on merge.",
          },
          commit_message: {
            type: "string",
            description: "Custom merge commit message.",
          },
          squash_commit_message: {
            type: "string",
            description: "Custom squash commit message. Applies when squash is true.",
          },
          should_remove_source_branch: {
            type: "boolean",
            description: "Remove the source branch after merging.",
          },
        },
        required: [
          "sha",
        ],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
      },
    },
    {
      name: 'add_branch',
      upstreamName: 'add_branch',
      description: 'Create a project branch from a source ref.',
      class: 'write',
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "GitLab URL of the project. Provide this, or project_id.",
          },
          project_id: {
            type: "string",
            description: "ID or path of the project. Required if url is not provided.",
          },
          branch: {
            type: "string",
            description: "Name of the new branch",
          },
          ref: {
            type: "string",
            description: "Branch name or commit SHA to create the new branch from",
          },
        },
        required: [
          "branch",
          "ref",
        ],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    {
      name: 'add_commit',
      upstreamName: 'add_commit',
      description: "Commit file actions to a project branch. A commit can start the project's pipeline.",
      class: 'write',
      irreversible: true,
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "GitLab URL of the project. Provide this or project_id.",
          },
          project_id: {
            type: "string",
            description: "ID or path of the project. Provide this or url.",
          },
          branch: {
            type: "string",
            description: "Name of the branch to commit into.",
          },
          start_branch: {
            type: "string",
            description: "Name of the branch from which to create a new branch. Required when branch does not exist yet.",
          },
          start_sha: {
            type: "string",
            description: "SHA of the commit to start a new branch from. Mutually exclusive with start_branch.",
          },
          start_project: {
            type: "string",
            description: "Full path of the project to start the commit from. Must be the project itself or a project it was forked from.",
          },
          commit_message: {
            type: "string",
            description: "Commit message.",
          },
          actions: {
            type: "array",
            description: "File actions to commit as a single batch.",
            minItems: 1,
            maxItems: 100,
            items: {
              type: "object",
              properties: {
                action: {
                  type: "string",
                  enum: [
                    "create",
                    "update",
                    "delete",
                    "move",
                    "chmod",
                  ],
                  description: "Action to perform.",
                },
                file_path: {
                  type: "string",
                  description: "Full path to the file.",
                },
                content: {
                  type: "string",
                  description: "File content for create, update, or move actions. Mutually exclusive with old_str and new_str.",
                },
                old_str: {
                  type: "string",
                  description: "Existing text to replace in an update action. Requires new_str.",
                },
                new_str: {
                  type: "string",
                  description: "Replacement text for old_str in an update action.",
                },
                previous_path: {
                  type: "string",
                  description: "Original file path for a move action.",
                },
                encoding: {
                  type: "string",
                  enum: [
                    "text",
                    "base64",
                  ],
                  description: "Encoding of the file content.",
                },
                last_commit_id: {
                  type: "string",
                  description: "Last commit that touched the file, used for optimistic concurrency.",
                },
                execute_filemode: {
                  type: "boolean",
                  description: "Whether the file is executable.",
                },
              },
              required: [
                "action",
                "file_path",
              ],
              additionalProperties: false,
            },
          },
        },
        required: [
          "branch",
          "commit_message",
          "actions",
        ],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
      },
    },
    {
      name: 'get_commit',
      upstreamName: 'get_commit',
      description: 'Read a commit and optional diff or notes.',
      class: 'read',
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "GitLab URL of the commit. Provide this, or project_id and commit_sha.",
          },
          project_id: {
            type: "string",
            description: "ID or path of the project. Required if url is not provided.",
          },
          commit_sha: {
            type: "string",
            description: "Commit to look up. Accepts a full or short SHA, branch name, or tag name. Required if url is not provided.",
          },
          include: {
            type: "array",
            description: "Associated facet to fetch inline, one per call. \"diff\" returns the commit diff (bounded by diff_detail); \"notes\" returns the commit notes (paginated with notes_after/notes_first).",
            items: {
              type: "string",
              enum: [
                "diff",
                "notes",
              ],
            },
            maxItems: 1,
          },
          diff_detail: {
            type: "string",
            description: "Level of diff detail to return. Applies only when \"diff\" is in include. \"stats\" returns per-file and summary line counts; \"full_patch\" returns the patch text. Defaults to \"stats\".",
            enum: [
              "stats",
              "full_patch",
            ],
          },
          notes_first: {
            type: "integer",
            description: "Number of notes to return after the cursor (forward pagination). Max 100. Applies only when notes is in include.",
            minimum: 1,
            maximum: 100,
          },
          notes_after: {
            type: "string",
            description: "Cursor for forward pagination of notes. Use pageInfo.endCursor from a previous response. Applies only when notes is in include.",
          },
        },
        required: [],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: 'get_merge_request',
      upstreamName: 'get_merge_request',
      description: 'Read a merge request and selected related details.',
      class: 'read',
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "GitLab URL of the merge request. Provide this, or project_id and merge_request_iid.",
          },
          project_id: {
            type: "string",
            description: "ID or path of the project. Required if url is not provided.",
          },
          merge_request_iid: {
            type: "integer",
            description: "Internal ID of the merge request. Required if url is not provided.",
          },
          include: {
            type: "array",
            description: "Associated facets to fetch inline, one per call. diffs returns aggregate change stats and a per-file breakdown by default; set detail=full_patch for raw per-file patch text or detail=none for summary counts only. conflicts returns raw conflict file content (Git conflict markers), only when the merge request cannot be merged and the caller can push to the source branch. diffs, notes, commits, and pipelines support pagination (diffs_*, notes_*, commits_*, pipelines_*); for the newest notes, use notes_last without notes_first or notes_after. approvals returns approved and approvedBy on every tier. approvalsRequired, approvalsLeft, and the rule breakdown in approvalState need GitLab Premium or Ultimate; otherwise these keys are present but zeroed or empty, not omitted.",
            items: {
              type: "string",
              enum: [
                "diffs",
                "commits",
                "notes",
                "pipelines",
                "discussions",
                "approvals",
                "conflicts",
              ],
            },
            maxItems: 1,
          },
          detail: {
            type: "string",
            description: "Level of diff detail, applies only when diffs is in include. none: summary counts only; stats: per-file additions and deletions (default); full_patch: per-file patch text (raw diff), plus the per-file stats.",
            enum: [
              "none",
              "stats",
              "full_patch",
            ],
          },
          diffs_first: {
            type: "integer",
            description: "Number of files to return after the cursor (forward pagination). Max 100. Applies only when diffs is in include and detail is full_patch.",
            minimum: 1,
            maximum: 100,
          },
          diffs_after: {
            type: "string",
            description: "Cursor for forward pagination of files. Use pageInfo.endCursor from a previous response. Applies only when diffs is in include and detail is full_patch.",
          },
          notes_first: {
            type: "integer",
            description: "Number of notes to return after the cursor (forward pagination). Max 100. Applies only when notes is in include.",
            minimum: 1,
            maximum: 100,
          },
          notes_after: {
            type: "string",
            description: "Cursor for forward pagination of notes. Use pageInfo.endCursor from a previous response. Applies only when notes is in include.",
          },
          notes_last: {
            type: "integer",
            description: "Number of notes to return before the cursor (backward pagination). Max 100. Applies only when notes is in include.",
            minimum: 1,
            maximum: 100,
          },
          notes_before: {
            type: "string",
            description: "Cursor for backward pagination of notes. Use pageInfo.startCursor from a previous response. Applies only when notes is in include.",
          },
          commits_first: {
            type: "integer",
            description: "Number of commits to return after the cursor (forward pagination). Max 100. Applies only when commits is in include.",
            minimum: 1,
            maximum: 100,
          },
          commits_after: {
            type: "string",
            description: "Cursor for forward pagination of commits. Use pageInfo.endCursor from a previous response. Applies only when commits is in include.",
          },
          pipelines_first: {
            type: "integer",
            description: "Number of pipelines to return after the cursor (forward pagination). Max 100. Applies only when pipelines is in include.",
            minimum: 1,
            maximum: 100,
          },
          pipelines_after: {
            type: "string",
            description: "Cursor for forward pagination of pipelines. Use pageInfo.endCursor from a previous response. Applies only when pipelines is in include.",
          },
        },
        required: [],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: 'get_repository_file',
      upstreamName: 'get_repository_file',
      description: 'Read one file from a repository at a ref.',
      class: 'read',
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "GitLab URL of the file, for example https://gitlab.com/gitlab-org/gitlab/-/blob/master/app/models/user.rb. Provide this, or project_id, file_path, and ref.",
          },
          project_id: {
            type: "string",
            description: "ID or full path of the project. Required if url is not provided. If url is also provided, both must refer to the same project.",
          },
          file_path: {
            type: "string",
            description: "Path of the file relative to the repository root, for example app/models/user.rb. Required if url is not provided.",
          },
          ref: {
            type: "string",
            description: "Branch name, tag name, or commit SHA. Use HEAD for the default branch. Required if url is not provided.",
          },
          offset: {
            type: "integer",
            description: "Zero-indexed line number to start reading from. Omit to start at the beginning of the file.",
            minimum: 0,
          },
          limit: {
            type: "integer",
            description: "Maximum number of lines to return. The maximum is 2000.",
            minimum: 1,
            maximum: 2000,
          },
        },
        required: [],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: 'get_pipeline',
      upstreamName: 'get_pipeline',
      description: 'Read one pipeline and selected related details.',
      class: 'read',
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "ID or full path of the project",
          },
          pipeline_id: {
            type: "integer",
            description: "ID of the pipeline",
          },
          include: {
            type: "array",
            description: "Facet to include alongside the pipeline, one per call: jobs, downstream_pipelines, bridge_jobs, or artifacts.",
            items: {
              type: "string",
              enum: [
                "jobs",
                "downstream_pipelines",
                "bridge_jobs",
                "artifacts",
              ],
            },
            maxItems: 1,
          },
          job_status: {
            type: "string",
            enum: [
              "created",
              "waiting_for_resource",
              "preparing",
              "waiting_for_callback",
              "pending",
              "running",
              "success",
              "failed",
              "canceling",
              "canceled",
              "skipped",
              "manual",
              "scheduled",
            ],
            description: "Filters the jobs facet by status (for example, failed). Only applies when include is jobs.",
          },
          first: {
            type: "integer",
            description: "Number of items for the selected include facet to return after the cursor (forward pagination). Max 100.",
            minimum: 1,
            maximum: 100,
          },
          after: {
            type: "string",
            description: "Cursor for forward pagination of items for the selected include facet. Use page_info.end_cursor from a previous response.",
          },
        },
        required: [
          "id",
          "pipeline_id",
        ],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: 'get_project',
      upstreamName: 'get_project',
      description: 'Read metadata for one GitLab project.',
      class: 'read',
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "GitLab URL of the project.",
          },
          project_id: {
            type: "string",
            description: "Project ID or full path. Provide exactly one of url or project_id.",
          },
        },
        required: [],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: 'get_user',
      upstreamName: 'get_user',
      description: 'Get a GitLab user by username or numeric id, or the connected account with me. Provide exactly one of username, id, or me.',
      class: 'read',
      inputSchema: {
        type: "object",
        properties: {
          username: {
            type: "string",
            description: "Username of the user to look up.",
          },
          id: {
            type: "integer",
            description: "Numeric ID of the user to look up.",
          },
          me: {
            type: "boolean",
            description: "Set to true to look up the authenticated user. Omit username and id when set. false behaves as if me was omitted.",
          },
        },
        required: [],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: 'get_work_item',
      upstreamName: 'get_work_item',
      description: 'Read one work item.',
      class: 'read',
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "GitLab URL of the work item (a /-/work_items/, /-/issues/, or /-/epics/ URL). Provide this, or work_item_iid with group_id or project_id.",
          },
          group_id: {
            type: "string",
            description: "ID or path of the group. Required if URL and project_id are not provided.",
          },
          project_id: {
            type: "string",
            description: "ID or path of the project. Required if URL and group_id are not provided.",
          },
          work_item_iid: {
            type: "integer",
            description: "Internal ID of the work item. Required if url is not provided.",
          },
          include: {
            type: "array",
            items: {
              type: "string",
              enum: [
                "notes",
                "discussions",
                "related_merge_requests",
              ],
            },
            maxItems: 1,
            description: "Associated data to return with the work item, one facet per call. notes returns up to 100 notes per call and paginates with the notes_* parameters; for the newest notes, use notes_last without notes_first or notes_after. discussions returns threads with their resolvable and resolved state and the notes of each thread, and paginates forward with the discussions_* parameters; use it for thread structure or unresolved threads. An unresolved thread has resolvable true and resolved false. Use notes for a flat chronological history. related_merge_requests paginates with the related_merge_requests_* parameters and is empty for group-level work items such as epics.",
          },
          notes_first: {
            type: "integer",
            description: "Number of notes to return after the cursor (forward pagination). Max 100. Applies only when notes is in include.",
            minimum: 1,
            maximum: 100,
          },
          notes_after: {
            type: "string",
            description: "Cursor for forward pagination of notes. Use pageInfo.endCursor from a previous response. Applies only when notes is in include.",
          },
          notes_last: {
            type: "integer",
            description: "Number of notes to return before the cursor (backward pagination). Max 100. Applies only when notes is in include.",
            minimum: 1,
            maximum: 100,
          },
          notes_before: {
            type: "string",
            description: "Cursor for backward pagination of notes. Use pageInfo.startCursor from a previous response. Applies only when notes is in include.",
          },
          discussions_first: {
            type: "integer",
            description: "Number of discussions to return after the cursor (forward pagination). Max 100. Applies only when discussions is in include.",
            minimum: 1,
            maximum: 100,
          },
          discussions_after: {
            type: "string",
            description: "Cursor for forward pagination of discussions. Use pageInfo.endCursor from a previous response. Applies only when discussions is in include.",
          },
          discussions_filter: {
            type: "string",
            enum: [
              "all_notes",
              "only_comments",
              "only_activity",
            ],
            description: "Which discussions to return: all_notes, only_comments to leave out system notes, or only_activity for system notes only. Applies only when discussions is in include.",
          },
          related_merge_requests_first: {
            type: "integer",
            description: "Number of related merge requests to return after the cursor (forward pagination). Max 100. Applies only when related_merge_requests is in include.",
            minimum: 1,
            maximum: 100,
          },
          related_merge_requests_after: {
            type: "string",
            description: "Cursor for forward pagination of related merge requests. Use pageInfo.endCursor from a previous response. Applies only when related_merge_requests is in include.",
          },
          mr_page_size: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            description: "DEPRECATED: use related_merge_requests_first instead.",
          },
          mr_pagination_cursor: {
            type: "string",
            description: "DEPRECATED: use related_merge_requests_after instead.",
          },
        },
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: 'list_commits',
      upstreamName: 'list_commits',
      description: 'List commits in a project.',
      class: 'read',
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "GitLab URL of the project.",
          },
          project_id: {
            type: "string",
            description: "ID or full path of the project.",
          },
          ref_name: {
            type: "string",
            description: "Branch or tag to list commits from. Omit to use the default branch.",
          },
          author: {
            type: "string",
            description: "Filter by commit author name or email.",
          },
          path: {
            type: "string",
            description: "Only return commits that touch this file path.",
          },
          since: {
            type: "string",
            description: "Only return commits with a committed date after this ISO 8601 date or time.",
          },
          until: {
            type: "string",
            description: "Only return commits with a committed date before this ISO 8601 date or time.",
          },
          order: {
            type: "string",
            description: "Ordering strategy. Omit for reverse chronological order.",
            enum: [
              "topo",
              "date",
            ],
          },
          first_parent: {
            type: "boolean",
            description: "Follow only the first parent of merge commits.",
          },
          with_stats: {
            type: "boolean",
            description: "Include per-commit line-count stats (additions, deletions, files changed). Each commit costs a Gitaly call, so the page is capped at 10 when set.",
          },
          after: {
            type: "string",
            description: "Cursor for forward pagination. Use endCursor from the previous response.",
          },
          first: {
            type: "integer",
            description: "Number of commits to return (forward pagination, max 100). A maximum of 10 applies when with_stats is set.",
            minimum: 1,
            maximum: 100,
          },
        },
        required: [],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: 'list_merge_requests',
      upstreamName: 'list_merge_requests',
      description: 'List merge requests in a project or group.',
      class: 'read',
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "GitLab URL of the project or group.",
          },
          project_id: {
            type: "string",
            description: "ID or full path of the project.",
          },
          group_id: {
            type: "string",
            description: "ID or full path of the group. Includes merge requests from subgroups.",
          },
          author_username: {
            type: "string",
            description: "Filter by the username of the merge request author.",
          },
          assignee_username: {
            type: "string",
            description: "Filter by the username of an assignee.",
          },
          reviewer_username: {
            type: "string",
            description: "Filter by the username of a reviewer.",
          },
          state: {
            type: "string",
            description: "Filter by merge request state. Omit to include merge requests in any state.",
            enum: [
              "opened",
              "closed",
              "merged",
              "locked",
              "all",
            ],
          },
          scope: {
            type: "string",
            description: "Filter relative to the authenticated user, for requests such as \"my merge requests\" or \"merge requests awaiting my review\". created_by_me sets author_username, assigned_to_me sets assignee_username, review_requested sets reviewer_username. An explicit username wins for that field.",
            enum: [
              "created_by_me",
              "assigned_to_me",
              "review_requested",
            ],
          },
          milestone: {
            type: "string",
            description: "Filter by the title of the milestone.",
          },
          labels: {
            type: "string",
            description: "Comma-separated list of label names. Only merge requests with all of these labels are returned.",
          },
          search: {
            type: "string",
            description: "Search query matched against merge request title and description.",
          },
          first: {
            type: "integer",
            description: "Number of merge requests to return after the cursor (forward pagination). Max 100.",
            minimum: 1,
            maximum: 100,
          },
          after: {
            type: "string",
            description: "Cursor for forward pagination of merge requests. Use pageInfo.endCursor from a previous response.",
          },
        },
        required: [],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: 'list_projects',
      upstreamName: 'list_projects',
      description: 'List projects visible to the connected user.',
      class: 'read',
      inputSchema: {
        type: "object",
        properties: {
          group_id: {
            type: "string",
            description: "ID or full path of a group.",
          },
          min_access_level: {
            type: "string",
            description: "Minimum access level a project must grant you to be included.",
            enum: [
              "guest",
              "planner",
              "reporter",
              "developer",
              "maintainer",
              "owner",
            ],
          },
          search: {
            type: "string",
            description: "Search projects by name, path, or description.",
          },
          visibility: {
            type: "string",
            description: "Filter by visibility level.",
            enum: [
              "private",
              "internal",
              "public",
            ],
          },
          archived: {
            type: "string",
            description: "Filter by archived state: only returns archived projects, include returns both, exclude returns only non-archived projects (default).",
            enum: [
              "only",
              "include",
              "exclude",
            ],
          },
          first: {
            type: "integer",
            description: "Number of projects to return after the cursor (forward pagination). Max 100.",
            minimum: 1,
            maximum: 100,
          },
          after: {
            type: "string",
            description: "Cursor for forward pagination of projects. Use pageInfo.endCursor from a previous response.",
          },
        },
        required: [],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: 'list_repository_tree',
      upstreamName: 'list_repository_tree',
      description: 'List files and directories in a repository.',
      class: 'read',
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "GitLab URL of the project. Provide exactly one of url or project_id.",
          },
          project_id: {
            type: "string",
            description: "Project ID or full path. Provide exactly one of url or project_id.",
          },
          path: {
            type: "string",
            description: "Path of the directory to list, relative to the repository root. Omit to list the root.",
          },
          ref: {
            type: "string",
            description: "Branch name, tag name, or commit SHA. Omit to use the default branch.",
          },
          recursive: {
            type: "boolean",
            description: "When true, lists entries of all subdirectories recursively.",
          },
          after: {
            type: "string",
            description: "Cursor for forward pagination of entries. Use pageInfo.endCursor from a previous response.",
          },
        },
        required: [],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: 'list_work_items',
      upstreamName: 'list_work_items',
      description: 'List or search work items.',
      class: 'read',
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "GitLab URL for the project or group.",
          },
          group_id: {
            type: "string",
            description: "ID or path of the group. Required if URL and project_id are not provided.",
          },
          project_id: {
            type: "string",
            description: "ID or path of the project. Required if URL and group_id are not provided.",
          },
          state: {
            type: "string",
            enum: [
              "opened",
              "closed",
              "all",
            ],
            description: "Filter by state. Default is all.",
          },
          search: {
            type: "string",
            description: "Free-text search in title and description.",
          },
          author_username: {
            type: "string",
            description: "Username of the author.",
          },
          assignee_usernames: {
            type: "array",
            items: {
              type: "string",
            },
            maxItems: 100,
            description: "Usernames of assignees. A work item must match all of them.",
          },
          label_name: {
            type: "array",
            items: {
              type: "string",
            },
            maxItems: 100,
            description: "Label names. A work item must have all of them.",
          },
          milestone_title: {
            type: "array",
            items: {
              type: "string",
            },
            maxItems: 100,
            description: "Milestone titles. Cannot be combined with milestone_wildcard_id.",
          },
          milestone_wildcard_id: {
            type: "string",
            enum: [
              "NONE",
              "ANY",
              "STARTED",
              "UPCOMING",
            ],
            description: "Milestone wildcard. Cannot be combined with milestone_title.",
          },
          types: {
            type: "array",
            items: {
              type: "string",
              enum: [
                "ISSUE",
                "INCIDENT",
                "TEST_CASE",
                "REQUIREMENT",
                "TASK",
                "TICKET",
                "OBJECTIVE",
                "KEY_RESULT",
                "EPIC",
              ],
            },
            description: "Work item types to include, for example [\"ISSUE\", \"TASK\"].",
          },
          created_after: {
            type: "string",
            description: "Created after this time (ISO 8601; date-only means start of day, offsets honored).",
          },
          created_before: {
            type: "string",
            description: "Created before this time (ISO 8601; date-only means start of day, offsets honored).",
          },
          updated_after: {
            type: "string",
            description: "Updated after this time (ISO 8601; date-only means start of day, offsets honored).",
          },
          updated_before: {
            type: "string",
            description: "Updated before this time (ISO 8601; date-only means start of day, offsets honored).",
          },
          due_after: {
            type: "string",
            description: "Due after this time (ISO 8601; date-only means start of day, offsets honored).",
          },
          due_before: {
            type: "string",
            description: "Due before this time (ISO 8601; date-only means start of day, offsets honored).",
          },
          sort: {
            type: "string",
            enum: [
              "CLOSED_AT_ASC",
              "CLOSED_AT_DESC",
              "ESCALATION_STATUS_ASC",
              "ESCALATION_STATUS_DESC",
              "POPULARITY_ASC",
              "POPULARITY_DESC",
              "PRIORITY_ASC",
              "PRIORITY_DESC",
              "RELATIVE_POSITION_ASC",
              "SEVERITY_ASC",
              "SEVERITY_DESC",
              "UPDATED_DESC",
              "UPDATED_ASC",
              "CREATED_DESC",
              "CREATED_ASC",
              "TITLE_ASC",
              "TITLE_DESC",
            ],
            description: "Sort order. Default is CREATED_DESC.",
          },
          first: {
            type: "integer",
            description: "Number of work items to return after the cursor (forward pagination). Max 100.",
            minimum: 1,
            maximum: 100,
          },
          after: {
            type: "string",
            description: "Cursor for forward pagination of work items. Use pageInfo.endCursor from a previous response.",
          },
          health_status_filter: {
            type: "string",
            enum: [
              "onTrack",
              "needsAttention",
              "atRisk",
            ],
            description: "Filter by health status.",
          },
          status: {
            type: "object",
            properties: {
              name: {
                type: "string",
                description: "Status name, for example \"In progress\".",
              },
            },
            required: [
              "name",
            ],
            additionalProperties: false,
            description: "Filter by custom status.",
          },
        },
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: 'save_note',
      upstreamName: 'save_note',
      description: 'Add a note or discussion reply to a merge request or work item.',
      class: 'write',
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "GitLab URL of a merge request or work item, including issues and epics (.../-/merge_requests/<iid>, .../-/work_items/<iid>, .../-/issues/<iid>, or .../groups/<full_path>/-/epics/<iid>). Issue URLs are project-scoped; epic URLs are group-scoped and must include the groups/ prefix. The URL determines the target type, so no other identifier is needed",
          },
          project_id: {
            type: "string",
            description: "ID or path of the project. Required with merge_request_iid, and with work_item_iid for project-level work items",
          },
          group_id: {
            type: "string",
            description: "ID or path of the group. Required with work_item_iid for group-level work items",
          },
          merge_request_iid: {
            type: "integer",
            description: "Internal ID of the merge request. Provide with project_id. Mutually exclusive with work_item_iid",
          },
          work_item_iid: {
            type: "integer",
            description: "Internal ID of the work item. Provide with project_id or group_id. Mutually exclusive with merge_request_iid",
          },
          body: {
            type: "string",
            description: "Content of the note/comment (max 1048576 characters). Lines beginning with \"/\" are rejected to avoid triggering quick actions such as /merge",
            maxLength: 1048576,
          },
          internal: {
            type: "boolean",
            description: "Mark note as internal (visible only to members with at least the Reporter role)",
            default: false,
          },
          discussion_id: {
            type: "string",
            description: "Global ID of the discussion to reply to (format: gid://gitlab/Discussion/<id>). If omitted, creates a new top-level note",
          },
        },
        required: [
          "body",
        ],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    {
      name: 'save_pipeline',
      upstreamName: 'save_pipeline',
      description: "Run, retry, cancel or rename a project pipeline. Variables can override the project's own settings.",
      class: 'write',
      irreversible: true,
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "GitLab URL of the project. Used only when creating a pipeline.",
          },
          project_id: {
            type: "string",
            description: "ID or full path of the project. Used only when creating a pipeline.",
          },
          pipeline_id: {
            type: "integer",
            description: "ID of an existing pipeline to target. When set, requires action. Omit to create a new pipeline.",
          },
          action: {
            type: "string",
            enum: [
              "retry",
              "cancel",
              "update",
            ],
            description: "Lifecycle action to perform on pipeline_id. Required when pipeline_id is set.",
          },
          ref: {
            type: "string",
            description: "Branch or tag name. Required to create a pipeline (when pipeline_id is absent).",
          },
          name: {
            type: "string",
            description: "New pipeline name. Required for action: \"update\".",
          },
          variables: {
            type: "array",
            description: "Pipeline variables to create the pipeline with.",
            items: {
              type: "object",
              properties: {
                key: {
                  type: "string",
                  description: "Name of the variable.",
                },
                value: {
                  type: "string",
                  description: "Value of the variable.",
                },
                variable_type: {
                  type: "string",
                  enum: [
                    "env_var",
                    "file",
                  ],
                  description: "Type of the variable. Defaults to env_var.",
                },
              },
              required: [
                "key",
                "value",
              ],
            },
          },
          inputs: {
            type: "object",
            description: "Pipeline input parameters as key-value pairs.",
          },
        },
        required: [],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
      },
    },
    {
      name: 'save_work_item',
      upstreamName: 'save_work_item',
      description: 'Create or update a work item.',
      class: 'write',
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "GitLab URL for the project, group, or work item. Provide exactly one of url, project_id, or group_id.",
          },
          group_id: {
            type: "string",
            description: "ID or path of the group. Required if URL and project_id are not provided.",
          },
          project_id: {
            type: "string",
            description: "ID or path of the project. Required if URL and group_id are not provided.",
          },
          work_item_iid: {
            type: "integer",
            description: "Positive internal ID of the work item to update. Omit to create a new work item.",
          },
          title: {
            type: "string",
            description: "Title. Required on create.",
          },
          type_name: {
            type: "string",
            description: "Work item type name, for example \"Issue\", \"Task\", \"Epic\". Required on create. Valid types depend on the namespace and license; invalid values return the list of valid ones.",
          },
          description: {
            type: "string",
            description: "Description in GitLab Flavored Markdown (max 1048576 characters). Lines beginning with \"/\" are rejected to avoid triggering quick actions. Use add_labels, assignee_ids, and the other fields instead.",
            maxLength: 1048576,
          },
          assignee_ids: {
            type: "array",
            items: {
              type: "integer",
            },
            maxItems: 100,
            description: "User IDs to assign to the work item.",
          },
          label_ids: {
            type: "array",
            items: {
              type: "string",
            },
            maxItems: 100,
            description: "Label IDs or global IDs. Create only; on update use add_label_ids/remove_label_ids.",
          },
          labels: {
            type: "array",
            items: {
              type: "string",
            },
            maxItems: 100,
            description: "Names of the labels to set, resolved in the project or group and its ancestor groups. Create only; on update use add_labels/remove_labels.",
          },
          add_label_ids: {
            type: "array",
            items: {
              type: "string",
            },
            maxItems: 100,
            description: "Update only. Label IDs or global IDs to add.",
          },
          add_labels: {
            type: "array",
            items: {
              type: "string",
            },
            maxItems: 100,
            description: "Update only. Names of the labels to add.",
          },
          remove_label_ids: {
            type: "array",
            items: {
              type: "string",
            },
            maxItems: 100,
            description: "Update only. Label IDs or global IDs to remove.",
          },
          remove_labels: {
            type: "array",
            items: {
              type: "string",
            },
            maxItems: 100,
            description: "Update only. Names of the labels to remove.",
          },
          milestone_id: {
            type: "string",
            description: "ID or global ID of the milestone to assign, validated against the project or group and its ancestor groups. Wins over milestone when both are given.",
          },
          milestone: {
            type: "string",
            description: "Title of the milestone to assign, resolved among the milestones of the project or group and its ancestor groups.",
          },
          confidential: {
            type: "boolean",
            description: "Sets the work item confidentiality.",
          },
          start_date: {
            type: "string",
            description: "Start date, YYYY-MM-DD.",
          },
          due_date: {
            type: "string",
            description: "Due date, YYYY-MM-DD.",
          },
          state: {
            type: "string",
            enum: [
              "opened",
              "closed",
            ],
            description: "Update only. closed closes the work item, opened reopens it.",
          },
          parent_id: {
            type: "string",
            description: "Global ID or numeric ID of the parent work item (hierarchy).",
          },
          todo_action: {
            type: "string",
            enum: [
              "add",
              "mark_as_done",
            ],
            description: "Update only. add adds a to-do for the current user, mark_as_done marks to-dos as done.",
          },
          todo_id: {
            type: "string",
            description: "Update only. Global ID or numeric ID of the to-do; omit to update all to-dos on the work item.",
          },
          health_status: {
            type: "string",
            enum: [
              "onTrack",
              "needsAttention",
              "atRisk",
            ],
            description: "Health status of the work item.",
          },
          weight: {
            type: "integer",
            minimum: 0,
            description: "Weight of the work item.",
          },
          clear_weight: {
            type: "boolean",
            description: "Update only. Removes the weight; wins over weight.",
          },
          status_id: {
            type: "string",
            description: "Global ID of the status to set.",
          },
          is_fixed: {
            type: "boolean",
            description: "Whether start and due dates are fixed. When false, dates roll up from child items and start_date/due_date are ignored.",
          },
          agent_plan: {
            type: "string",
            description: "Markdown content of the agent plan. Requires the workplan feature.",
          },
          readiness_score: {
            type: "integer",
            minimum: 0,
            maximum: 100,
            description: "Readiness score of the agent plan (0-100). Requires the workplan_score feature flag. Omit to leave the existing score unchanged.",
          },
        },
        required: [],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
      },
    },
    {
      name: 'list_pipelines',
      upstreamName: 'list_pipelines',
      description: 'List pipelines in a project.',
      class: 'read',
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "ID or URL-encoded path of the project.",
          },
          ref: {
            type: "string",
            description: "Return pipelines for the specified branch or tag.",
          },
          status: {
            type: "string",
            description: "Return pipelines with the specified status.",
            enum: [
              "created",
              "waiting_for_resource",
              "preparing",
              "waiting_for_callback",
              "pending",
              "running",
              "success",
              "failed",
              "canceling",
              "canceled",
              "skipped",
              "manual",
              "scheduled",
            ],
          },
          source: {
            type: "string",
            description: "The source of pipelines",
            enum: [
              "unknown",
              "push",
              "web",
              "trigger",
              "schedule",
              "api",
              "external",
              "pipeline",
              "chat",
              "webide",
              "merge_request_event",
              "external_pull_request_event",
              "parent_pipeline",
              "ondemand_dast_scan",
              "ondemand_dast_validation",
              "security_orchestration_policy",
              "container_registry_push",
              "duo_workflow",
              "pipeline_execution_policy_schedule",
              "dependency_management_security_update",
            ],
          },
          created_after: {
            type: "string",
            description: "Return pipelines created after the specified time.",
          },
          created_before: {
            type: "string",
            description: "Return pipelines created before the specified time.",
          },
          order_by: {
            type: "string",
            description: "Sort results by the specified field.",
            enum: [
              "id",
              "status",
              "ref",
              "updated_at",
              "user_id",
            ],
          },
          sort: {
            type: "string",
            description: "Sort results in ascending or descending order.",
            enum: [
              "asc",
              "desc",
            ],
          },
          page: {
            type: "integer",
            description: "Page number of results to retrieve.",
          },
          per_page: {
            type: "integer",
            description: "Number of items to list per page.",
          },
        },
        required: [
          "id",
        ],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    {
      name: 'list_branches',
      upstreamName: 'list_branches',
      description: 'List branches in a project.',
      class: 'read',
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "ID or URL-encoded path of the project.",
          },
          search: {
            type: "string",
            description: "Return branches containing the search string. Use `^term` to find branches that begin with `term`, and `term$` to find branches that end with `term`.",
          },
          page: {
            type: "integer",
            description: "Page number of results to retrieve.",
          },
          per_page: {
            type: "integer",
            description: "Number of items to list per page.",
          },
        },
        required: [
          "id",
        ],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
      },
    },
  ],
};
