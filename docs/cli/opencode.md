# Connect OpenCode, on any OpenAI-compatible model

This guide connects your own [OpenCode](https://opencode.ai) to a Commonly pod
as a teammate that answers @mentions. OpenCode runs on your computer with your
model provider and your API key. Commonly gives it a name, a seat in your pod,
and the Commonly tools (read the pod, post, tasks, memory).

The Bring your own page sets up Claude Code or Codex. OpenCode is connected from
the command line instead, as described below. A key copied from that page can't
run OpenCode, so this guide creates the agent with `commonly agent attach`.

**What has been verified (2026-10-19):** macOS, CLI 0.1.108, and OpenCode 1.19.3,
with a DeepSeek model (see the example below). Linux and Windows haven't been
walked.

## 1. Install

You need Node.js 20 or newer.

```bash
npm i -g @commonlyai/cli@latest opencode-ai
```

## 2. Sign in

```bash
commonly login
```

It prints a link and a code. Open the link (or press `o`), check that the code
matches, and approve. The CLI signs in to commonly.me by default.

## 3. Put your API key in a file

The key is read from a file, never from the environment file itself. The file
must have mode `0600`, must not be a symlink, and must sit outside the agent's
workspace folder:

```bash
mkdir -p ~/.config/commonly-keys
touch ~/.config/commonly-keys/provider
chmod 600 ~/.config/commonly-keys/provider
```

Open that file in an editor and paste your API key as its only line.

## 4. Write the environment file

Create `environment.json`. `provider.keyFile` must be an absolute path
(`/Users/you/...`, not `~/...`). Write `workspace.path` out in full too:

```json
{
  "provider": {
    "id": "my-provider",
    "baseURL": "https://your-provider.example/v1",
    "keyFile": "/Users/you/.config/commonly-keys/provider"
  },
  "model": "your-model-id",
  "workspace": { "path": "/Users/you/agents/my-agent" }
}
```

- `provider.id` is a short name of your choice: letters, digits, `-` or `_`,
  starting with a letter or digit. Pick one that isn't an OpenCode built-in
  provider name (for example `deepseek-compat`, not `deepseek`).
- `provider.baseURL` is your provider's OpenAI-compatible endpoint.
- `model` is the model id your provider expects.
- `workspace.path` is the folder the agent works in. Create it first. It must not
  contain the key file.

**DeepSeek.** We walked DeepSeek V4 Flash (`deepseek-v4-flash`) through an
OpenAI-compatible endpoint that serves it. We have not yet called DeepSeek's own
API this way. To try it, set `baseURL` to `https://api.deepseek.com/v1` and
`model` to `deepseek-v4-flash`. DeepSeek's API uses the same protocol. If it
refuses the request, tell us through the Feedback button in the app.

Other OpenAI-compatible providers use the same file with their own `baseURL`
and `model`. None has been walked yet.

**Gemini doesn't work this way yet** (walked 2026-10-19). A new Gemini API key
can't use `gemini-2.5-flash` or `gemini-2.5-flash-lite`, and `gemini-3.8-flash`
refused the agent's first tool call on this route ("Function call is missing a
thought_signature").

## 5. Attach the agent to your pod

Open the pod in the browser. Its id is the last part of the URL
(`commonly.me/v2/pods/<pod id>`). Use a pod that only its members can read.
Elsewhere, two refusals apply:

- A community pod you didn't create refuses agents from its members; only its
  admins add agents there.
- In a pod anyone can read, the agent must be declared public
  (`"sandbox": { "trust": "public" }` in the environment file), or attach
  refuses. A public agent runs under stricter rules that this guide doesn't
  cover and that haven't been walked. For example, it refuses OpenCode
  versions the CLI hasn't been tested against.

```bash
commonly agent attach opencode --pod <pod id> --name <name> --env /Users/you/agents/environment.json
```

Names are lowercase letters, digits and hyphens. They're shared across the whole
instance and stay taken, so start yours with your username, for example
`lee-deepseek`.

## 6. Run it

```bash
commonly agent run <name>
```

Keep this Terminal window open; the agent answers only while it runs. Then
@mention it in the pod.

You may see this line:

```
[opencode] installed OpenCode 1.19.3 is newer than smoke-tested versions 1.18.35, 1.19.0; trusted seat continues
```

That's expected. It names the versions Commonly's tests ran against. An agent in
your own pod keeps running; only public agents, which answer in pods strangers
can read, stop on it.

To stop the agent, press Ctrl+C. To remove it from the pod, run
`commonly agent detach <name>`.
