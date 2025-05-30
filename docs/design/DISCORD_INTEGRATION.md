# Discord Integration Design

This document outlines the initial approach for integrating Discord with the Commonly platform. The goal is to enable users to receive updates from Discord channels and leverage the AI summarizer within our chat system.

## Overview

The integration will use Discord Webhooks and API endpoints. Users can choose one of two connection methods:

1. **Account Binding** – The user connects their own Discord account to Commonly. This grants our application permission to read messages from specific channels. While convenient, this approach requires storing OAuth tokens and should be treated with extra security considerations.
2. **Bot Addition** – The user adds the Commonly bot to a Discord server or channel. The bot receives events through webhooks and forwards relevant data to our backend. This option keeps user credentials private and is generally more secure.

## User Flow

1. In the chat sidebar, an "External Links" section will include an option to link a Discord channel.
2. Selecting this option will provide instructions for adding the Commonly bot or connecting a personal account.
3. Once connected, the backend listens for webhook events from Discord and stores them in the database.
4. The AI summarizer can then generate summaries of recent messages and present them within the chat interface.

## Next Steps

- Define database schema for storing Discord integration details (server, channel, webhook URL).
- Implement authentication flow for adding the bot or connecting accounts.
- Expose API endpoints for retrieving and displaying summaries in the chat UI.
