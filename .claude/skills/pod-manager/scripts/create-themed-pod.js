/**
 * Create Themed Pod Script
 *
 * This script can be used by agents to create themed pods dynamically.
 * Agents should have user token with pod creation permissions.
 */

const COMMONLY_BASE_URL = process.env.COMMONLY_BASE_URL || 'http://localhost:5000';

/**
 * Create a new themed pod
 *
 * @param {Object} options - Pod creation options
 * @param {string} options.theme - Theme name (e.g., "AI News")
 * @param {string} options.description - Pod description
 * @param {Array<string>} options.tags - Pod tags for discovery
 * @param {string} options.icon - Emoji icon for pod
 * @param {string} options.curatorAgent - Agent to install (default: 'openclaw')
 * @param {string} options.userToken - User authentication token
 * @returns {Promise<Object>} Created pod and installation details
 */
async function createThemedPod({
  theme,
  description,
  tags = [],
  icon = '🎯',
  curatorAgent = 'openclaw',
  userToken
}) {
  if (!userToken) {
    throw new Error('userToken is required');
  }

  // 1. Create the pod
  console.log(`Creating pod: ${icon} ${theme}...`);

  const podResponse = await fetch(`${COMMONLY_BASE_URL}/api/pods`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${userToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      name: `${icon} ${theme}`,
      description,
      type: 'chat',
      tags
    })
  });

  if (!podResponse.ok) {
    const error = await podResponse.json();
    throw new Error(`Failed to create pod: ${error.error || podResponse.statusText}`);
  }

  const pod = await podResponse.json();
  console.log(`✅ Created pod: ${pod.name} (ID: ${pod._id})`);

  // 2. Install curator agent
  console.log(`Installing ${curatorAgent} in pod...`);

  const installResponse = await fetch(`${COMMONLY_BASE_URL}/api/registry/install`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${userToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      agentName: curatorAgent,
      podId: pod._id,
      scopes: ['context:read', 'summaries:read', 'messages:write']
    })
  });

  if (!installResponse.ok) {
    console.warn(`⚠️  Failed to install agent, but pod was created`);
  } else {
    const installation = await installResponse.json();
    console.log(`✅ Installed ${curatorAgent} in pod`);

    return {
      pod,
      installation,
      success: true
    };
  }

  return {
    pod,
    installation: null,
    success: true
  };
}

/**
 * Check if pod with similar name already exists
 */
async function checkForDuplicatePod(theme, userToken) {
  const response = await fetch(`${COMMONLY_BASE_URL}/api/pods`, {
    headers: {
      'Authorization': `Bearer ${userToken}`
    }
  });

  const pods = await response.json();

  // Simple similarity check
  const normalizedTheme = theme.toLowerCase().replace(/[^a-z0-9]/g, '');

  return pods.find(pod => {
    const normalizedPodName = pod.name.toLowerCase().replace(/[^a-z0-9]/g, '');
    return normalizedPodName.includes(normalizedTheme) || normalizedTheme.includes(normalizedPodName);
  });
}

/**
 * Themed pod templates
 */
const POD_TEMPLATES = {
  'ai-tech': {
    theme: 'AI & Tech News',
    description: 'Latest developments in artificial intelligence and technology',
    tags: ['AI', 'machine learning', 'technology', 'innovation'],
    icon: '🤖',
    keywords: ['AI', 'ML', 'neural', 'LLM', 'tech', 'innovation']
  },
  'design': {
    theme: 'Design Inspiration',
    description: 'Beautiful designs, UI/UX trends, and creative work',
    tags: ['design', 'UI', 'UX', 'creativity', 'art'],
    icon: '🎨',
    keywords: ['design', 'UI', 'UX', 'figma', 'sketch', 'creative']
  },
  'startup': {
    theme: 'Startup Stories',
    description: 'Entrepreneurship, startups, and business insights',
    tags: ['startup', 'entrepreneur', 'business', 'funding'],
    icon: '💼',
    keywords: ['startup', 'founder', 'VC', 'funding', 'entrepreneur']
  },
  'dev-tools': {
    theme: 'Developer Tools',
    description: 'Coding tools, frameworks, and developer productivity',
    tags: ['development', 'coding', 'tools', 'programming'],
    icon: '🔧',
    keywords: ['code', 'framework', 'library', 'devtools', 'programming']
  },
  'learning': {
    theme: 'Learning & Education',
    description: 'Educational content, courses, and learning resources',
    tags: ['education', 'learning', 'courses', 'knowledge'],
    icon: '📚',
    keywords: ['education', 'course', 'tutorial', 'learning', 'teach']
  }
};

/**
 * Get template by key
 */
function getTemplate(key) {
  return POD_TEMPLATES[key];
}

/**
 * Example usage
 */
async function main() {
  const userToken = process.env.COMMONLY_USER_TOKEN;

  if (!userToken) {
    console.error('❌ COMMONLY_USER_TOKEN environment variable required');
    process.exit(1);
  }

  try {
    // Check for duplicates
    const existing = await checkForDuplicatePod('AI & Tech News', userToken);
    if (existing) {
      console.log(`⚠️  Similar pod already exists: ${existing.name} (${existing._id})`);
      console.log('Consider using that pod instead of creating a duplicate');
      return;
    }

    // Create from template
    const template = getTemplate('ai-tech');
    const result = await createThemedPod({
      ...template,
      curatorAgent: 'openclaw',
      userToken
    });

    console.log('\n✅ Successfully created themed pod!');
    console.log(`Pod ID: ${result.pod._id}`);
    console.log(`Pod URL: /pods/${result.pod._id}`);

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
  createThemedPod,
  checkForDuplicatePod,
  getTemplate,
  POD_TEMPLATES
};
