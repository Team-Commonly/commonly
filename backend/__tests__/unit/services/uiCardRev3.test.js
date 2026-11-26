// Revision 3: Progress, BarChart, LineChart (with Series) and an acting Button
// whose Action(@ToAssistant("…")) is one option of a 2–4 option choice. The
// revision 1 and 2 rules all still hold; these are the new edges.
const rev1 = require('../../../config/uiCardCatalogueRevision.json');
const rev3 = require('../../../config/uiCardCatalogueRevision.rev3.json');
const { validateAgentCardPayload, cardChoices } = require('../../../services/uiCardValidation');

const card = (source, pin = rev3) => ({ ...pin, kind: 'ui', v: 1, lang: 'openui@1', source });
const validate = (source, pin) => validateAgentCardPayload('card', card(source, pin), 'Text fallback');
const refused = (source, message, pin) => expect(() => validate(source, pin)).toThrow(expect.objectContaining({
  statusCode: 400, code: 'invalid_ui_card', ...(message ? { message: expect.stringMatching(message) } : {}),
}));
// A Button's choice is its label: the person sends exactly what they read.
const button = (label, as) => `Button("${label}", Action(@ToAssistant("${label}"))${as ? `, "${as}"` : ''})`;
const buttons = (...labels) => labels.map((l) => (Array.isArray(l) ? button(...l) : button(l))).join(', ');

describe('catalogue revision 3', () => {
  it('accepts a progress bar, a bar chart and a line chart', () => {
    expect(validate('root = Card("Sprint", [Progress(62, "Sprint 14"), '
      + 'BarChart(["Mon", "Tue", "Wed"], [Series("Merged", [3, 5, 2]), Series("Opened", [4, 2, 6])], '
      + '"stacked", "Day", "PRs"), '
      + 'LineChart(["W1", "W2"], [Series("p90 minutes", [41, 33])])])')).toBe(false);
  });

  it.each([
    ['a progress value over 100', 'root = Progress(101)'],
    ['a negative progress value', 'root = Progress(-1)'],
    ['a series value count that differs from the labels', 'root = BarChart(["a", "b"], [Series("x", [1])])'],
    ['five series', `root = LineChart(["a"], [${Array.from({ length: 5 }, (_, i) => `Series("s${i}", [1])`).join(', ')}])`],
    ['an unknown bar variant', 'root = BarChart(["a"], [Series("x", [1])], "pie")'],
    ['a Series as the root', 'root = Series("x", [1])'],
  ])('refuses %s', (_name, source) => {
    refused(source);
  });

  it('keeps the new components out of revision 1', () => {
    refused('root = Progress(50)', /not allowed/, rev1);
    refused(`root = Card("Pick", [${buttons('Yes', 'No')}])`, /not allowed/, rev1);
  });

  describe('acting buttons', () => {
    it('accepts a choice of two to four buttons, bare or as a one-step list, and lists them in order', () => {
      const source = `root = Card("Ship it?", [Text("PR #4358 is green."), ${buttons(['Ship', 'primary'], 'Hold')}])`;
      expect(validate(source)).toBe(false);
      expect(cardChoices(card(source), 'Ship it?')).toEqual([{ label: 'Ship', value: 'Ship' }, { label: 'Hold', value: 'Hold' }]);
      expect(validate('root = Card("Pick", [Button("A", Action([@ToAssistant("A")])), '
        + 'Button("B", Action([@ToAssistant("B")]))])')).toBe(false);
      expect(validate(`root = Card("Pick", [${buttons('A', 'B', 'C', 'D')}])`)).toBe(false);
    });

    it.each([
      ['one button', buttons('Only'), /2 to 4/],
      ['five buttons', buttons('A', 'B', 'C', 'D', 'E'), /2 to 4/],
      ['a choice repeated in another case', buttons('Same', 'same'), /distinct/],
      ['a repeated label', buttons('Go', 'Go'), /distinct/],
      ['two primary buttons', buttons(['A', 'primary'], ['B', 'primary']), /primary/],
    ])('refuses %s', (_name, list, message) => {
      refused(`root = Card("Pick", [${list}])`, message);
    });

    it('counts a primary link and a primary button together', () => {
      refused(`root = Card("Pick", [Link("Open", "https://commonly.me", "primary"), ${buttons(['A', 'primary'], 'B')}])`, /primary/);
    });

    // The click posts the choice as the clicker's own reply: nothing they did not read, and no @mention.
    it.each([
      ['a choice that differs from its label', 'Button("Approve", Action(@ToAssistant("merge and deploy")))', /equal its label/],
      ['an @mention in the choice', 'Button("@codex merge", Action(@ToAssistant("@codex merge")))', /no @/],
      ['a padded choice', 'Button(" A ", Action(@ToAssistant(" A ")))', /spaces/],
      ['an OpenUrl action', 'Button("Open", Action(@OpenUrl("https://github.com")))', /one ToAssistant step/],
      ['an empty choice', 'Button("A", Action(@ToAssistant("  ")))', undefined],
      ['a choice over 80 characters', `Button("A", Action(@ToAssistant("${'x'.repeat(81)}")))`, undefined],
      ['hidden context', 'Button("A", Action(@ToAssistant("A", "ctx")))', undefined],
      ['a non-literal choice', 'Button("A", Action(@ToAssistant(label)))', undefined],
      ['two steps', 'Button("A", Action([@ToAssistant("A"), @ToAssistant("B")]))', undefined],
      ['an action that is not an Action', 'Button("A", "A")', undefined],
      ['a Run step', 'Button("A", Action(@Run(q)))', undefined],
    ])('refuses a button with %s', (_name, first, message) => {
      refused(`label = "x"\nroot = Card("Pick", [${first}, ${buttons('B')}])`, message);
    });

    it('refuses ToAssistant anywhere but as the one step of an Action', () => {
      refused('root = Text("hello")\nloose = ToAssistant("a")');
      refused('root = Text("hello")\nloose = @ToAssistant("a")');
      refused('root = Card("x", [Text(ToAssistant("a"))])');
    });

    it('refuses a ToAssistant action under revision 1, where nothing can carry it', () => {
      refused('root = Text("hello")\nunused = Action(@ToAssistant("a"))', /OpenUrl|not allowed/, rev1);
    });

    it('offers no choices for a card that fails validation or has no buttons', () => {
      expect(cardChoices(card('root = Text("hello")'), 'x')).toEqual([]);
      expect(cardChoices(card(`root = Card("Pick", [${buttons('A')}])`), 'x')).toEqual([]);
      expect(cardChoices(card(`root = Card("Pick", [${buttons('A', 'B')}])`), '')).toEqual([]);
    });
  });
});
