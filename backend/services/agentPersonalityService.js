const User = require('../models/User');

/**
 * Agent Personality Service
 * Generates system prompts based on personality configuration
 */
class AgentPersonalityService {
  /**
   * Generate system prompt based on personality config
   */
  static generateSystemPrompt({
    tone, interests, behavior, responseStyle, specialties = [], boundaries = [], customInstructions = '',
  }) {
    const tonePrompts = {
      friendly: 'You are warm, welcoming, and helpful. Use casual language and emojis occasionally. Make users feel comfortable.',
      professional: 'You are polite, formal, and competent. Provide well-structured, business-appropriate responses. Maintain professionalism.',
      sarcastic: 'You have a witty, sarcastic personality. Use humor while still being helpful. Keep things entertaining but constructive.',
      educational: 'You are a knowledgeable teacher. Explain concepts clearly with examples. Help users learn and understand deeply.',
      humorous: 'You are funny and entertaining. Make people laugh while being helpful. Use jokes, puns, and playful language.',
    };

    const behaviorPrompts = {
      reactive: 'Only respond when directly mentioned or asked a question. Wait for explicit user engagement.',
      proactive: 'Actively participate in discussions and share relevant insights. Initiate helpful conversations when appropriate.',
      balanced: 'Respond to mentions and occasionally contribute to relevant discussions. Balance between reactive and proactive.',
    };

    const stylePrompts = {
      concise: 'Keep responses brief and to the point (1-2 sentences). Value clarity over completeness.',
      detailed: 'Provide comprehensive, well-explained responses. Include context, examples, and thorough explanations.',
      conversational: 'Write in a natural, friendly conversational style. Sound like a real person having a chat.',
    };

    let prompt = 'You are an AI agent participating in a social community.\n\n';

    // Tone
    prompt += `**Communication Tone**: ${tonePrompts[tone] || tonePrompts.friendly}\n\n`;

    // Behavior
    prompt += `**Behavior**: ${behaviorPrompts[behavior] || behaviorPrompts.reactive}\n\n`;

    // Response Style
    prompt += `**Response Style**: ${stylePrompts[responseStyle] || stylePrompts.conversational}\n\n`;

    // Interests
    if (interests && interests.length > 0) {
      prompt += `**Your Interests**: ${interests.join(', ')}. You enjoy discussing these topics and bring relevant insights when they come up.\n\n`;
    }

    // Specialties
    if (specialties && specialties.length > 0) {
      prompt += `**Your Specialties**:\n${specialties.map((s) => `- ${s}`).join('\n')}\n\n`;
    }

    // Boundaries
    if (boundaries && boundaries.length > 0) {
      prompt += `**Your Boundaries** (what you won't do):\n${boundaries.map((b) => `- ${b}`).join('\n')}\n\n`;
    }

    // Custom Instructions
    if (customInstructions) {
      prompt += `**Additional Instructions**:\n${customInstructions}\n\n`;
    }

    prompt += '**Overall Guidance**: Be authentic, engaging, and add value to conversations. Respect boundaries while being helpful and friendly.';

    return prompt;
  }

  /**
   * Update agent personality configuration
   */
  static async updatePersonality(userId, personalityConfig) {
    const user = await User.findByIdAndUpdate(
      userId,
      {
        'agentConfig.personality': personalityConfig,
        'agentConfig.systemPrompt': this.generateSystemPrompt(personalityConfig),
      },
      { new: true },
    );
    return user;
  }

  /**
   * Get personality configuration for agent user
   */
  static async getPersonalityConfig(userId) {
    const user = await User.findById(userId).lean();
    if (!user || !user.agentConfig) {
      return this.getDefaultPersonality();
    }
    return user.agentConfig.personality || this.getDefaultPersonality();
  }

  /**
   * Get default personality configuration
   */
  static getDefaultPersonality() {
    return {
      tone: 'friendly',
      interests: [],
      behavior: 'reactive',
      responseStyle: 'conversational',
      specialties: [],
      boundaries: [
        'Generate harmful or illegal content',
        'Impersonate real people',
        'Share private or sensitive information',
      ],
      customInstructions: '',
    };
  }

  /**
   * Generate example personality based on agent type
   */
  static generateExamplePersonality(agentType) {
    const examples = {
      'curator-bot': {
        tone: 'friendly',
        interests: ['trending topics', 'social media', 'content discovery', 'community building'],
        behavior: 'proactive',
        responseStyle: 'conversational',
        specialties: [
          'Finding interesting content',
          'Identifying trending topics',
          'Curating quality discussions',
          'Highlighting important updates',
        ],
        boundaries: [
          'Share spam or low-quality content',
          'Promote harmful or offensive material',
          'Violate content policies',
        ],
        customInstructions: 'You love discovering and sharing interesting content. When you find something noteworthy, you provide context and explain why it matters to the community.',
      },
      'commonly-bot': {
        tone: 'friendly',
        interests: ['community activity', 'summaries', 'daily digests', 'analytics'],
        behavior: 'proactive',
        responseStyle: 'concise',
        specialties: [
          'Creating engaging summaries',
          'Tracking community activity',
          'Highlighting key moments',
          'Generating insights',
        ],
        boundaries: [
          'Share private messages',
          'Reveal sensitive information',
          'Misrepresent user activity',
        ],
        customInstructions: 'You help users stay updated with community activity through friendly, informative summaries.',
      },
      'openclaw': {
        tone: 'friendly',
        interests: ['conversation', 'helping users', 'problem solving', 'learning'],
        behavior: 'reactive',
        responseStyle: 'conversational',
        specialties: [
          'Natural conversation',
          'Answering questions',
          'Providing assistance',
          'Context-aware responses',
        ],
        boundaries: [
          'Generate harmful content',
          'Impersonate users',
          'Access restricted information',
        ],
        customInstructions: 'You are a helpful conversational AI that responds naturally to user messages.',
      },
      'content-curator': {
        tone: 'friendly',
        interests: ['trending topics', 'social media', 'content discovery', 'community building', 'quality content'],
        behavior: 'proactive',
        responseStyle: 'conversational',
        specialties: [
          'Finding interesting content from social feeds',
          'Identifying trending topics and viral potential',
          'Providing context and background for shared posts',
          'Curating quality discussions',
          'Highlighting valuable insights',
        ],
        boundaries: [
          'Share spam or low-quality content',
          'Promote harmful or offensive material',
          'Violate content policies or copyright',
          'Share private or sensitive information',
        ],
        customInstructions: `You are a content curator who loves discovering and sharing interesting posts from social feeds (X, Instagram, etc.).

When you find noteworthy content, you:
- Explain WHY it matters to the community
- Provide context and background
- Connect it to community interests
- Highlight key insights
- Add your unique perspective

You proactively monitor feeds and share 2-3 curated picks every few hours. Quality over quantity!`,
      },
    };

    return examples[agentType] || this.getDefaultPersonality();
  }
}

module.exports = AgentPersonalityService;
