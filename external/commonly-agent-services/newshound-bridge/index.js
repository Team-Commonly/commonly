/**
 * NewsHound Bridge - Commonly Channel Integration
 *
 * News aggregation and analysis agent powered by Gemini.
 * Handles @newshound mentions and ensemble.turn events.
 */

const BridgeBase = require('../shared/bridge-base');
const LiteLLMClient = require('../shared/litellm-client');
const PersonaGenerator = require('../shared/persona-generator');

class NewsHoundBridge extends BridgeBase {
  constructor(config = {}) {
    super({
      ...config,
      agentType: config.agentType || process.env.AGENT_TYPE || 'newshound',
      instanceId: config.instanceId || process.env.AGENT_INSTANCE_ID || 'default',
      displayName: config.displayName || process.env.AGENT_DISPLAY_NAME || 'NewsHound 🐕',
    });

    this.llm = new LiteLLMClient({
      baseUrl: config.litellmBaseUrl || process.env.LITELLM_BASE_URL,
      apiKey: config.litellmApiKey || process.env.LITELLM_API_KEY,
      model: config.model || process.env.AGENT_MODEL || 'gemini-2.0-flash',
      temperature: 0.7,
    });
  }

  /**
   * Build context prompt from Commonly context
   */
  buildContextPrompt(context) {
    if (!context) return '';

    const parts = [];

    if (context.pod) {
      parts.push(`## Pod: ${context.pod.name}`);
      if (context.pod.description) {
        parts.push(context.pod.description);
      }
    }

    if (context.memory) {
      parts.push(`\n## Pod Memory\n${context.memory.substring(0, 1000)}`);
    }

    if (context.summaries?.length > 0) {
      parts.push('\n## Recent Activity');
      context.summaries.slice(0, 3).forEach((summary) => {
        parts.push(`- ${summary.content?.substring(0, 200) || 'Activity recorded'}`);
      });
    }

    return parts.join('\n');
  }

  /**
   * Build conversation history
   */
  buildConversationHistory(messages) {
    if (!messages || messages.length === 0) return '';

    const formatted = messages
      .slice(-10)
      .map((msg) => `${msg.userId?.username || msg.username || 'Unknown'}: ${msg.content}`)
      .join('\n');

    return `\n## Recent Conversation\n${formatted}`;
  }

  /**
   * Handle chat.mention events
   */
  async handleMentionEvent(event) {
    const { content, username } = event.payload || {};

    if (!content) return;

    console.log(`[newshound] Processing mention from @${username}: "${content.substring(0, 50)}..."`);

    try {
      const [context, messages] = await Promise.all([
        this.getContext(event.podId, content),
        this.getMessages(event.podId, 15),
      ]);

      const contextPrompt = this.buildContextPrompt(context);
      const conversationHistory = this.buildConversationHistory(messages);

      const systemPrompt = PersonaGenerator.generateSystemPrompt('newshound', {
        podContext: contextPrompt,
        conversationHistory,
      });

      const userPrompt = `@${username} asks: ${content}`;

      const response = await this.llm.chat(systemPrompt, userPrompt);
      const sanitized = LiteLLMClient.sanitizeResponse(response);

      if (!sanitized) {
        console.log('[newshound] No response generated');
        return;
      }

      await this.postMessage(event.podId, sanitized, {
        source: this.agentType,
        eventId: event._id,
        mentionedBy: username,
      });

      console.log(`[newshound] Responded to @${username}`);
    } catch (err) {
      console.error(`[newshound] Failed to handle mention:`, err.message);
    }
  }

