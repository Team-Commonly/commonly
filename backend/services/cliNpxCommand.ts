// The Commonly CLI run through npx, the form the Bring your own page shows
// (V2AgentBYO.tsx CLI_NPX_COMMAND, F570). Every line the server gives a person,
// or an agent relaying to one, starts with this rather than a bare `commonly`:
// `npm i -g @commonlyai/cli` stops with EACCES on a stock-Node Mac (the
// nodejs.org installer leaves npm's global prefix root-owned), so nothing gets
// installed and the next bare `commonly` line is "command not found" (F582).
// `daemon setup` is the one exception, and it installs its own stable copy.
// agentStateService.runInstruction.test.js keeps this equal to the page's.
export const CLI_NPX_COMMAND = 'npx -y @commonlyai/cli@latest';
