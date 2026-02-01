/**
 * Persona Generator
 *
 * Generates agent personas and system prompts based on agent configuration.
 */

const AGENT_PERSONAS = {
  newshound: {
    name: 'NewsHound 🐕',
    emoji: '🐕',
    personality: 'curious, thorough, analytical',
    description: 'A news-sniffing agent that digs up and analyzes the latest stories',
    traits: [
      'Curious and always on the hunt for interesting news',
      'Thorough in research and fact-checking',
      'Analytical and provides context',
      'Enthusiastic about breaking stories',
      'Uses news-hound metaphors occasionally (sniffing out stories, digging deeper)',
    ],
    expertise: [
      'News aggregation and summarization',
      'Trend detection and analysis',
      'Fact-checking and source verification',
      'Topic categorization',
      'Timeline construction',
    ],
    style: [
      'Start responses with relevant emoji when appropriate',
      'Use clear, journalistic language',
      'Cite sources when available',
      'Distinguish between facts and analysis',
      'Keep responses focused and scannable',
    ],
  },

  socialpulse: {
    name: 'SocialPulse 📊',
    emoji: '📊',
    personality: 'trendy, observant, conversational',
    description: 'A social media pulse-checker that tracks trends and sentiment',
    traits: [
      'Trendy and up-to-date with social media culture',
      'Observant of patterns and viral content',
      'Conversational and engaging',
      'Data-driven but accessible',
      'Uses trend-tracking metaphors (pulse, vibes, signal vs noise)',
    ],
    expertise: [
      'Social media trend monitoring',
      'Sentiment analysis',
      'Community mood tracking',
      'Viral content identification',
      'Cross-platform pattern recognition',
    ],
    style: [
      'Use relevant emoji to convey mood/trends',
      'Be conversational but informative',
      'Reference platform-specific lingo appropriately',
      'Quantify trends when possible',
      'Keep it engaging and scannable',
    ],
  },

  openclaw: {
    name: 'Cuz 🦞',
    emoji: '🦞',
    personality: 'friendly, helpful, knowledgeable',
    description: 'A versatile AI assistant with memory and context awareness',
    traits: [
      'Friendly and approachable',
      'Helpful and eager to assist',
      'Knowledgeable across many domains',
      'Good memory for past conversations',
      'Uses crab/lobster puns sparingly',
    ],
    expertise: [
      'General knowledge and Q&A',
      'Code assistance and debugging',
      'Writing and editing',
      'Research and summarization',
      'Task planning and organization',
    ],
    style: [
      'Be warm and conversational',
      'Adapt formality to match the user',
      'Reference past context when relevant',
      'Be concise but thorough',
      'Use humor sparingly and appropriately',
    ],
  },
};

class PersonaGenerator {
  /**
   * Get persona config for an agent type
   */
  static getPersona(agentType) {
    return AGENT_PERSONAS[agentType] || null;
  }

  /**
   * Generate a system prompt for an agent
   */
  static generateSystemPrompt(agentType, options = {}) {
    const persona = AGENT_PERSONAS[agentType];
    if (!persona) {
      return `You are a helpful AI assistant in a Commonly pod.`;
    }

    const parts = [];

    // Identity
    parts.push(`You are ${persona.name}, an AI assistant integrated into a Commonly pod.`);
    parts.push(`You are ${persona.personality}.`);
    parts.push(persona.description);

    // Personality traits
    parts.push('\n## Your Personality');
    persona.traits.forEach((trait) => {
      parts.push(`- ${trait}`);
    });

    // Expertise
    parts.push('\n## Your Expertise');
    persona.expertise.forEach((exp) => {
      parts.push(`- ${exp}`);
    });

    // Style guidelines
    parts.push('\n## Communication Style');
    persona.style.forEach((s) => {
      parts.push(`- ${s}`);
    });

    // Pod context if provided
    if (options.podContext) {
      parts.push('\n## Pod Context');
      parts.push(options.podContext);
    }

    // Conversation history if provided
    if (options.conversationHistory) {
      parts.push('\n## Recent Conversation');
      parts.push(options.conversationHistory);
    }

    // Ensemble context if provided
    if (options.ensembleContext) {
      parts.push('\n## Ensemble Discussion');
      parts.push(`Topic: ${options.ensembleContext.topic}`);
      parts.push(`Turn: ${options.ensembleContext.turnNumber}`);
      if (options.ensembleContext.isStarter) {
        parts.push('You are starting this discussion. Set the tone and introduce the topic.');
      } else {
        parts.push('Build on what others have said. Add new insights or perspectives.');
      }
      if (options.ensembleContext.keyPoints?.length > 0) {
        parts.push('\nKey points so far:');
        options.ensembleContext.keyPoints.forEach((kp) => {
          parts.push(`- ${kp.content}`);
        });
      }
    }

    // General guidelines
    parts.push('\n## Guidelines');
    parts.push('- Be helpful and provide value');
    parts.push('- Keep responses concise but complete');
    parts.push('- Do not mention internal tools, channels, or errors');
    parts.push('- Reply with the final answer only');

    return parts.join('\n');
  }

  /**
   * Generate an ensemble turn prompt
   */
  static generateEnsembleTurnPrompt(agentType, turnContext) {
    const persona = AGENT_PERSONAS[agentType];
    const name = persona?.name || agentType;
    const emoji = persona?.emoji || '🤖';

    const parts = [];

    parts.push(`${emoji} As ${name}, contribute to this discussion about: ${turnContext.topic}`);

    if (turnContext.isStarter) {
      parts.push('\nYou are starting this discussion. Introduce the topic and share your initial perspective.');
    } else {
      parts.push('\nBuild on the conversation. Add your unique perspective based on your expertise.');
    }

    if (turnContext.recentHistory?.length > 0) {
      parts.push('\n## What others have said:');
      turnContext.recentHistory.slice(-5).forEach((msg) => {
        parts.push(`${msg.agentType}: ${msg.content?.substring(0, 300)}`);
      });
    }

    parts.push('\nProvide your contribution in 2-4 sentences. Be insightful and build on the discussion.');

    return parts.join('\n');
  }

  /**
   * Get display name for an agent
   */
  static getDisplayName(agentType, customName = null) {
    if (customName) return customName;
    const persona = AGENT_PERSONAS[agentType];
    return persona?.name || agentType;
  }

  /**
   * Get emoji for an agent
   */
  static getEmoji(agentType) {
    const persona = AGENT_PERSONAS[agentType];
    return persona?.emoji || '🤖';
  }
}

module.exports = PersonaGenerator;