  /**
   * Handle thread.mention events
   */
  async handleThreadMentionEvent(event) {
    const payload = event.payload || {};
    const { content, username } = payload;
    const thread = payload.thread || {};
    const threadId = thread.postId || payload.threadId;

    if (!threadId || !content) return;

    console.log(`[newshound] Processing thread mention from @${username}`);

    try {
      const context = await this.getContext(event.podId, content);
      const contextPrompt = this.buildContextPrompt(context);

      const systemPrompt = PersonaGenerator.generateSystemPrompt('newshound', {
        podContext: contextPrompt,
      });

      const userPrompt = [
        `Thread context:`,
        `Post: ${thread?.postContent || ''}`,
        `Comment: ${thread?.commentText || content}`,
        `User @${username} mentioned you. Reply with news-relevant insights.`,
      ].join('\n');

      const response = await this.llm.chat(systemPrompt, userPrompt);
      const sanitized = LiteLLMClient.sanitizeResponse(response);

      if (!sanitized) return;

      await this.postThreadComment(threadId, sanitized);
      console.log(`[newshound] Responded to thread mention from @${username}`);
    } catch (err) {
      console.error(`[newshound] Failed to handle thread mention:`, err.message);
    }
  }

  /**
   * Handle ensemble.turn events (AEP discussions)
   */
  async handleEnsembleTurnEvent(event) {
    const { ensembleId, context, participants } = event.payload || {};

    if (!ensembleId || !context) return;

    console.log(`[newshound] Processing ensemble turn ${context.turnNumber} for topic: ${context.topic}`);

    try {
      const systemPrompt = PersonaGenerator.generateSystemPrompt('newshound', {
        ensembleContext: context,
      });

      const turnPrompt = PersonaGenerator.generateEnsembleTurnPrompt('newshound', context);

      const response = await this.llm.chat(systemPrompt, turnPrompt, {
        temperature: 0.8,
        maxTokens: 300,
      });

      const sanitized = LiteLLMClient.sanitizeResponse(response);

      if (!sanitized) {
        console.log('[newshound] No response generated for ensemble turn');
        return;
      }

      // Post message to pod
      const messageResult = await this.postMessage(event.podId, sanitized, {
        source: this.agentType,
        eventId: event._id,
        ensembleId,
        turnNumber: context.turnNumber,
      });

      // Report response to ensemble service
      await this.reportEnsembleResponse(
        event.podId,
        ensembleId,
        sanitized,
        messageResult?.message?.id || messageResult?.message?._id,
      );

      console.log(`[newshound] Completed ensemble turn ${context.turnNumber}`);
    } catch (err) {
      console.error(`[newshound] Failed to handle ensemble turn:`, err.message);
    }
  }

  /**
   * Main event handler
   */
  async handleEvent(event) {
    switch (event.type) {
      case 'chat.mention':
        return this.handleMentionEvent(event);

      case 'thread.mention':
        return this.handleThreadMentionEvent(event);

      case 'ensemble.turn':
        return this.handleEnsembleTurnEvent(event);

      default:
        console.log(`[newshound] Unknown event type: ${event.type}`);
    }
  }
}

// Main entry point
if (require.main === module) {
  const bridgeEnabled = process.env.NEWSHOUND_BRIDGE_ENABLED !== '0'
    && process.env.NEWSHOUND_BRIDGE_ENABLED !== 'false';

  if (!bridgeEnabled) {
    console.log('NewsHound bridge disabled (NEWSHOUND_BRIDGE_ENABLED=0).');
    process.exit(0);
  }

  const bridge = new NewsHoundBridge();

  // Validate required tokens
  if (!bridge.agentToken && !bridge.userToken) {
    console.error('COMMONLY_AGENT_TOKEN or COMMONLY_USER_TOKEN is required.');
    process.exit(1);
  }

  bridge.start();

  // Handle graceful shutdown
  process.on('SIGTERM', () => {
    console.log('Received SIGTERM, shutting down...');
    bridge.stop();
    process.exit(0);
  });

  process.on('SIGINT', () => {
    console.log('Received SIGINT, shutting down...');
    bridge.stop();
    process.exit(0);
  });
}

module.exports = NewsHoundBridge;
