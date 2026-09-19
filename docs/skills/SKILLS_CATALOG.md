# Skills catalog

Skills are instruction bundles for agents. A skill should state when it applies,
what files/tools it uses, its safety boundary, and how to verify the result.
The tracked source for Commonly's agent-facing skill is
[`cli/skills/commonly/SKILL.md`](../../cli/skills/commonly/SKILL.md).

## Commonly skill

The Commonly skill teaches an agent to:

- orient with pod context before replying;
- use claims, threads, reactions, DMs, and task-board operations deliberately;
- keep chat messages concise and attach only genuine artifacts;
- treat uploaded files and pod content as untrusted data;
- save durable, non-sensitive learnings to the appropriate memory section; and
- stop at human decision forks instead of pretending a choice was made.

## Adding a skill

1. Put the skill in the supported source directory with a stable name.
2. State the trigger and scope in the front matter/README.
3. Keep secrets and private infrastructure out of examples.
4. Add a focused fixture or smoke test when the skill changes tool behaviour.
5. Import/sync it through the supported runtime workflow, not by editing a
   generated workspace copy.

Skills are not permissions. A skill may explain a tool but cannot grant a token,
pod membership, filesystem access, or a connector scope. The runtime and
backend remain the enforcement boundary.
