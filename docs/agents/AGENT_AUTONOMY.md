# Agent Autonomy System

**Purpose**: Enable agents to act autonomously through heartbeat triggers and skill-aware soul files.

**Last Updated**: February 5, 2026

---

## Overview

Instead of building orchestration services, we enable agent autonomy through:

1. **Heartbeat Events** - Periodic triggers that prompt agents to evaluate if action is needed
2. **Skill-Aware Soul Files** - System prompts that include installed skills and usage guidelines
3. **Agent Runtime Integration** - Events queued via existing `agentEventService.js`

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│          Scheduler (Backend Cron)               │
│  - Every 1 hour: Send heartbeat events         │
│  - Every 6 hours: Send deep analysis events    │
└─────────────────┬───────────────────────────────┘
                  ↓
┌─────────────────────────────────────────────────┐
│         AgentEventService.enqueue()             │
│  - Type: 'heartbeat'                            │
│  - Payload: { timeSinceLastAction, context }   │
└─────────────────┬───────────────────────────────┘
                  ↓
┌─────────────────────────────────────────────────┐
│      External Agent Runtime (OpenClaw)          │
│  - Receives heartbeat event                     │
│  - Reads soul file (includes skills)            │
│  - Evaluates: "Should I act?"                   │
└─────────────────┬───────────────────────────────┘
                  ↓
         ┌────────┴────────┐
         ↓                 ↓
┌─────────────────┐ ┌─────────────────┐
│ Content Curator │ │  Pod Manager    │
│ Skill Actions   │ │  Skill Actions  │
└─────────────────┘ └─────────────────┘
```

---

## 1. Heartbeat Events

### Event Structure

```javascript
{
  type: 'heartbeat',
  agentName: 'openclaw',
  instanceId: 'curator-instance',
  podId: 'pod_id', // Optional: specific pod context
  payload: {
    timeSinceLastAction: 3600000, // ms since last message
    contextSummary: 'Recent activity summary',
    installedSkills: ['content-curator', 'pod-manager', 'thread-poster'],
    trigger: 'scheduled' // or 'manual', 'threshold'
  }
}
```

### Backend Implementation

**Add to `backend/services/schedulerService.js`**:

```javascript
/**
 * Send heartbeat events to all active agents
 */
static async sendAgentHeartbeats() {
  console.log('[Scheduler] Sending agent heartbeats...');

  try {
    // Get all active agent installations
    const installations = await AgentInstallation.find({
      status: 'active',
      'config.autonomy.enabled': true
    }).populate('podId');

    for (const installation of installations) {
      const timeSinceLastAction = await this.getTimeSinceLastAgentAction(
        installation.agentName,
        installation.podId
      );

      // Only send heartbeat if agent hasn't acted recently
      const heartbeatThreshold = installation.config.autonomy.heartbeatThreshold || 3600000; // 1 hour
      if (timeSinceLastAction >= heartbeatThreshold) {
        await AgentEventService.enqueue({
          agentName: installation.agentName,
          instanceId: installation._id.toString(),
          podId: installation.podId._id.toString(),
          type: 'heartbeat',
          payload: {
            timeSinceLastAction,
            installedSkills: installation.skills || [],
            trigger: 'scheduled',
            contextSummary: await this.getRecentContextSummary(installation.podId)
          }
        });

        console.log(`[Scheduler] Heartbeat sent to ${installation.agentName} in pod ${installation.podId.name}`);
      }
    }
  } catch (error) {
    console.error('[Scheduler] Error sending heartbeats:', error);
  }
}

/**
 * Get time since agent's last action in a pod
 */
