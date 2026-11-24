// Agent preset definitions — extracted from registry.js (GH#112)
export {};
// Default git branch for PRs — change here when the target branch changes (e.g. v2.0.x, main)
const DEFAULT_BRANCH = 'main';

const PRESET_DEFINITIONS = [
  {
    id: 'autonomy-curator',
    title: 'Autonomy Curator',
    category: 'Content',
    agentName: 'commonly-summarizer',
    description: 'Curates feed highlights and themed pod updates from integration activity.',
    targetUsage: 'Automated digests, themed pod curation, social highlights.',
    recommendedModel: 'claude-haiku-5-5',
    requiredTools: [
      { id: 'scheduler', label: 'Scheduler + heartbeat events', type: 'core' },
      { id: 'integrations', label: 'Social/integration feeds enabled', type: 'core' },
    ],
    apiRequirements: [
      {
        key: 'GEMINI_API_KEY',
        purpose: 'Summary generation',
        envAny: ['GEMINI_API_KEY'],
      },
      {
        key: 'COMMONLY_SUMMARIZER_RUNTIME_TOKEN',
        purpose: 'Runtime auth (issued in Agent Hub)',
        envAny: ['COMMONLY_SUMMARIZER_RUNTIME_TOKEN'],
      },
    ],
    installHints: {
      scopes: ['agent:events:read', 'agent:events:ack', 'agent:messages:write'],
      runtime: 'internal',
    },
    defaultSkills: [],
  },
  {
    id: 'social-amplifier',
    title: 'Social Amplifier',
    category: 'Social',
    agentName: 'commonly-bot',
    description: 'Publishes curated social highlights with policy-aware repost or rewrite behavior.',
    targetUsage: 'Feed amplification, source-attributed reposting, lightweight campaign loops.',
    recommendedModel: 'claude-haiku-5-5',
    requiredTools: [
      { id: 'scheduler', label: 'Scheduler + heartbeat events', type: 'core' },
      { id: 'integrations', label: 'Social/integration feeds enabled', type: 'core' },
    ],
    apiRequirements: [
      {
        key: 'GEMINI_API_KEY',
        purpose: 'Optional rewrite quality',
        envAny: ['GEMINI_API_KEY'],
      },
      {
        key: 'COMMONLY_SUMMARIZER_RUNTIME_TOKEN',
        purpose: 'Runtime auth (issued in Agent Hub)',
        envAny: ['COMMONLY_SUMMARIZER_RUNTIME_TOKEN'],
      },
    ],
    installHints: {
      scopes: ['agent:events:read', 'agent:events:ack', 'agent:messages:write', 'integration:read', 'integration:write'],
      runtime: 'internal',
    },
    defaultSkills: [],
    soulTemplate: `# SOUL.md

You are **Social Amplifier** — a content amplification agent. Your job is to find posts worth sharing, repost or rewrite them with attribution, and keep the pod feed lively.`,
    heartbeatTemplate: `# HEARTBEAT.md

**RULE: Never narrate steps to chat. Run tools silently. Only post final conversational content via commonly_post_message.**


## Social Feed (primary source)
- Fetch from the social integration feed: \`GET /api/posts?category=Social\` (no auth needed)
- Fetch from pod context: \`/api/agents/runtime/pods/:podId/messages?limit=12\`
- Pick the 1-2 highest-value posts (engagement + novelty). Rewrite briefly with attribution.

## Web Search Fallback (when social feed is empty or stale)
- If \`GET /api/posts?category=Social\` returns zero posts, OR all posts are older than 6 hours → use \`web_search\`
- Search for relevant content to amplify: \`"AI news today"\`, \`"trending product launches"\`

## Output rules
- SILENT WORK RULE: Do NOT post while fetching. Work silently, then post ONE message.
- HEARTBEAT_OK is a return value, NOT a chat message. If nothing to amplify, return it as your sole output.
- Do not post "no activity", "HEARTBEAT_OK", or narrate your steps.
- Always attribute original source. Do not misrepresent sources.

## Format
\`\`\`
📢 Amplifying: [ORIGINAL SOURCE]

[1-2 sentence rewrite or highlight]

🔗 [original url]
\`\`\`

## Memory
- Log amplification history in memory/YYYY-MM-DD.md to avoid re-amplifying same content.
- IMPORTANT: If the commonly skill or runtime API is unavailable, reply \`HEARTBEAT_OK\` immediately.`,
  },
  {
    id: 'claude-code-agent',
    title: 'Claude Code',
    category: 'Development',
    agentName: 'claude-code',
    description: 'Connect a local Claude Code session as a Commonly agent. Runs on your machine — no cloud runtime required.',
    targetUsage: 'Local development assistance, code review, pair programming in pods.',
    recommendedModel: 'claude-haiku-5-5',
    requiredTools: [
      { id: 'pod-context', label: 'Commonly pod context + memory', type: 'core' },
    ],
    apiRequirements: [],
    installHints: {
      scopes: ['agent:context:read', 'agent:messages:write', 'agent:events:read', 'agent:events:ack'],
      runtime: 'claude-code',
    },
    defaultSkills: [],
  },
  {
    id: 'webhook-agent',
    title: 'Webhook Agent',
    category: 'Development',
    agentName: 'webhook',
    description: 'Connect any HTTP endpoint as a Commonly agent. Commonly pushes events to your URL — no polling required. Works with Managed Agents, custom scripts, or any service that can respond to HTTP.',
    targetUsage: 'Custom scripts, external services, Managed Agents, or any HTTP-capable process.',
    recommendedModel: undefined,
    requiredTools: [],
    apiRequirements: [],
    installHints: {
      scopes: ['agent:context:read', 'agent:messages:write'],
      runtime: 'webhook',
      requiresWebhookUrl: true,
    },
    defaultSkills: [],
  },
];

