# Slack connector

Commonly connects a Slack direct message to a pod. The person connecting it
authorizes the Slack app, checks the workspace and Slack user in Commonly, and
confirms the connection. A plain DM addresses the active pod's selected lead;
an explicit `@agent` or a reply to a relayed agent line keeps its own target.
The agent's answer can return to the DM. See the [user walkthrough](../../docs-site/integrations/slack.mdx).

## Configure the Slack app

One Slack app serves the instance. Its OAuth redirect is
`https://api.commonly.me/api/webhooks/slack/oauth/callback` on the hosted
instance. The OAuth flow requests `im:history`, `im:write`, `chat:write`,
`users:read`, and `commands`. Register `/commonly` at
`https://api.commonly.me/api/webhooks/slack/commands`.

Two settings in the Slack app itself are necessary for inbound DMs; backend
tests cannot verify them:

1. Under **App Home**, turn on the **Messages Tab** and tick **Allow users to
   send Slash commands and messages from the messages tab**. In a manifest,
   these are `features.app_home.messages_tab_enabled: true` and
   `messages_tab_read_only_enabled: false`. Without both, Slack shows
   “Sending messages to this app has been turned off.”
2. Under **Event Subscriptions**, verify the Request URL
   `https://api.commonly.me/api/webhooks/slack/events` and subscribe to the
   `message.im` bot event. Deploy `SLACK_SIGNING_SECRET` first: Slack sends a
   signed URL verification challenge when the URL is saved, and the route
   checks the signature before answering it. If the app previously used
   Socket Mode, disable it after verifying the HTTP Request URL.

Activate **Public Distribution** under **Manage Distribution** so workspaces
other than the app's own can install it.

For a self-hosted instance, replace the hosted URLs with that instance's
public API URL. Set `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, and
`SLACK_SIGNING_SECRET` on the backend, plus the connector credential key ring
described in the [operator runbook](../runbooks/connector-credentials-setup.md).
The OAuth bind encrypts the bot token and stores its `botTokenRef` on the
connection. Do not paste a signing secret or bot token into a connection row.

## Verify the connection

In Commonly, choose **Connectors → Slack → Add**, select a pod, authorize the
app in Slack, choose an agent from the selected pod at confirmation, and
confirm the returned workspace and user. Send a plain DM and check that it
addresses that agent in the pod and that the answer returns to Slack. If the
pod has no agent yet, confirmation remains available; a plain DM reaches the
pod and gets an explicit notice in Slack that no lead is selected. The lead
belongs to each pod's gate, so changing the active pod changes the plain DM
target. The HTTP events route accepts signed `message.im` events;
the relay requires an active DM binding. `/commonly status` reports the relay
mode, and `/commonly mode mirror|attention` changes it for that binding.

The old `POST /api/webhooks/slack/:integrationId` route still accepts events
for legacy rows. It is not the install path above. Its per-row `signingSecret`
is ignored; the instance's `SLACK_SIGNING_SECRET` verifies both routes. New
work should use the OAuth connector and the `/events` Request URL.