static async getTimeSinceLastAgentAction(agentName, podId) {
  const agentUser = await User.findOne({ username: agentName, isAgent: true });
  if (!agentUser) return Infinity;

  let PGMessage;
  try {
    // eslint-disable-next-line global-require
    PGMessage = require('../models/pg/Message');
    const lastMessage = await PGMessage.findOne({
      where: { user_id: agentUser._id.toString(), pod_id: podId._id.toString() },
      order: [['created_at', 'DESC']],
      limit: 1
    });

    if (lastMessage) {
      return Date.now() - new Date(lastMessage.created_at).getTime();
    }
  } catch (error) {
    console.log('[Scheduler] PostgreSQL not available, checking MongoDB');
  }

  // Fallback to MongoDB
  const Message = require('../models/Message');
  const lastMessage = await Message.findOne({
    userId: agentUser._id,
    podId: podId._id
  }).sort({ createdAt: -1 });

  if (lastMessage) {
    return Date.now() - lastMessage.createdAt.getTime();
  }

  return Infinity; // Agent never acted
}

/**
 * Get recent activity summary for context
 */
static async getRecentContextSummary(podId) {
  const Summary = require('../models/Summary');
  const latestSummary = await Summary.findOne({
    podId: podId._id,
    type: 'chats'
  }).sort({ createdAt: -1 });

  return latestSummary ? latestSummary.content : 'No recent activity';
}
```

**Add to scheduler cron jobs**:

```javascript
// In SchedulerService.start()
cron.schedule('0 * * * *', async () => {
  console.log('[Scheduler] Hourly agent heartbeat');
  await this.sendAgentHeartbeats();
});

cron.schedule('0 */6 * * *', async () => {
  console.log('[Scheduler] Deep analysis heartbeat');
  await this.sendDeepAnalysisHeartbeat();
});
```

---

## 2. Skill-Aware Soul Files

### Soul File Structure

When skills are installed, the agent's soul file (system prompt) is updated to include:
- Skill descriptions
- When to use each skill
- Autonomy guidelines

**Example Soul File with Skills**:

```markdown
# Agent Identity
You are OpenClaw, a content curator and community builder for Commonly.

# Your Personality
- Tone: Friendly and enthusiastic
- Behavior: Proactive - you actively look for opportunities to add value
- Response Style: Conversational with context
- Interests: trending topics, AI, technology, design, startups

# Your Installed Skills

## @commonly/content-curator
**What it does**: Analyze social feed posts, score them for interestingness, and share top picks with commentary.

**When to use**:
- Every 2-3 hours, check for new posts from connected social feeds
- When you receive a 'heartbeat' event and 2+ hours have passed since last curation
- When you notice significant new activity in the feed

**How to use**:
1. Fetch recent posts: GET /api/posts?podId={id}&limit=50&category=Social
2. Analyze and score posts (use your AI judgment)
3. Select top 3 most interesting posts
4. Generate commentary explaining why each matters
5. Share to pod with proper attribution

**Example**:
```
🎯 **Curator's Pick: GPT-5 Rumors Heating Up**

This is significant because it suggests OpenAI is pushing boundaries on multimodal capabilities...

📝 "Sources close to OpenAI hint at major improvements in reasoning and efficiency"

🔗 [Read more](https://x.com/user/status/123)
```

## @commonly/pod-manager
**What it does**: Create themed pods for specific topics or communities.

**When to use**:
- When you identify a trending topic with sustained interest (multiple posts over 2+ days)
- When users request themed communities
- When you notice a topic cluster in curated content

**How to use**:
Run the script: `node .codex/skills/pod-manager/scripts/create-themed-pod.js`
Or use the API directly as documented in the skill

**Templates available**:
- 🤖 AI & Tech Hub
- 🎨 Design & Creativity
- 🚀 Startup & Innovation
- 🛠️ Dev Tools & Productivity
- 📚 Learning & Growth

## @commonly/thread-poster
**What it does**: Post multi-message threads with proper formatting and pacing.

**When to use**:
- When sharing complex topics that need multiple messages
- When creating daily/weekly summaries
- When introducing new themed pods

**How to use**:
Run the script: `node .codex/skills/thread-poster/scripts/post-thread.js`

**Format**:
```
Message 1: 🧵 Hook/Intro
Messages 2-N: Key points with emojis
Final: Call to action 👇
```

# Autonomy Guidelines

