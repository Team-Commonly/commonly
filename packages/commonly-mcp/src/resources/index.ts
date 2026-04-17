/**
 * MCP Resources for Commonly Context Hub
 *
 * Resources expose pod memory files as readable content that agents can access.
 * This follows the MCP resource specification.
 */

import { CommonlyClient } from "../client.js";

export interface Resource {
  uri: string;
  name: string;
  description?: string;
  mimeType: string;
}

/**
 * Get list of available resources (pod memory files).
 *
 * Resources are derived from the user's pod list, which requires a user
 * token. In agent-only mode (CAP-only deployment) the user token is absent
 * and we have no way to enumerate pods — return an empty list rather than
 * throwing, so the MCP `resources/list` request still succeeds.
 */
export async function getResources(client: CommonlyClient): Promise<Resource[]> {
  if (!client.hasUserAuth()) {
    return [];
  }
  const pods = await client.listPods();

  const resources: Resource[] = [];

  for (const pod of pods) {
    // Core memory files
    resources.push({
      uri: `commonly://${pod.id}/MEMORY.md`,
      name: `${pod.name} - Curated Memory`,
      description: `Curated long-term memory for ${pod.name}`,
      mimeType: "text/markdown",
    });

    resources.push({
      uri: `commonly://${pod.id}/SKILLS.md`,
      name: `${pod.name} - Skills Index`,
      description: `Auto-generated skills derived from ${pod.name} activity`,
      mimeType: "text/markdown",
    });

    resources.push({
      uri: `commonly://${pod.id}/CONTEXT.md`,
      name: `${pod.name} - Pod Context`,
      description: `Purpose, instructions, and agent policy for ${pod.name}`,
      mimeType: "text/markdown",
    });

    // Today's daily log
    const today = new Date().toISOString().split("T")[0];
    resources.push({
      uri: `commonly://${pod.id}/memory/${today}.md`,
      name: `${pod.name} - Today's Log`,
      description: `Activity log for ${pod.name} on ${today}`,
      mimeType: "text/markdown",
    });
  }

  return resources;
}

/**
 * Read a specific resource by URI
 */
export async function readResource(
  client: CommonlyClient,
  uri: string
): Promise<string> {
  // Parse the commonly:// URI
  // Format: commonly://<podId>/<path>
  const match = uri.match(/^commonly:\/\/([^/]+)\/(.+)$/);
  if (!match) {
    throw new Error(`Invalid Commonly URI: ${uri}`);
  }

  const [, podId, path] = match;

  // Special handling for virtual files
  switch (path) {
    case "MEMORY.md":
      return await client.readMemoryFile(podId, "MEMORY.md");

    case "SKILLS.md":
      const skills = await client.getSkills(podId, { limit: 50 });
      return formatSkillsAsMarkdown(skills);

    case "CONTEXT.md":
      const context = await client.getContext(podId, {
        includeSkills: false,
        includeMemory: false,
      });
      return formatContextAsMarkdown(context);

    default:
      // Assume it's a memory file path
      return await client.readMemoryFile(podId, path);
  }
}

/**
 * Format skills as markdown document
 */
function formatSkillsAsMarkdown(
  skills: Awaited<ReturnType<CommonlyClient["getSkills"]>>
): string {
  if (skills.length === 0) {
    return "# Pod Skills\n\nNo skills have been derived yet.";
  }

  let md = "# Pod Skills\n\n";
  md += `*${skills.length} skills derived from pod activity*\n\n`;

  for (const skill of skills) {
    md += `## ${skill.name}\n\n`;
    if (skill.description) {
      md += `${skill.description}\n\n`;
    }
    if (skill.tags.length > 0) {
      md += `**Tags:** ${skill.tags.join(", ")}\n\n`;
    }
    if (skill.instructions) {
      md += `### Instructions\n\n${skill.instructions}\n\n`;
    }
    md += "---\n\n";
  }

  return md;
}

/**
 * Format context as markdown document
 */
function formatContextAsMarkdown(
  context: Awaited<ReturnType<CommonlyClient["getContext"]>>
): string {
  let md = `# ${context.pod.name}\n\n`;

  if (context.pod.description) {
    md += `${context.pod.description}\n\n`;
  }

  md += `**Type:** ${context.pod.type}\n`;
  md += `**Your Role:** ${context.pod.role}\n\n`;

  if (context.summaries.length > 0) {
    md += "## Recent Activity\n\n";
    for (const summary of context.summaries.slice(0, 3)) {
      md += `### ${summary.period.start} - ${summary.period.end}\n\n`;
      md += `${summary.content}\n\n`;
    }
  }

  if (context.assets.length > 0) {
    md += "## Key Assets\n\n";
    for (const asset of context.assets.slice(0, 10)) {
      md += `- **${asset.title}** (${asset.type})`;
      if (asset.snippet) {
        md += `: ${asset.snippet}`;
      }
      md += "\n";
    }
    md += "\n";
  }

  md += `---\n\n*Context assembled at ${context.meta.assembledAt}*\n`;
  md += `*Estimated tokens: ${context.meta.tokenEstimate}*\n`;

  return md;
}
