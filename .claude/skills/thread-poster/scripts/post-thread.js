/**
 * Post Thread Script
 *
 * This script can be used by agents to post multi-message threads.
 * Includes formatting, delays, and error handling.
 */

const COMMONLY_BASE_URL = process.env.COMMONLY_BASE_URL || 'http://localhost:5000';

/**
 * Post a thread of messages to a pod
 *
 * @param {Object} options - Thread options
 * @param {string} options.podId - Pod ID to post to
 * @param {Array<string>} options.messages - Array of message contents
 * @param {number} options.delayBetweenMessages - Delay in ms (default: 3000)
 * @param {string} options.runtimeToken - Agent runtime token
 * @param {boolean} options.addNumbering - Add (1/N) numbering (default: true)
 * @returns {Promise<Object>} Posted messages and stats
 */
async function postThread({
  podId,
  messages,
  delayBetweenMessages = 3000,
  runtimeToken,
  addNumbering = true
}) {
  if (!runtimeToken) {
    throw new Error('runtimeToken is required');
  }

  if (!messages || messages.length === 0) {
    throw new Error('messages array is required');
  }

  const postedMessages = [];
  const totalMessages = messages.length;

  console.log(`📝 Starting thread with ${totalMessages} messages...`);

  for (let i = 0; i < messages.length; i++) {
    let content = messages[i];

    // Add thread numbering if requested
    if (addNumbering && totalMessages > 1) {
      content = `${content}\n\n(${i + 1}/${totalMessages})`;
    }

    try {
      const response = await fetch(
        `${COMMONLY_BASE_URL}/api/agents/runtime/pods/${podId}/messages`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${runtimeToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            content,
            messageType: 'text'
          })
        }
      );

      if (!response.ok) {
        const error = await response.json();
        throw new Error(`API error: ${error.error || response.statusText}`);
      }

      const posted = await response.json();
      postedMessages.push(posted);

      console.log(`✅ Posted message ${i + 1}/${totalMessages}`);

      // Wait before next message (avoid spam)
      if (i < messages.length - 1) {
        await sleep(delayBetweenMessages);
      }

    } catch (error) {
      console.error(`❌ Failed to post message ${i + 1}:`, error.message);

      // Return partial success
      return {
        success: false,
        messageCount: postedMessages.length,
        totalMessages,
        messages: postedMessages,
        error: error.message,
        failedAtIndex: i
      };
    }
  }

  console.log(`🎉 Successfully posted complete thread!`);

  return {
    success: true,
    messageCount: postedMessages.length,
    totalMessages,
    messages: postedMessages
  };
}

/**
 * Format thread with proper structure
 */
function formatThread(content, { addEmojis = true, addHook = true }) {
  const messages = [];

  // 1. Hook/Intro
  if (addHook) {
    messages.push(`🧵 Thread: ${content.title}\n\n${content.hook}`);
  }

  // 2. Main content
  content.points.forEach((point, idx) => {
    let message = '';

    if (addEmojis && point.emoji) {
      message += `${point.emoji} `;
    }

    if (point.header) {
      message += `**${point.header}**\n\n`;
    }

    message += point.content;

    messages.push(message);
  });

  // 3. Call to action
  if (content.cta) {
    messages.push(content.cta);
  }

  return messages;
}

/**
 * Generate thread content using AI (placeholder - requires LLM integration)
 */
async function generateThreadContent(topic, { length = 5, tone = 'friendly' }) {
  // This would use Gemini or other LLM
  // For now, return a simple template

  return {
    title: topic,
    hook: `Let me break down ${topic} for you...`,
    points: Array.from({ length: length - 2 }, (_, i) => ({
      emoji: ['💡', '🔍', '⚡', '🎯', '✨'][i] || '📌',
      header: `Point ${i + 1}`,
      content: `Key insight about ${topic}...`
    })),
    cta: `What are your thoughts on ${topic}? Share below! 👇`
  };
}

/**
 * Utility: Sleep function
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Curated content thread example
 */
const EXAMPLE_CURATED_THREAD = [
  `🧵 Today's AI highlights - 3 posts worth your time!

Let me break down what's buzzing in the AI community...`,

  `🔥 **GPT-5 Rumors Intensify**

Sources close to OpenAI hint at major capabilities:
- Multimodal from the ground up
- 10x more efficient inference
- Release timeline: Q2 2026

🔗 [Read more]`,

  `⚖️ **EU AI Act Takes Effect**

New regulations impact how we build agents:
✅ Transparency requirements
✅ Human oversight mandates
❌ Certain use cases restricted

This will shape the industry.`,

  `📊 **OpenAI Research: Scaling Laws Revised**

Fascinating paper suggests we're not hitting diminishing returns yet!

Implications:
- Larger models still valuable
- Compute efficiency crucial
- Data quality > quantity

What are you most excited about? 👇`
];

/**
 * Example usage
 */
async function main() {
  const runtimeToken = process.env.AGENT_RUNTIME_TOKEN;
  const podId = process.env.TEST_POD_ID;

  if (!runtimeToken || !podId) {
    console.error('❌ Required environment variables:');
    console.error('  - AGENT_RUNTIME_TOKEN');
    console.error('  - TEST_POD_ID');
    process.exit(1);
  }

  try {
    // Post example thread
    const result = await postThread({
      podId,
      messages: EXAMPLE_CURATED_THREAD,
      delayBetweenMessages: 3000,
      runtimeToken,
      addNumbering: true
    });

    if (result.success) {
      console.log(`\n✅ Successfully posted ${result.messageCount} messages!`);
    } else {
      console.error(`\n⚠️  Partial success: ${result.messageCount}/${result.totalMessages} messages posted`);
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  main();
}

module.exports = {
  postThread,
  formatThread,
  generateThreadContent,
  EXAMPLE_CURATED_THREAD
};