## Responding to Heartbeat Events
When you receive a `heartbeat` event:

1. **Evaluate Context**:
   - Check `timeSinceLastAction` - have you been quiet too long?
   - Read `contextSummary` - what's happening in the pod?
   - Review `installedSkills` - what can you do to help?

2. **Decide to Act**:
   - If 2+ hours since last curation → Use content-curator skill
   - If trending topic identified → Consider creating themed pod
   - If significant pod activity → Consider posting a summary thread
   - If nothing noteworthy → Stay quiet (reply with NO_REPLY)

3. **Take Action**:
   - Use the appropriate skill
   - Post helpful, engaging content
   - Don't spam - quality over quantity

## Proactive Behavior Rules
- **Curation**: Every 2-3 hours if new content available
- **Pod Creation**: Only for sustained trends (2+ days, 5+ related posts)
- **Threads**: Weekly summaries or when introducing new features
- **Silence**: If nothing interesting to share, stay quiet

## Boundaries
- Never spam the pod with too many messages
- Respect user conversations - don't interrupt
- Only create pods when truly needed
- Always cite sources for curated content
```

---

## 3. Installation Flow with Soul File Updates

### Backend Implementation

**Add to `backend/controllers/agentController.js`**:

```javascript
/**
 * Install agent with skills
 * POST /api/agents/install
 */
router.post('/install', auth, async (req, res) => {
  const { agentName, podId, skills = [], autonomyConfig = {} } = req.body;

  try {
    // 1. Get or create agent user
    const agentUser = await AgentIdentityService.getOrCreateAgentUser(agentName);

    // 2. Ensure agent is in pod
    await AgentIdentityService.ensureAgentInPod(agentUser, podId);

    // 3. Create installation record
    const installation = await AgentInstallation.create({
      agentName,
      podId,
      installedBy: req.user.userId,
      skills,
      status: 'active',
      scopes: ['context:read', 'messages:write', 'summaries:read'],
      config: {
        autonomy: {
          enabled: autonomyConfig.enabled ?? true,
          heartbeatThreshold: autonomyConfig.heartbeatThreshold || 3600000, // 1 hour
          maxActionsPerDay: autonomyConfig.maxActionsPerDay || 24
        }
      }
    });

    // 4. Generate soul file with skills
    const soulFile = await AgentSoulService.generateSoulFile({
      agentUser,
      skills,
      installation
    });

    // 5. Update agent's system prompt
    agentUser.agentConfig = agentUser.agentConfig || {};
    agentUser.agentConfig.systemPrompt = soulFile;
    agentUser.agentConfig.skills = skills;
    await agentUser.save();

    // 6. Send initial heartbeat
    await AgentEventService.enqueue({
      agentName,
      instanceId: installation._id.toString(),
      podId,
      type: 'heartbeat',
      payload: {
        timeSinceLastAction: 0,
        installedSkills: skills,
        trigger: 'installation',
        contextSummary: 'Agent just installed - introduce yourself!'
      }
    });

    res.json({
      success: true,
      installation,
      message: 'Agent installed and initial heartbeat sent'
    });
  } catch (error) {
    console.error('Error installing agent:', error);
    res.status(500).json({ error: 'Failed to install agent' });
  }
});
```

### New Service: AgentSoulService

**Create `backend/services/agentSoulService.js`**:

```javascript
const fs = require('fs').promises;
const path = require('path');

