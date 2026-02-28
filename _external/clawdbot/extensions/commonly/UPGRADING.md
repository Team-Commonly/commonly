# Upgrading OpenClaw

The `extensions/commonly/` directory is self-contained — it has no imports from `src/channels/commonly/` (which no longer exists) or from any other Commonly-custom code in `src/`. This means upgrading OpenClaw to a newer release only requires replacing the core `src/` tree.

## Upgrade steps

1. **Clone or download the new OpenClaw release:**
   ```bash
   git clone https://github.com/openclaw/openclaw /tmp/openclaw-new
   # or: download and extract the release tarball
   ```

2. **Replace `_external/clawdbot/` with the new release, preserving our extension:**
   ```bash
   # From the commonly repo root
   rsync -av --exclude='extensions/commonly/' \
     /tmp/openclaw-new/ \
     _external/clawdbot/
   ```
   Alternatively, copy everything except `extensions/commonly/` manually.

3. **Re-install dependencies:**
   ```bash
   cd _external/clawdbot
   pnpm install
   ```

4. **Check for plugin-SDK breaking changes:**
   Open `src/plugin-sdk/index.ts` and verify that the interfaces used by our extension still exist:
   - `OpenClawPluginApi` — used in `extensions/commonly/index.ts`
   - `ChannelPlugin`, `ReplyPayload` — used in `extensions/commonly/src/channel.ts`
   - `buildChannelConfigSchema`, `createReplyPrefixContext`, `DEFAULT_ACCOUNT_ID` — used in `extensions/commonly/src/channel.ts`
   - `jsonResult`, `readNumberParam`, `readStringParam` — used in `extensions/commonly/src/tools.ts`

   Also check `src/agents/tools/common.ts` still exports `AnyAgentTool`, `readStringArrayParam` (imported by `extensions/commonly/src/tools.ts`).

5. **Run tests:**
   ```bash
   cd _external/clawdbot
   pnpm test
   ```
   If `extensions/commonly/` tests pass, the extension is compatible with the new version.

6. **Commit:**
   ```bash
   git add _external/clawdbot/
   git commit -m "[commonly] Upgrade OpenClaw to vXXXX.X.X"
   ```

## What lives where

| Location | Owner | Touches upstream upgrade? |
|---|---|---|
| `extensions/commonly/` | Commonly team | No — excluded from upgrade |
| `src/` (everything else) | OpenClaw upstream | Yes — replaced wholesale |

## Upstream repository

`https://github.com/openclaw/openclaw`
