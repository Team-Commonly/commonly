import guides from '../content/guides.json';
import faq from '../content/landing-faq.json';
import en from '../i18n/locales/en.json';
import zhCN from '../i18n/locales/zh-CN.json';

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
  test('the landing makes no write-approval or pod-record claim an outside user cannot see', () => {
    // No grant made from the form gives an agent a write, so no approval card
    // appears, and the record runs on two internal pods only. Restore these
    // lines only when an outside user can reach both.
    for (const locale of [en, zhCN]) {
      const copy = JSON.stringify(locale.landing);
      expect(copy).not.toMatch(/every write can ask you first/i);
      expect(copy).not.toMatch(/Every call on the pod/i);
      expect(copy).not.toMatch(/每次写入都可以先问你/);
      expect(copy).not.toMatch(/每次调用都记录在/);
    }
  });

  test('no copy says pod memory keeps a history of replaced content', () => {
    for (const text of [guidesText, faqText]) {
      expect(text).not.toMatch(/pod-memory writes carry provenance/);
      expect(text).not.toMatch(/prior version remains available/);
      expect(text).not.toMatch(/version history for shared-memory writes/);
      expect(text).not.toMatch(/Shared memory can preserve provenance and version history/);
      expect(text).not.toMatch(/capped history of replaced/);
      expect(text).not.toMatch(/documented history and provenance/);
      expect(text).not.toMatch(/memory writes (preserve|carry) provenance and (a )?capped version history/i);
    }
    expect(guidesText).toMatch(/each agent’s own memory keeps the last ten replaced versions of each memory document/);
    expect(guidesText).toMatch(/Pod memory keeps no history: a write replaces the whole note/);
    // The memory guide's sentence carries the facts the code supports: the
    // per-document cap, which sections are versioned, and when and (for agent
    // writes) which runtime. It makes no claim about who can read the
    // versions: a shared section's history currently reaches other agents
    // through /memory/shared (CodeRabbit on #3514).
    expect(guidesText).toMatch(/keeps the last ten replaced versions of each memory document \(its daily log and relationship notes aren’t versioned\), with when each was written and, for agent writes, which runtime wrote it\./);
    expect(guidesText).not.toMatch(/readable only by that agent|Only that agent can read them/);
    expect(guidesText).toMatch(/Pod files record who uploaded them and when\./);
    expect(guidesText).not.toMatch(/other agents can read (its|the) (replaced )?versions/i);
    expect(guidesText).not.toMatch(/pod files? (keep|keeps|retain|retains) (a )?(version )?history/i);
  });

  test('the FAQ does not say every own agent keeps model traffic off Commonly', () => {
    expect(faqText).not.toMatch(/Your own agent runs on your machine with your own model and keys/);
    expect(faqText).toMatch(/Claude Code, Codex and OpenCode run on your machine with your own login or keys/);
    expect(faqText).not.toMatch(/a receipt for each turn/);
    // Tie the checks to the model-traffic answer itself, not anywhere in the FAQ.
    const traffic = (faq as Array<{ question: string; answer: string }>)
      .find((item) => item.question === 'Do you see my code or my model calls?');
    expect(traffic).toBeDefined();
    expect(traffic!.answer).toMatch(/Claude Code, Codex and OpenCode run on your machine with your own login or keys, so their model traffic doesn't go through us\./);
    expect(traffic!.answer).not.toMatch(/(Claude Code|Codex)[^.]*model traffic (goes|go) through (us|Commonly)/);
    expect(traffic!.answer).toMatch(/Commonly sees what your agent does through Commonly: what it posts and reads, its memory writes and its calls to connected tools\. For agents on your own computer, Commonly also stores what the wrapper reports with each reply: the tool, the model and effort when reported, the turn count, the tools used and how long it ran\./);
    expect(faqText).toMatch(/goose and pi adapters use Commonly's model gateway by default/);
  });

  test('access scope names the open pods an agent joins itself', () => {
    expect(guidesText).toMatch(/scoped to the pods where it has been installed, plus open pods it joins itself/);
  });
});
