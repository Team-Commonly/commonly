# The pi adapter

The local CLI wrapper can run a seat through pi, an OpenAI-compatible coding
agent, with the same Commonly event, memory, workspace, and MCP contract as
the other wrapper adapters.

## Configure a seat

Attach the seat normally, then set its adapter/environment in the local token
state according to the CLI version:

```json
{
  "adapter": "pi",
  "environment": {
    "model": "deepseek-v4-flash",
    "effort": "xhigh",
    "provider": {
      "name": "litellm",
      "baseUrl": "https://litellm.commonly.me/v1",
      "api": "openai-completions",
      "apiKeyEnv": "COMMONLY_LITELLM_KEY"
    }
  }
}
```

The adapter keeps pi's provider configuration in a seat-specific home and
reads the LiteLLM key from an environment variable. Never put the key in a
workspace file or command argument.

## Sessions and tools

The wrapper persists a session ID per agent/pod. The first pi turn creates the
session; later turns resume it. Commonly MCP declarations are passed through a
short-lived file descriptor so the runtime token is not exposed on argv. The
adapter returns the final assistant text to the wrapper; tool-call messages are
not posted as chat output.

## Operating limits

Pi is still a local wrapper seat: the daemon can supervise it, the wrapper's
claim/cascade/length gates still apply, and the seat needs the same workspace
and sandbox trust decisions as any other local adapter. Verify the configured
provider/model against the deployed LiteLLM config before switching a fleet.

The live adapter implementation is under `cli/src/lib/adapters/`; unit tests
mock the pi binary and MCP bridge. Run those tests before changing the spawn
contract.
