# Which login can your agent use?

When you bring your own agent (Claude Code, Codex, Gemini CLI or another
CLI) through the daemon or `commonly agent attach`, it runs on your computer
with your login or your API key. In a pod, other people can @mention it, and
each mention starts a turn on that login. The vendors' terms allow some
logins for your own use and not for other people's, so pick the login with
that in mind.

This is our reading of the vendors' terms, not legal advice. Check the
vendor's terms yourself.

## What Commonly does

- For an agent you bring, Commonly never pays for or resells model usage.
- The agent runs on your machine, with your login or your key. Each vendor
  bills you under your own agreement with them.
- Anyone who can @mention your agent in a pod can make it take a turn on
  your account.

## Commonly's own hosted agents

The hosted agents you start with **Run it here** don't run Claude Code. They
run on Commonly's own hosted runtime (the [native runtime](NATIVE_RUNTIME.md)
for new ones), which calls model providers' APIs directly on Commonly's own
account. That makes them an API product, so the Claude Code clauses on this
page don't apply to them. The clause that fits is
in Anthropic's [Commercial Terms][a-commercial], section A.1: "products and
services Customer makes available to its own customers and end users".

## The short answer

- **Only you trigger it:** a consumer subscription login (Claude Pro or Max,
  ChatGPT Plus or Pro) is fine. A personal Google account is unclear; read G1
  in the Google section before you use it this way.
- **Your own team's pod:** an API key is the best-supported setup. The
  background daemon doesn't carry your key or setup-token into a Claude seat,
  so run that agent with `commonly agent run <name>` from a shell where you've
  exported it (see [Connecting local agents](CONNECTING_LOCAL_AGENTS.md)).
  Unset `CLAUDE_CODE_OAUTH_TOKEN` in that shell: on a Linux workspace seat the
  setup-token wins when both are set, and turns would run on your subscription.
- **Pods open to strangers:** bringing your own agent doesn't stop other
  members from @mentioning yours, and each of those turns runs on your login
  or key. Until the planned refusal below ships, keep your agent out of pods
  where strangers can mention it.

## The table

Each cell is **allowed**, **not allowed** or **unclear**, with a link to the
clause it rests on. Quotes and dates follow under the table.

| Vendor | Login | Only you trigger it | It runs unattended | Other people trigger it |
|---|---|---|---|---|
| Anthropic (Claude Code) | Consumer subscription (Free, Pro, Max, Ultra) | **Allowed** ([A3][a-cc-own]) | **Unclear** ([A2][a-consumer], [A4][a-cc-limits]) | **Not allowed** ([A1][a-consumer]) |
| Anthropic (Claude Code) | Team or Enterprise plan | **Allowed** ([A5][a-cc-oauth]) | **Unclear** ([A4][a-cc-limits]) | **Unclear** ([A4][a-cc-limits], [A7][a-commercial]) |
| Anthropic (Claude Code) | API key | **Allowed** ([A6][a-cc-keys]) | **Allowed** ([A2][a-consumer]) | **Unclear** ([A6][a-cc-keys], [A8][a-cc-offer]) |
| OpenAI (Codex) | Consumer ChatGPT sign-in (Plus, Pro) | **Allowed** ([O3][o-codex-auth]) | **Unclear** ([O2][o-terms], [O4][o-codex-auth]) | **Not allowed** ([O1][o-terms]) |
| OpenAI (Codex) | ChatGPT Business or Enterprise | **Allowed** ([O3][o-codex-auth], [O6][o-business]) | **Unclear** ([O4][o-codex-auth]) | **Not allowed** ([O5][o-business]) |
| OpenAI (Codex) | API key | **Allowed** ([O4][o-codex-auth]) | **Allowed** ([O4][o-codex-auth]) | **Allowed, with a security caveat** ([O6][o-business], [O7][o-codex-auth]) |
| Google (Gemini CLI) | Personal Google account (free tier, Google AI Pro or Ultra) | **Unclear** ([G1][g-cli-terms]) | **Unclear** ([G2][g-cli-terms]) | **Unclear** ([G3][g-terms]) |
| Google (Gemini CLI) | Gemini Code Assist Standard or Enterprise | **Unclear** ([G4][g-cli-terms], [G2][g-cli-terms]) | **Unclear** ([G2][g-cli-terms]) | **Unclear** ([G5][g-cloud]) |
| Google (Gemini CLI) | Gemini API key | **Allowed** ([G6][g-api]) | **Allowed** ([G6][g-api]) | **Allowed** ([G6][g-api], [G7][g-api]) |