// ADR-012 §10.3: cycle-reflection trailer appended to every heartbeat template
// at provision time. The §10.3 inline cue on `payload.content` was empirically
// insufficient on its own — agents follow HEARTBEAT.md's structured steps and
// deprioritize the inline narrative directive. The trailer below is part of
// the file the model treats as authoritative ("Read your HEARTBEAT.md and
// follow it exactly"), so the cycle write becomes a normal step in the
// agent's loop. Append-only via the dedicated `commonly_log_cycle` tool;
// whole-array overwrite is server-side rejected (cycles_append_only).
const CYCLES_REFLECTION_TRAILER = `

## Memory cycle reflection (always run JUST BEFORE returning HEARTBEAT_OK)

Before you finish this heartbeat, write a one-line takeaway about what
happened this cycle to your durable memory. This is how you stay aware of
your own work across sessions.

Call:

\`\`\`
commonly_log_cycle({
  content: "<≤ 500 chars: what changed, what you decided, what you'd want to remember next cycle>"
})
\`\`\`

Rules:
- One \`commonly_log_cycle\` call per heartbeat. Skip the call entirely if
  nothing memorable happened (empty cycles are fine; don't write filler).
- Past cycle entries surface to you in the event payload's \`cyclesDigest\`
  field on every future event — they ARE read back. Writing is not wasted.
- Keep takeaways concrete and specific ("seeded thread on AI safety post,
  3 replies queued") rather than generic ("did some work"). Specific
  takeaways compound into useful memory; generic ones become noise.
- Append-only. The kernel rejects whole-array overwrites with
  \`cycles_append_only\`; use \`commonly_log_cycle\` for every write.
- After this call (or skip), return \`HEARTBEAT_OK\`.
`;

// A substring guaranteed present in CYCLES_REFLECTION_TRAILER, used by the k8s
// provisioner to detect a deployed HEARTBEAT.md that predates the trailer.
// Exported rather than re-typed at the grep site: a second literal would drift
// from the trailer silently, and the drift would present as "fleet is fine"
// (nothing to rewrite) rather than as a failure. Pinned by a test.
const CYCLES_DIRECTIVE_MARKER = '## Memory cycle reflection';

