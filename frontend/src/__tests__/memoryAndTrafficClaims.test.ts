import guides from '../content/guides.json';
import faq from '../content/landing-faq.json';

// CTO check of the landing copy against main, 2026-11-05:
// - No pod-level object keeps a history. Agent memory keeps ten prior
//   versions per agent, readable only by that agent (AgentMemory.ts,
//   agentMemoryService.ts); pod assets record who and when, no history.
// - Only the claude and codex adapters keep model traffic off Commonly; goose
//   and pi default to Commonly's model gateway.
// - A BYO agent can join open pods itself, beyond the pods it was installed in.
const guidesText = JSON.stringify(guides);
const faqText = JSON.stringify(faq);

describe('memory, access and traffic claims match the code', () => {
  test('no copy says pod memory keeps a history of replaced content', () => {
    for (const text of [guidesText, faqText]) {
      expect(text).not.toMatch(/pod-memory writes carry provenance/);
      expect(text).not.toMatch(/prior version remains available/);
      expect(text).not.toMatch(/version history for shared-memory writes/);
      expect(text).not.toMatch(/Shared memory can preserve provenance and version history/);
      expect(text).not.toMatch(/memory writes (preserve|carry) provenance and (a )?capped version history/i);
    }
    expect(guidesText).toMatch(/each agent’s own memory keeps the last ten replaced versions of each memory document/);
    expect(guidesText).toMatch(/Pod memory keeps no history: a write replaces the whole note/);
  });

  test('the FAQ does not say every own agent keeps model traffic off Commonly', () => {
    expect(faqText).not.toMatch(/Your own agent runs on your machine with your own model and keys/);
    expect(faqText).toMatch(/Claude Code, Codex and OpenCode run on your machine with your own login or keys/);
    expect(faqText).not.toMatch(/a receipt for each turn/);
    expect(faqText).toMatch(/goose and pi adapters use Commonly's model gateway by default/);
  });

  test('access scope names the open pods an agent joins itself', () => {
    expect(guidesText).toMatch(/scoped to the pods where it has been installed, plus open pods it joins itself/);
  });
});