Gemini CLI has no Commonly adapter yet (it is parked in
[LOCAL_CLI_WRAPPER.md](LOCAL_CLI_WRAPPER.md)). Its row is here for anyone who
wires it up through MCP or their own wrapper.

## Why each cell says what it says

### Anthropic

Sources checked on 2026-11-26:
[Consumer Terms][a-consumer] (effective Oct 8, 2025),
[Claude Code legal and compliance][a-cc-legal],
[Commercial Terms][a-commercial].

- **A1.** Consumer Terms, section 2: "You also may not make your Account
  available to anyone else." When other people @mention your agent, their
  requests run on your account. We read that as making it available to them.
- **A2.** Consumer Terms, section 3(7) forbids using the services "to access
  the Services through automated or non-human means", "Except when you are
  accessing our Services via an Anthropic API Key or where we otherwise
  explicitly permit it". An API key is clearly fine. We found nothing that
  says whether an unattended daemon turn on a subscription counts as
  explicitly permitted.
- **A3.** Claude Code legal page: the rules don't prevent an end user
  "signing in to the unmodified Claude Code binary with their own Claude
  subscription". Commonly runs the unmodified `claude` binary with your own
  login.
- **A4.** Same page: "Advertised usage limits for Pro, Max, and Ultra plans
  assume ordinary, individual usage". It doesn't say whether turns other
  people start, or turns that run while you're away, count as ordinary,
  individual use.
- **A5.** Same page: OAuth sign-in is "intended exclusively for purchasers of
  Claude Free, Pro, Max, Ultra, Team, and Enterprise subscription plans".
- **A6.** Same page: you may configure your own API key "for use by the
  customer's own authorized users", as long as usage is billed to the key
  owner and not resold.
- **A7.** Commercial Terms (Team, Enterprise and API): the services may power
  "products and services Customer makes available to its own customers and
  end users", and "Customer is responsible for all activity under its
  account." For a Team seat signed in through OAuth, A4 still applies, so
  that cell stays unclear.
- **A8.** Claude Code legal page, under "Can customers offer Claude Code in
  their products?": customers "may not pay for, resell, or intermediate Claude
  usage on their end users' behalf". It also says each end user must sign
  in with their own key or plan. A6 allows a key only if usage "is not
  resold or intermediated". So other people triggering turns billed to your key falls between A6 and A8.
  Your own team, or collaborators you authorize, is the closest fit to A6.
  Strangers in a public pod running turns on your key is closest to A8.

### OpenAI

Sources checked on 2026-11-26:
[Terms of Use][o-terms] (effective January 1, 2026),
[Business Terms][o-business] (effective January 1, 2026),
[Codex authentication docs][o-codex-auth].

- **O1.** Terms of Use: you may not "share your account credentials or make
  your account available to anyone else".
- **O2.** Terms of Use, among the things you may not do: "Automatically or
  programmatically extract data or Output". The terms don't say whether an
  unattended Codex turn on your own sign-in falls under this.
- **O3.** Codex docs: Codex supports "Sign in with ChatGPT for subscription
  access", alongside an API key.
- **O4.** Codex docs: "Use API key authentication for programmatic Codex CLI
  workflows, such as CI/CD jobs." Also: "API keys are still the recommended
  default for automation." The docs also say "Access tokens are intended for
  trusted scripts, schedulers, and private CI runners". They describe those
  tokens for ChatGPT Enterprise workspaces only, so we didn't count them for
  the Business row.
- **O5.** Business Terms, section 3.2: End User Accounts "may only be
  provisioned to, registered for, and used by, a single End User". Section
  3.1: "Customer will not share Account access credentials or individual login
  credentials between multiple users."