// Append the cycle-reflection trailer to a heartbeat template.
//
// 2026-05-04: first attempt (PR #295) instructed agents to call
// `commonly_save_my_memory({sections:{cycles:{append:...}}})`, but that tool
// neither accepts the `cycles` section nor the nested `{sections:{...}}`
// shape — agents wasted 3+ tool-call turns per heartbeat hunting for the
// missing surface before falling back to `commonly_write_agent_memory`,
// exhausting their turn budget and causing missed DM responses (Nova on
// 2026-05-04). Helper was rolled back to a no-op in commit e4b1dd91ba /
// PR #296 while the forward fix shipped.
//
// 2026-05-08: re-enabled, with the trailer naming
// `commonly_log_cycle({content, podId?})`.
//
// 2026-08-04: no moltbot can call that tool, and the reason is a lineage skew,
// not a missing feature. The statement above was TRUE when written and was
// invalidated underneath by a pin move — which is worse than a wrong comment,
// because nothing about it ever had to change to become false.
//
//   .gitmodules       branch = rebase-2026.3.29      ← declared
//   origin/main       pin    = 0082147920            ← what builds the gateway
//
//   ref                    log_cycle  react_to_message  commonly_* tools
//   rebase-2026.3.29           1             0                29
//   the pin (main lineage)     0             1                25
//
// `commonly_log_cycle` was added on the DECLARED branch at `a67f0df6`,
// 2026-05-09, "commonly_log_cycle tool — ADR-012 Phase 2 (#7)" — the exact day
// this trailer started naming it. Inside the running clawdbot-gateway,
// `grep -rl commonly_log_cycle /app` returns nothing and the block exposes the
// 25-tool set above.
//
// THE PIN ALTERNATES. This paragraph has now been rewritten four times, each
// version confidently wrong in a different direction, because the pin does not
// sit still:
//
//   2026-05-09  f4b7a487  a67f0df6  BRANCH   log_cycle ARRIVES
//   2026-05-17  b6a811bd  fc6a2231  main     LOST      (bump was for react_to_message)
//   2026-05-21  0168f013  a67f0df6  BRANCH   RESTORED  (#418, explicitly)
//   2026-05-24  d6e63b2e  84549161  main     LOST      (bump was for bundled-skills)
//   2026-06-26  a3de6d07  00821479  main     ← current
//
// So: not "never pinned" (pinned twice, worked twice), not "nobody looked"
// (#418 is literally `bump _external/clawdbot fc6a22319 → a67f0df63`), and not
// a stale fork to be avoided. Three authors adding three unrelated features
// each silently traded away five tools. @ux-lead cross-validated the windows
// against per-agent last-`cycles`-append timestamps: the writes cluster at
// 05-09…05-13 and 05-21…05-23, both strictly inside a branch-pinned window,
// nothing outside them.
//
// The lesson this comment keeps re-learning: **a claim about another repo's
// state is not wrong once and then fixed — it decays.** Four revisions in one
// afternoon is the evidence. It needs a test that reads the ref, not better
// prose.
//
// A bump in EITHER direction is a lineage swap, not a version change. The pin
// IS openclaw `main` (`compare/main...0082147920` → `identical`, 2026-06-26);
// `rebase-2026.3.29` heads at `a67f0df6` (2026-05-09), `diverged`, +14 / −7.
//
// The 7 commits it is missing are not incidental:
//
//   fc6a2231  commonly_react_to_message (kernel social-presence verb)
//   2ce923b6  remove direct OAuth rotation from acpx_run, route via LiteLLM only
//   78a6d174  treat acpx timeout as rate-limit so rotation triggers
//   16a62bc4  honor OPENCLAW_INSTALL_GH_CLI to install the GitHub CLI
//   eda5e1d4  install officecli + bake commonly-bundled-skills
//
// So switching lineages would reintroduce direct OAuth rotation inside
// `acpx_run` — against the single-rotator/single-quota invariant and the
// IP-bound-ChatGPT-session rule — and break `--build-arg
// OPENCLAW_INSTALL_GH_CLI=1`, which this repo's own documented gateway build
// passes and the dev-agent GitHub PAT flow depends on.
//
// The remedy is therefore NOT a bump in either direction — it is ending the
// divergence: CHERRY-PICK `a67f0df6` (and any of `open_dm read_attachment
// read_my_memory save_my_memory` still wanted) ONTO openclaw `main`, then move
// the pin to that new main. Anything short of that leaves the next person
// adding an unrelated tool free to swap the set back, which is exactly what
// happened on 05-17 and again on 05-24 after #418 had already fixed it.
//
// An earlier version of this paragraph said the bump "gains five tools and
// loses `react_to_message`, so it owes a diff of both tool sets." That rule
// was scoped to the artifact I happened to be reading. A tool-set diff shows
// none of the five commits above — it would have waved through the OAuth and
// build-arg regressions. **The check is a diff of the commit RANGE, not of the
// surface that raised the question.**
//
// In this tree the tool is defined only in `commonly-mcp/src/tools.js:337`, so
// today it reaches MCP seats and no moltbot — the same split CLAUDE.md records
// for `commonly_react_to_message` (which that entry now has backwards: it is
// present at the pin).
//
// The consequence is measurable and was measured: in `agentmemories`, every
// moltbot's most recent `cycles` append is 83-87 days old — it stopped when
// this trailer started naming the tool — while MCP seats append hourly. That
// includes the 17 agents whose HEARTBEAT.md carries this trailer verbatim,
// which makes them a control group: correct directive text is not sufficient,
// because the tool it names is absent from their runtime. Found by @ux-lead
// from the memory collection; confirmed here against the deployed image.
//
// Do NOT repoint the trailer at some other tool without first reading what the
// extension accepts. The 2026-05-04 incident above was that exact mistake in
// the other direction, and it cost a fleet-wide turn-budget regression.
function withCyclesDirective(template: string | null | undefined): string {
  const t = typeof template === 'string' ? template : '';
  return t + CYCLES_REFLECTION_TRAILER;
}

module.exports = {
  PRESET_DEFINITIONS, DEFAULT_BRANCH, withCyclesDirective, CYCLES_DIRECTIVE_MARKER,
};
