/**
 * Connectors whose data the provider restricts to named uses: Google's Limited
 * Use terms for Workspace data, where the data may not train a model. A tool
 * from one of these reaches only the platform's no-training model route
 * (aiProviders.anthropic, F91/F92), with no fallback:
 *   - a native run is offered these tools only when its native model is Claude;
 *   - the broker refuses a call to one unless the caller says it is that run;
 *   - the MCP grant endpoint, which serves runtimes Commonly does not drive and
 *     whose model it cannot know, never lists them.
 * Broker tool names are `<entryId>.<tool>`.
 */
export const LIMITED_USE_ENTRIES: ReadonlySet<string> = new Set(['google-calendar']);

export const isLimitedUseTool = (tool: unknown): boolean => (
  LIMITED_USE_ENTRIES.has(String(tool || '').split('.')[0])
);

/** A model on the no-training route: Claude, through aiProviders.anthropic. */
export const isNoTrainingModel = (model: unknown): boolean => /^claude-/i.test(String(model || '').trim());
