# Commonly 🌟

[![Tests](https://github.com/Team-Commonly/commonly/actions/workflows/tests.yml/badge.svg)](https://github.com/Team-Commonly/commonly/actions/workflows/tests.yml)
[![Lint](https://github.com/Team-Commonly/commonly/actions/workflows/lint.yml/badge.svg)](https://github.com/Team-Commonly/commonly/actions/workflows/lint.yml)
[![Discord Integration](https://img.shields.io/badge/Discord-Integrated-7289DA?logo=discord)](https://discord.com)
[![AI Powered](https://img.shields.io/badge/AI-Powered-FF6B6B?logo=google)](https://ai.google.dev/)

**An intelligent social platform that transforms community conversations into actionable insights through AI-powered summarization, daily digests, and real-time analytics.**

---

## 🚀 **What Makes Commonly Special**

Commonly isn't just another social platform—it's your **AI-powered community intelligence system** that:

- 🧠 **Understands Your Communities** with sophisticated AI analysis
- 📧 **Delivers Personalized Daily Newsletters** with engaging insights
- 🔄 **Provides Real-time Community Pulse** monitoring
- 🌉 **Bridges Multiple Platforms** (Discord, and more coming)
- 📊 **Offers Deep Analytics** on community health and engagement

---

## ✨ **Core Features**

### 🤖 **Intelligent Summarization System**
- **Smart "What's Happening" Feed**: AI-generated summaries of community activity
- **Enhanced Refresh**: Triggers fresh analysis, not just cached data
- **Auto Data Cleanup**: Prevents corruption with intelligent garbage collection
- **Rich Analytics**: Timeline events, quotes, insights, and atmosphere analysis

### 📰 **Daily Digest & Newsletter System**
- **Personalized Newsletters**: AI-crafted daily digests for each user
- **Cross-Conversation Insights**: Patterns and connections across multiple communities
- **Professional Formatting**: Engaging markdown with "Today's Highlights"
- **Customizable Preferences**: Frequency, delivery time, and content types

### 🏠 **Multi-Pod Community System**
- **Chat Pods**: Real-time conversations with Socket.io
- **Study Pods**: Focused learning and collaboration spaces
- **Game Pods**: Gaming communities and coordination
- **Flexible Architecture**: Easy to add new pod types

### 🌉 **Discord Integration**
- **Bidirectional Sync**: Discord ↔ Commonly message bridging
- **Slash Commands**: `/commonly-summary`, `/discord-status`, `/discord-push`
- **Automated Bot Posting**: @commonly-bot delivers summaries to pods
- **Webhook Listeners**: Real-time Discord activity aggregation

### 🗄️ **Dual Database Architecture**
- **MongoDB**: User profiles, posts, pod metadata, and authentication (primary)
- **PostgreSQL**: Chat messages, user references, message persistence (default for chat)
- **Smart Synchronization**: Automatic user/pod sync between databases
- **Graceful Fallback**: MongoDB fallback if PostgreSQL unavailable
- **Message Persistence**: All chat messages now persist across page refreshes

---

## 🏗️ **Architecture Overview**

### **Three-Layer Intelligence System**

```
┌─────────────────────────────────────────────────┐
│                  Layer 3                        │
│           Daily Intelligence                    │
│   • Personalized Digests                       │
│   • Cross-Conversation Insights                │
│   • User Preference Management                 │
└─────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────┐
│                  Layer 2                        │
│          Enhanced Analytics                     │
│   • Timeline Events • Quote Extraction         │
│   • Insight Detection • Atmosphere Analysis    │
└─────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────┐
│                  Layer 1                        │
│         Real-time Collection                    │
│   • Message Capture • Basic Summaries          │
│   • Immediate Display • Background Processing  │
└─────────────────────────────────────────────────┘
```

### **Service Architecture**

```
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│   Frontend       │  │     Backend      │  │   Databases      │
│   React + MUI    │◄─┤  Node.js + AI    ├─►│ MongoDB + PgSQL  │
│   Socket.io      │  │  Express + Cron  │  │ Dual Architecture│
└──────────────────┘  └──────────────────┘  └──────────────────┘
                                ▲
                                │
                      ┌──────────────────┐
                      │  External APIs   │
                      │ Discord • Gemini │
                      │ SendGrid • More  │
                      └──────────────────┘
```

---

## 🛠️ **Quick Start**

### **Prerequisites**
- Docker & Docker Compose
- Node.js 18+ (for local development)
- Git

### **Development Setup**

```bash
# 1. Clone the repository
git clone https://github.com/Team-Commonly/commonly.git
cd commonly

# 2. Download PostgreSQL certificate
node download-ca.js

# 3. Set up environment
cp .env.example .env
# Edit .env with your configuration

# 4. Start development environment
./dev.sh up

# 5. Access the application
# Frontend: http://localhost:3000
# Backend: http://localhost:5000
```

### **Production Deployment**

```bash
# Production environment
./prod.sh deploy

# Or manually
docker-compose -f docker-compose.yml up -d
```

---

## 🧪 **Testing**

### **Automated Testing**
```bash
# Run all tests
./dev.sh test

# Specific test suites
cd backend && npm test
cd frontend && npm test

# With coverage
npm run test:coverage
```

### **Feature Testing**
```bash
# Test daily digest generation
curl -X POST localhost:5000/api/summaries/daily-digest/generate \
  -H "Authorization: Bearer YOUR_TOKEN"

# Test enhanced summarization
curl -X POST localhost:5000/api/summaries/trigger \
  -H "Authorization: Bearer YOUR_TOKEN"

# Test Discord commands
# Use slash commands in Discord: /commonly-summary, /discord-push
```

---

## 📚 **Documentation**

### **Core Documentation**
- 📖 **[CLAUDE.md](./CLAUDE.md)** - Complete development guide with commands and architecture
- 🏗️ **[Architecture Deep Dive](./docs/ARCHITECTURE.md)** - System design and data flow
- 🌐 **[API Reference](./docs/API.md)** - Complete endpoint documentation
- 🎨 **[Frontend Guide](./docs/FRONTEND.md)** - React components and patterns

### **Feature Documentation**
- 🤖 **[AI & Summarization](./docs/AI_FEATURES.md)** - Intelligence system details
- 📧 **[Daily Digests](./docs/DAILY_DIGESTS.md)** - Newsletter system guide
- 🎮 **[Discord Integration](./docs/DISCORD.md)** - Bot setup and commands
- 🗄️ **[Database Design](./docs/DATABASE.md)** - Schema and optimization

### **Operations**
- 🚀 **[Deployment Guide](./docs/DEPLOYMENT.md)** - Production setup
- 🔧 **[Configuration](./docs/CONFIGURATION.md)** - Environment variables
- 📊 **[Monitoring](./docs/MONITORING.md)** - Health checks and metrics
- 🐛 **[Troubleshooting](./docs/TROUBLESHOOTING.md)** - Common issues and fixes

---

## 🎯 **Key APIs**

### **Intelligent Summarization**
```javascript
// Enhanced summary with garbage collection
POST /api/summaries/trigger

// Get latest AI summaries
GET /api/summaries/latest

// Pod-specific refresh
POST /api/summaries/pod/:podId/refresh
```

### **Daily Digest System**
```javascript
// Generate personalized digest
POST /api/summaries/daily-digest/generate

// Get user's latest digest
GET /api/summaries/daily-digest

// Digest history
GET /api/summaries/daily-digest/history
```

### **Community Management**
```javascript
// Create pods
POST /api/pods

// Real-time messaging
Socket.io events: 'message', 'userJoined', 'userLeft'

// User management
POST /api/auth/register
POST /api/auth/login
```

---

## 🔧 **Development Commands**

### **Docker Environment**
```bash
# Development (recommended)
./dev.sh up              # Start with live reloading
./dev.sh logs backend    # View service logs
./dev.sh shell backend   # Open container shell
./dev.sh clean           # Clean up everything

# Production
./prod.sh deploy         # Build and deploy
./prod.sh logs           # View production logs
```

### **AI & Summarization**
```bash
# Deploy Discord commands
docker-compose -f docker-compose.dev.yml exec -T backend npm run discord:deploy

# Generate daily digests
curl -X POST localhost:5000/api/summaries/daily-digest/trigger-all

# Manual garbage collection
curl -X POST localhost:5000/api/summaries/trigger
```

### **Database Operations**
```bash
# MongoDB access
docker-compose -f docker-compose.dev.yml exec backend mongo mongodb://mongo:27017/commonly

# PostgreSQL access
docker-compose -f docker-compose.dev.yml exec postgres psql -U user -d commonly
```

---

## 🌟 **What's New in Latest Release**

### **🧠 Intelligent Summarization 2.0**
- Enhanced AI prompts with structured analytics extraction
- Real-time garbage collection preventing data corruption
- Timeline event detection and quote extraction
- Community atmosphere and engagement analysis

### **📧 Daily Digest System**
- Personalized AI-generated newsletters
- Cross-pod insight aggregation
- Customizable subscription preferences
- Professional markdown formatting

### **🌉 Enhanced Discord Integration**
- New `/discord-push` command for immediate activity sync
- Improved status display with pod information
- Better error handling and user feedback
- Automated @commonly-bot summary posting

### **🗄️ Database & Performance**
- Intelligent garbage collection system
- Enhanced schema with analytics support
- Optimized caching strategies
- Better validation and error recovery

---

## 🤝 **Contributing**

We welcome contributions! Here's how to get started:

1. **Fork the repository**
2. **Create a feature branch**: `git checkout -b feature/amazing-feature`
3. **Follow our coding standards**: `npm run lint:fix`
4. **Write tests**: Ensure `npm test` passes
5. **Submit a pull request** with a clear description

### **Development Guidelines**
- Follow ESLint configuration
- Write comprehensive tests
- Update documentation for new features
- Use conventional commit messages

---

## 📊 **Tech Stack**

### **Frontend**
- ⚛️ **React 18** with hooks and context
- 🎨 **Material-UI (MUI)** for consistent design
- 🔌 **Socket.io Client** for real-time features
- 📱 **Responsive Design** with mobile-first approach

### **Backend**
- 🟢 **Node.js + Express** for API and WebSocket handling
- 🤖 **Google Gemini AI** for intelligent summarization
- ⏰ **Node-cron** for scheduled tasks and automation
- 🔒 **JWT Authentication** with bcrypt security

### **Databases**
- 🍃 **MongoDB** for user data, posts, and summaries
- 🐘 **PostgreSQL** for chat messages and real-time features
- 📊 **Optimized Indexing** for performance
- 🔄 **Intelligent Data Routing** based on use case

### **Infrastructure**
- 🐳 **Docker & Docker Compose** for containerization
- 🌐 **Discord API** for bot integration
- 📧 **SendGrid** for email notifications
- ☁️ **Production Ready** with health checks

---

## 📈 **Roadmap**

### **Coming Soon**
- 🔔 **Email Newsletter Delivery** - Automated digest emails
- 📱 **Mobile App** - Native iOS and Android apps
- 🔍 **Advanced Search** - AI-powered content discovery
- 🎨 **Customizable Themes** - User interface personalization

### **Future Vision**
- 🌍 **Multi-Platform Integration** - Slack, Teams, WhatsApp
- 🧠 **Advanced AI Features** - Sentiment trends, user insights
- 📊 **Analytics Dashboard** - Community manager tools
- 🔌 **Plugin System** - Third-party integrations

---

## 🆘 **Support & Community**

- 📖 **Documentation**: Check [CLAUDE.md](./CLAUDE.md) for detailed guides
- 🐛 **Bug Reports**: [GitHub Issues](https://github.com/Team-Commonly/commonly/issues)
- 💬 **Discord Community**: [Join our server](https://discord.gg/commonly)
- 📧 **Contact**: team@commonly.app

---

## 📄 **License**

This project is licensed under the MIT License - see the [LICENSE](./LICENSE) file for details.

---

## ⭐ **Star Us!**

If Commonly helps your community, please consider giving us a star! ⭐

**Built with ❤️ by the Commonly Team**

---

*Transform your community conversations into intelligent insights with Commonly - where AI meets authentic human connection.*