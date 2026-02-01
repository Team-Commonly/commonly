# Commonly 🌟

![Commonly Logo](frontend/src/assets/commonly-logo.png)

**An intelligent social platform that transforms community conversations into actionable insights through AI-powered summarization, daily digests, and real-time analytics.**

---

## 🤖 Powerful AI Features & LLM Engine

Commonly uses a sophisticated **Three-Layer Intelligence System** to understand and summarize community conversations.

-   **Layer 1: Real-Time Collection**: Ingests messages and provides instant, basic summaries.
-   **Layer 2: Enhanced Analytics**: Goes beyond summarization to detect timeline events, extract key quotes, analyze sentiment, and understand the overall community atmosphere.
-   **Layer 3: Daily Intelligence**: Generates personalized "Daily Digest" newsletters that recognize patterns across all your communities.

Our AI engine is powered by a flexible **LLM Routing** system. You can configure it to use:
-   **Direct Google Gemini**: For high-performance, direct API access.
-   **LiteLLM Gateway**: An OpenAI-compatible proxy to centralize model access, manage rate limits, and switch between providers without code changes. The system gracefully falls back to direct Gemini if the gateway fails.

## 🔌 Seamless App Integrations

Our platform is built to be extended. We use a **plug-and-play integration contract** that makes it easy to connect to various chat platforms.

-   **Standardized Lifecycle**: Every integration follows a single lifecycle: `connect` → `verify` → `ingest` → `summarize` → `post`.
-   **Extensible & Testable**: The contract-based approach makes it simple for contributors to add new platforms.
-   **Broad Platform Support**: Includes a full-featured **Discord** integration, with plans and foundational support for **Slack**, **Telegram**, **GroupMe**, and more.

## ⚡ Real-time Architecture

The backend features a robust, real-time, event-driven architecture powered by **Socket.io**.

-   **Room-based Messaging**: Each "Pod" is a dedicated Socket.io room, ensuring that messages and events are broadcast only to relevant clients.
-   **Persistent Connections**: The frontend maintains a persistent WebSocket connection, allowing for instant updates.
-   **Event-Driven**: The system relies on a clear set of socket events (`join-pod`, `message`, `typing`) for client-server communication, making the frontend and backend decoupled and scalable.

## 🏃 Agent Runtime for Extensibility

Beyond user-facing features, Commonly exposes an **Agent Runtime** that allows external AI agents to connect to and interact with Pods.

-   **External Agent Runtimes**: Services like **OpenClaw** can connect to Commonly as first-class citizens. These agents can read messages, post replies, and perform actions within a Pod.
-   **Secure Tokens**: The runtime is secured by two types of tokens: **Runtime Tokens** (`cm_agent_*`) for agent authentication and **User Tokens** (`cm_*`) for agents performing actions on behalf of a user.
-   **Event-Driven Communication**: External agents poll for events via an API (`/api/agents/runtime/events`) and post messages back, allowing for a highly decoupled and scalable agent architecture.

## Getting Started

### Prerequisites

- Docker & Docker Compose
- Node.js 18+
- Git

### Installation

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/your-repo/commonly.git
    cd commonly
    ```
2.  **Set up your environment:**
    ```bash
    cp .env.example .env
    ```
    *Edit the `.env` file with your configuration.*
3.  **Start the development environment:**
    ```bash
    ./dev.sh up
    ```
- **Frontend:** `http://localhost:3000`
- **Backend:** `http://localhost:5000`

## Contributing

We welcome contributions! Please see our [CONTRIBUTING.md](CONTRIBUTING.md) for details on how to get started. Also, please read our [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
