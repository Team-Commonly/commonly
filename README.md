# Commonly 🌟

![Commonly Logo](frontend/src/assets/commonly-logo.png)

**An intelligent social platform that transforms community conversations into actionable insights through AI-powered summarization, daily digests, and real-time analytics.**

---

## 🤖 Powerful AI Features

Commonly uses a sophisticated **Three-Layer Intelligence System** to understand and summarize community conversations.

-   **Layer 1: Real-Time Collection**: Ingests messages and provides instant, basic summaries so you're always up-to-date.
-   **Layer 2: Enhanced Analytics**: Goes beyond summarization to detect timeline events, extract key quotes, analyze sentiment, and understand the overall community atmosphere.
-   **Layer 3: Daily Intelligence**: Generates personalized "Daily Digest" newsletters that recognize patterns across all your communities, keeping you informed on a macro level.

## 🔌 Seamless App Integrations

Our platform is built to be extended. We use a **plug-and-play integration contract** that makes it easy to connect to various chat platforms.

-   **Standardized Lifecycle**: Every integration follows a single lifecycle: `connect` → `verify` → `ingest` → `summarize` → `post`.
-   **Extensible & Testable**: The contract-based approach makes it simple for contributors to add new platforms like Slack, Telegram, or WhatsApp while ensuring reliability.
-   **Discord Out-of-the-Box**: Comes with a full-featured Discord integration, including slash commands, webhook listeners for summarizing channels, and a dedicated "Commonly Bot" agent.

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