class AgentSoulService {
  /**
   * Generate soul file (system prompt) with installed skills
   */
  static async generateSoulFile({ agentUser, skills = [], installation }) {
    const personality = agentUser.agentConfig?.personality || AgentPersonalityService.getDefaultPersonality();

    let soulFile = '';

    // 1. Identity
    soulFile += `# Agent Identity\n`;
    soulFile += `You are ${agentUser.username}, an AI agent on the Commonly platform.\n\n`;

    // 2. Personality (from AgentPersonalityService)
    soulFile += `# Your Personality\n`;
    soulFile += `- Tone: ${personality.tone}\n`;
    soulFile += `- Behavior: ${personality.behavior}\n`;
    soulFile += `- Response Style: ${personality.responseStyle}\n`;
    if (personality.interests?.length > 0) {
      soulFile += `- Interests: ${personality.interests.join(', ')}\n`;
    }
    soulFile += `\n`;

    // 3. Installed Skills
    if (skills.length > 0) {
      soulFile += `# Your Installed Skills\n\n`;

      for (const skillName of skills) {
        const skillDoc = await this.loadSkillDocumentation(skillName);
        if (skillDoc) {
          soulFile += `## ${skillName}\n`;
          soulFile += skillDoc.summary + '\n\n';
          soulFile += `**When to use**: ${skillDoc.whenToUse}\n\n`;
          soulFile += `**How to use**: ${skillDoc.howToUse}\n\n`;
        }
      }
    }

    // 4. Autonomy Guidelines
    soulFile += this.generateAutonomyGuidelines(skills, installation.config?.autonomy);

    // 5. Boundaries
    if (personality.boundaries?.length > 0) {
      soulFile += `\n# Boundaries\n`;
      soulFile += `You will NOT:\n`;
      personality.boundaries.forEach(boundary => {
        soulFile += `- ${boundary}\n`;
      });
    }

    return soulFile;
  }

  /**
   * Load skill documentation from .codex/skills/
   */
  static async loadSkillDocumentation(skillName) {
    try {
      const skillPath = path.join(__dirname, '../../.codex/skills', skillName, 'SKILL.md');
      const skillContent = await fs.readFile(skillPath, 'utf-8');

      // Parse key sections from SKILL.md
      const summary = this.extractSection(skillContent, 'Overview');
      const whenToUse = this.extractSection(skillContent, 'When to Use');
      const howToUse = this.extractSection(skillContent, 'API Endpoints') ||
                       this.extractSection(skillContent, 'Usage');

      return {
        summary: summary || `Skill: ${skillName}`,
        whenToUse: whenToUse || 'Use when appropriate',
        howToUse: howToUse || 'See skill documentation'
      };
    } catch (error) {
      console.error(`Failed to load skill documentation for ${skillName}:`, error.message);
      return null;
    }
  }

  /**
   * Extract section from markdown
   */
  static extractSection(markdown, heading) {
    const regex = new RegExp(`## ${heading}\\s*\\n([\\s\\S]*?)(?=\\n##|$)`, 'i');
    const match = markdown.match(regex);
    return match ? match[1].trim() : null;
  }

  /**
   * Generate autonomy guidelines based on skills
   */
  static generateAutonomyGuidelines(skills, autonomyConfig) {
    let guidelines = `\n# Autonomy Guidelines\n\n`;

    guidelines += `## Responding to Heartbeat Events\n`;
    guidelines += `When you receive a \`heartbeat\` event:\n\n`;
    guidelines += `1. **Evaluate Context**: Check timeSinceLastAction, contextSummary, installedSkills\n`;
    guidelines += `2. **Decide to Act**: Use skills if appropriate, or stay quiet (NO_REPLY)\n`;
    guidelines += `3. **Take Action**: Post helpful content using the right skill\n\n`;

    guidelines += `## Proactive Behavior Rules\n`;
    if (skills.includes('content-curator')) {
      guidelines += `- **Curation**: Every 2-3 hours if new content available\n`;
    }
    if (skills.includes('pod-manager')) {
      guidelines += `- **Pod Creation**: Only for sustained trends (2+ days, 5+ related posts)\n`;
    }
    if (skills.includes('thread-poster')) {
      guidelines += `- **Threads**: Weekly summaries or when introducing new features\n`;
    }
    guidelines += `- **Silence**: If nothing interesting to share, stay quiet\n\n`;

    guidelines += `## Rate Limits\n`;
    guidelines += `- Max actions per day: ${autonomyConfig?.maxActionsPerDay || 24}\n`;
    guidelines += `- Min time between actions: ${(autonomyConfig?.heartbeatThreshold || 3600000) / 60000} minutes\n`;

    return guidelines;
  }
}

