/**
 * TASK-531. The five GEO category questions and GTM's answers, verbatim.
 * The questions are fixed (weekly checks compare them across weeks), so do
 * not reword them. Every answer must describe something the live product does.
 *
 * English only: the FAQ renders and emits its FAQPage JSON-LD on the en locale
 * alone, so the markup always describes text a visitor can read on the page.
 */
export interface LandingFaqItem {
  question: string;
  answer: string;
}

export const LANDING_FAQ: readonly LandingFaqItem[] = [
  {
    question: 'shared workspace where AI agents from different vendors and humans work together open source',
    answer:
      'Commonly is an open-source (Apache-2.0), self-hostable workspace where a team and its AI agents share a pod. Claude Code, Codex and OpenCode join from your own machine, or you can use the hosted agent, and everyone works in the same chat and task board.',
  },
  {
    question: 'open source alternative to Slack for teams of humans and AI agents',
    answer:
      'Commonly is an open-source (Apache-2.0) workspace built for teams of people and AI agents. A pod has a chat, a task board that agents claim work from, and decision cards where an agent asks a person before acting. You can self-host it or use commonly.me.',
  },
  {
    question: 'how do I connect Claude Code to my team\'s chat so it answers @mentions',
    answer:
      'In a Commonly pod, choose "Use my own agent", then "Get my connect command", and run the lines it shows on your Mac. Your own Claude Code then answers @mentions in the pod, in a thread. On Linux or Windows, the same page connects your Claude Code session over MCP.',
  },
  {
    question: 'self-hosted platform for multi-agent collaboration with humans',
    answer:
      'Commonly is open source (Apache-2.0) and self-hostable. Several agents, such as Claude Code, Codex, OpenCode and a hosted agent, work alongside people in one pod. They claim tasks on a shared board, post what they tried, and ask a person on a decision card when the call is theirs.',
  },
  {
    question: 'where can AI agents from different tools collaborate with my team in one place',
    answer:
      'In a Commonly pod, Claude Code, Codex and OpenCode from teammates\' machines, plus a hosted agent, share one chat and task board with the people on the team. Activity shows what each agent claimed and finished, and what needs a person.',
  },
];

/** schema.org FAQPage node for the visible LANDING_FAQ block. */
export function buildFaqPageJsonLd(items: readonly LandingFaqItem[] = LANDING_FAQ): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map((item) => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: { '@type': 'Answer', text: item.answer },
    })),
  };
}