- **O6.** Business Terms cover the APIs and ChatGPT Business and Enterprise.
  Section 2.2 lets a customer use the services "to make Customer Applications
  available to End Users".
- **O7.** Codex docs: "Don’t expose Codex execution in untrusted or public
  environments." This is a security warning, not a licence term. It still
  applies to an API-key agent in a pod strangers can join.

### Google

Sources checked on 2026-11-26:
[Gemini CLI license, terms of service and privacy notices][g-cli-terms]
(last updated April 10, 2026),
[Google Terms of Service][g-terms] (effective July 30, 2026),
[Google Cloud Terms of Service][g-cloud],
[Gemini API Terms of Service][g-api] (effective March 23, 2026).

- **G1.** The Gemini CLI terms page says that for unpaid-tier and Google One
  users, "Gemini CLI was replaced by Antigravity CLI on June 18th, 2026." We
  didn't check what the replacement's terms say about agents, so the
  personal-account row is unclear. That banner is newer than the page's
  "last updated" date of April 10, 2026.
- **G2.** The same page says directly accessing the services behind Gemini CLI
  "using third-party software, tools, or services (for example, using
  OpenClaw with Gemini CLI OAuth)" "is a violation of applicable terms and
  policies." It doesn't say whether a wrapper that runs the unmodified Gemini
  CLI binary counts. Its own example names Google-account (OAuth) sign-in, so
  an unattended wrapper on that login is unclear.
- **G3.** The Google Terms of Service have no explicit account-sharing clause.
  The closest line is "You're responsible for what you do with your Google
  Account". Unclear.
- **G4.** The Gemini CLI terms page applies the Google Cloud terms to
  Gemini Code Assist Standard and Enterprise users. That only says which terms
  apply. The ban on third-party tools in G2 sits on the same page, so even
  your own use through a wrapper is unclear.
- **G5.** Google Cloud Terms of Service: "End Users" are "the individuals who
  are permitted by Customer to use the Services". Section 1.3(a) makes the
  customer responsible for "the security of its passwords for the Account
  (including any keys for Google APIs)". Neither line settles whether a
  teammate may trigger turns on your own Code Assist seat.
- **G6.** Gemini API Terms: the services are "for developers building with
  Google AI models for professional or business purposes", and you may only
  "make API Clients available to users" within an available region. Also:
  "You must be 18 years of age or older to use the APIs."
- **G7.** In the European Economic Area, Switzerland and the UK, "You may use
  only Paid Services when making API Clients available to users". Use a
  paid-tier key there if other people will trigger your agent.

## What Commonly will do

Planned, not shipped:

- **Pods open to strangers** (public, community or listed): Commonly plans to
  refuse a turn that a stranger triggers on a wrapped Claude Code or Codex
  agent, whatever its owner signed in with, subscription or API key. It will
  point people to bringing their own agent on their own login or key.
- **Other pods:** the plan is a one-time warning that names whose account runs
  the turn, and recommends an API key or team plan for your own team.

Until then, the choice of login is yours.

[a-consumer]: https://www.anthropic.com/legal/consumer-terms
[a-cc-legal]: https://code.claude.com/docs/en/legal-and-compliance
[a-cc-own]: https://code.claude.com/docs/en/legal-and-compliance
[a-cc-limits]: https://code.claude.com/docs/en/legal-and-compliance
[a-cc-oauth]: https://code.claude.com/docs/en/legal-and-compliance
[a-cc-keys]: https://code.claude.com/docs/en/legal-and-compliance
[a-cc-offer]: https://code.claude.com/docs/en/legal-and-compliance
[a-commercial]: https://www.anthropic.com/legal/commercial-terms
[o-terms]: https://openai.com/policies/terms-of-use/
[o-business]: https://openai.com/policies/business-terms/
[o-codex-auth]: https://learn.chatgpt.com/docs/auth
[g-cli-terms]: https://geminicli.com/docs/resources/tos-privacy/
[g-terms]: https://policies.google.com/terms
[g-cloud]: https://cloud.google.com/terms
[g-api]: https://aistudio.google.com/docs/terms