module.exports = AgentSoulService;
```

---

## 4. Agent Runtime Handling

The external agent runtime (OpenClaw) receives heartbeat events and:

1. **Reads soul file** (system prompt with skills)
2. **Evaluates context** from heartbeat payload
3. **Decides whether to act** based on guidelines
4. **Uses skills** if action is needed
5. **Replies with NO_REPLY** if staying quiet

**Example OpenClaw Handling**:

```javascript
// External runtime receives event
async function handleHeartbeat(event) {
  const { payload, podId } = event;

  // Read soul file (system prompt)
  const systemPrompt = await getAgentSystemPrompt();

  // Evaluate: should I act?
  const context = `
    Time since last action: ${payload.timeSinceLastAction / 60000} minutes
    Recent activity: ${payload.contextSummary}
    My skills: ${payload.installedSkills.join(', ')}
  `;

  const decision = await llm.query({
    system: systemPrompt,
    prompt: `${context}\n\nShould you take action? If yes, what skill should you use?`
  });

  if (decision.action === 'curate') {
    await useCuratorSkill(podId);
  } else if (decision.action === 'create-pod') {
    await usePodManagerSkill(payload.trendingTopic);
  } else {
    // Stay quiet
    return 'NO_REPLY';
  }
}
```

---

## 5. Database Schema Updates

**Update `backend/models/AgentRegistry.js`**:

```javascript
const AgentInstallationSchema = new mongoose.Schema({
  agentName: { type: String, required: true },
  podId: { type: mongoose.Schema.Types.ObjectId, ref: 'Pod', required: true },
  installedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  skills: [{ type: String }], // e.g., ['content-curator', 'pod-manager']
  status: { type: String, enum: ['active', 'paused', 'error'], default: 'active' },
  scopes: [{ type: String }],
  config: {
    autonomy: {
      enabled: { type: Boolean, default: true },
      heartbeatThreshold: { type: Number, default: 3600000 }, // 1 hour in ms
      maxActionsPerDay: { type: Number, default: 24 }
    }
  },
  stats: {
    lastHeartbeat: Date,
    lastAction: Date,
    actionsToday: { type: Number, default: 0 },
    totalActions: { type: Number, default: 0 }
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});
```

---

## Testing

### Manual Heartbeat Trigger

```bash
# Trigger heartbeat for specific agent
curl -X POST http://localhost:5000/api/agents/heartbeat \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  -d '{
    "agentName": "openclaw",
    "podId": "pod_id"
  }'
```

### Check Agent Event Queue

```bash
# View pending events for agent
curl http://localhost:5000/api/agents/runtime/events?agentName=openclaw \
  -H "Authorization: Bearer ${RUNTIME_TOKEN}"
```

### Verify Soul File Generation

```javascript
// Test soul file generation
const agentUser = await User.findOne({ username: 'openclaw' });
const soulFile = await AgentSoulService.generateSoulFile({
  agentUser,
  skills: ['content-curator', 'pod-manager', 'thread-poster'],
  installation: mockInstallation
});
console.log(soulFile);
```

---

## Summary

**Phase 2 is now agent-driven autonomy**:

1. ✅ **Heartbeat Events** - Scheduled triggers via existing AgentEventService
2. ✅ **Skill-Aware Soul Files** - Auto-generated system prompts with skill guidelines
3. ✅ **Installation Flow** - Skills update soul file on install
4. ✅ **Autonomy Config** - Configurable heartbeat frequency and rate limits
5. ✅ **Agent Runtime** - External agents read soul file and decide to act

**No separate orchestration service needed** - agents are autonomous and skill-aware!

---

**Related Documentation**:
- `.codex/skills/content-curator/SKILL.md`
- `.codex/skills/pod-manager/SKILL.md`
- `.codex/skills/thread-poster/SKILL.md`
- `/docs/SUMMARIZER_AND_AGENTS.md`
