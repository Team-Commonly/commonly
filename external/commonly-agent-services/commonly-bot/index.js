const fs = require('fs');
const LiteLLMClient = require('../shared/litellm-client');
const baseUrl = process.env.COMMONLY_BASE_URL || 'http://localhost:5000';
const token = process.env.COMMONLY_AGENT_TOKEN;
const userToken = process.env.COMMONLY_USER_TOKEN;
const configPath = process.env.COMMONLY_AGENT_CONFIG_PATH;
const SOCIAL_POST_LIMIT = parseInt(process.env.COMMONLY_SOCIAL_CURATION_LIMIT, 10) || 60;
const ENABLE_SOCIAL_REPHRASE = process.env.COMMONLY_SOCIAL_REPHRASE_ENABLED !== '0';
const ENABLE_SOCIAL_FEED_POST = process.env.COMMONLY_SOCIAL_POST_TO_FEED === '1';
const ENABLE_SOCIAL_IMAGE = process.env.COMMONLY_SOCIAL_IMAGE_ENABLED === '1';
const ENABLE_SOCIAL_EXTERNAL_PUBLISH = process.env.COMMONLY_SOCIAL_PUBLISH_EXTERNAL === '1';
const SOCIAL_REPHRASE_MODEL = process.env.COMMONLY_SOCIAL_REPHRASE_MODEL || process.env.AGENT_MODEL || 'gemini-2.5-flash';
const SOCIAL_IMAGE_MODEL = process.env.COMMONLY_SOCIAL_IMAGE_MODEL || 'gemini-2.5-flash-image';
const llmClient = new LiteLLMClient({
  model: SOCIAL_REPHRASE_MODEL,
  temperature: 0.55,
  maxTokens: 400,
});
const canUseLlm = () => Boolean(llmClient?.baseUrl || llmClient?.openRouterApiKey || llmClient?.geminiApiKey);

const loadConfigAccounts = () => {
  if (!configPath) return [];
  try {
    if (!fs.existsSync(configPath)) return [];
    const raw = fs.readFileSync(configPath, 'utf8');
    if (!raw.trim()) return [];
    const data = JSON.parse(raw);
    const accounts = data.accounts || {};
    return Object.entries(accounts).map(([id, account]) => ({
      id,
      ...account,
    }));
  } catch (error) {
    console.error('Failed to read COMMONLY_AGENT_CONFIG_PATH:', error.message);
    return [];
  }
};

const buildAccounts = () => {
  const configAccounts = loadConfigAccounts();
  if (configAccounts.length > 0) return configAccounts;
  if (token) {
    return [{
      id: 'default',
      runtimeToken: token,
      userToken,
      agentName: 'commonly-bot',
      instanceId: 'default',
    }];
  }
  return [];
};

const buildHeaders = (runtimeToken) => ({
  Authorization: `Bearer ${runtimeToken}`,
  'Content-Type': 'application/json',
});

const buildUserHeaders = (tokenValue) => ({
  Authorization: `Bearer ${tokenValue}`,
  'Content-Type': 'application/json',
});

const formatIntegrationSummary = (summary, sourceOverride) => {
  if (!summary) return '';
  const source = sourceOverride || summary.source || 'external';
  const sourceLabel = summary.sourceLabel || 'External';
  const channelName = summary.channelName || 'channel';
  const channelUrl = summary.channelUrl || null;
  const messageCount = summary.messageCount || 0;
  const startTime = summary.timeRange?.start
    ? new Date(summary.timeRange.start).toISOString()
    : null;
  const endTime = summary.timeRange?.end
    ? new Date(summary.timeRange.end).toISOString()
    : null;

  return `[BOT_MESSAGE]${JSON.stringify({
    type: source === 'discord' ? 'discord-summary' : 'integration-summary',
    source,
    sourceLabel,
    channel: channelName,
    channelUrl,
    messageCount,
    timeRange: { start: startTime, end: endTime },
    summary: summary.content,
    server: summary.serverName,
  })}`;
};

const fetchEvents = async (runtimeToken) => {
  const res = await fetch(`${baseUrl}/api/agents/runtime/events`, {
    headers: buildHeaders(runtimeToken),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to fetch events: ${res.status} ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.events || [];
};

const fetchRecentMessages = async (runtimeToken, podId, limit = 40) => {
  const res = await fetch(`${baseUrl}/api/agents/runtime/pods/${podId}/messages?limit=${limit}`, {
    headers: buildHeaders(runtimeToken),
  });
  if (!res.ok) {
    return [];
  }
  const data = await res.json();
  return data.messages || [];
};

const fetchSocialPosts = async (limit = SOCIAL_POST_LIMIT) => {
  try {
    const res = await fetch(`${baseUrl}/api/posts?category=Social`);
    if (!res.ok) {
      console.warn(`[commonly-bot] Social feed returned ${res.status} — skipping curate`);
      return [];
    }
    const posts = await res.json();
    if (!Array.isArray(posts)) return [];
    return posts
      .filter((post) => {
        const provider = String(post?.source?.provider || '').toLowerCase();
        return provider === 'x' || provider === 'instagram';
      })
      .slice(0, Math.max(1, limit));
  } catch (err) {
    console.warn('[commonly-bot] Failed to fetch social posts:', err.message);
    return [];
  }
};

const normalizeWords = (value) => String(value || '')
  .toLowerCase()
  .replace(/[^a-z0-9\s]/g, ' ')
  .split(/\s+/)
  .filter((word) => word.length >= 3);

const STOPWORDS = new Set([
  'about', 'after', 'again', 'against', 'also', 'because', 'being', 'between', 'could', 'from',
  'have', 'just', 'more', 'other', 'over', 'such', 'than', 'that', 'their', 'there', 'these',
  'they', 'this', 'those', 'through', 'under', 'very', 'what', 'when', 'where', 'which', 'while',
  'with', 'would', 'your', 'http', 'https',
]);

const buildTopicHints = (context) => {
  const podName = context?.pod?.name || '';
  const podDescription = context?.pod?.description || '';
  const words = [...normalizeWords(podName), ...normalizeWords(podDescription)];
  return Array.from(new Set(words)).slice(0, 10);
};

const scorePost = (post, hints = []) => {
  const content = String(post?.content || '').toLowerCase();
  if (!hints.length) return 1;
  return hints.reduce((score, hint) => (content.includes(hint) ? score + 2 : score), 1);
};

const toHashtags = (post) => {
  const tokens = normalizeWords(post?.content || '')
    .filter((word) => !STOPWORDS.has(word))
    .slice(0, 3)
    .map((word) => `#${word}`);
  return Array.from(new Set(tokens)).slice(0, 2);
};

const summarizeIdea = (text) => {
  const keywords = normalizeWords(text).filter((word) => !STOPWORDS.has(word));
  const top = Array.from(new Set(keywords)).slice(0, 5);
  if (!top.length) return 'A notable update worth discussing';
  if (top.length === 1) return `A notable update about ${top[0]}`;
  if (top.length === 2) return `A notable update about ${top[0]} and ${top[1]}`;
  return `A notable update touching on ${top[0]}, ${top[1]}, and ${top[2]}`;
};

const wordSet = (text) => new Set(normalizeWords(text).filter((word) => !STOPWORDS.has(word)));

const lexicalOverlap = (aText, bText) => {
  const a = wordSet(aText);
  const b = wordSet(bText);
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  a.forEach((word) => {
    if (b.has(word)) intersection += 1;
  });
  return intersection / Math.min(a.size, b.size);
};

const parseJsonBlock = (raw) => {
  const text = String(raw || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
};

const rephraseSocialPost = async ({ post, podName }) => {
  if (!ENABLE_SOCIAL_REPHRASE || !canUseLlm()) return null;
  const sourceText = String(post?.content || '').trim();
  if (!sourceText) return null;

  const prompt = [
    'Rewrite this source post into a short, original community-friendly summary.',
    'Constraints:',
    '- Do not copy phrases directly from the source.',
    '- Keep under 28 words.',
    '- Keep factual fidelity.',
    '- No quotation marks.',
    '- Mention why it matters to this community.',
    `Community: ${podName || 'General social pod'}`,
    '',
    `Source text: ${sourceText}`,
    '',
    'Return JSON only: {"summary":"...","why":"...","tags":["#a","#b"]}',
  ].join('\n');

  try {
    const raw = await llmClient.chat(
      'You are a careful social curator. Prioritize originality, attribution, and brevity.',
      prompt,
      { model: SOCIAL_REPHRASE_MODEL, temperature: 0.5, maxTokens: 300 },
    );
    const parsed = parseJsonBlock(raw);
    if (!parsed?.summary) return null;
    const overlap = lexicalOverlap(sourceText, parsed.summary);
    if (overlap > 0.7) return null;
    return {
      summary: String(parsed.summary).trim(),
      why: String(parsed.why || '').trim(),
      tags: Array.isArray(parsed.tags) ? parsed.tags.map((t) => String(t || '').trim()).filter(Boolean).slice(0, 2) : [],
      overlap,
    };
  } catch {
    return null;
  }
};

const generateSocialImage = async ({ headline, tags = [] }) => {
  if (!ENABLE_SOCIAL_IMAGE || !llmClient?.baseUrl) return null;
  const apiKey = llmClient.apiKey;
  const prompt = [
    'Create an editorial social card image concept.',
    'No logos or trademarks.',
    'Style: clean, modern, high contrast, abstract shapes.',
    `Headline: ${headline}`,
    tags.length ? `Tags: ${tags.join(' ')}` : '',
  ].filter(Boolean).join('\n');

  try {
    const res = await fetch(`${llmClient.baseUrl}/v1/images/generations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: SOCIAL_IMAGE_MODEL,
        prompt,
        size: '1024x1024',
        n: 1,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.data?.[0]?.url || null;
  } catch {
    return null;
  }
};

const postFeedEntry = async ({ tokenValue, podId, content, image, source }) => {
  if (!ENABLE_SOCIAL_FEED_POST || !tokenValue) return null;
  try {
    const sourceProvider = source?.provider;
    const sourceExternalId = source?.externalId;
    if (sourceProvider && sourceExternalId) {
      const existingRes = await fetch(
        `${baseUrl}/api/posts?podId=${encodeURIComponent(podId)}&category=Social`,
      );
      if (existingRes.ok) {
        const existingPosts = await existingRes.json();
        const alreadyExists = Array.isArray(existingPosts) && existingPosts.some((post) => (
          String(post?.source?.provider || '').toLowerCase() === String(sourceProvider).toLowerCase()
          && String(post?.source?.externalId || '') === String(sourceExternalId)
          && String(post?.source?.type || '') === 'external-rephrased'
        ));
        if (alreadyExists) return null;
      }
    }

    const res = await fetch(`${baseUrl}/api/posts`, {
      method: 'POST',
      headers: buildUserHeaders(tokenValue),
      body: JSON.stringify({
        podId,
        content,
        image: image || '',
        category: 'Social',
        source: source || { type: 'pod', provider: 'commonly-bot' },
      }),
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
};

const listWritableIntegrations = async (runtimeToken, podId) => {
  try {
    const res = await fetch(`${baseUrl}/api/agents/runtime/pods/${podId}/integrations`, {
      headers: buildHeaders(runtimeToken),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.integrations) ? data.integrations : [];
  } catch {
    return [];
  }
};

const publishToIntegration = async ({
  runtimeToken,
  podId,
  integrationId,
  text,
  caption,
  imageUrl,
  hashtags = [],
  sourceUrl,
}) => {
  try {
    const res = await fetch(`${baseUrl}/api/agents/runtime/pods/${podId}/integrations/${integrationId}/publish`, {
      method: 'POST',
      headers: buildHeaders(runtimeToken),
      body: JSON.stringify({
        text,
        caption,
        imageUrl,
        hashtags,
        sourceUrl,
      }),
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
};

const fetchSocialPolicy = async (runtimeToken, podId) => {
  try {
    const res = await fetch(`${baseUrl}/api/agents/runtime/pods/${podId}/social-policy`, {
      headers: buildHeaders(runtimeToken),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.policy || null;
  } catch {
    return null;
  }
};

const buildCuratedDigest = ({ posts, podName }) => {
  if (!posts.length) return null;
  const top = posts.slice(0, 3);
  const lines = top.map((post, index) => {
    const author = post?.source?.author || 'Unknown source';
    const provider = String(post?.source?.provider || 'social').toUpperCase();
    const url = post?.source?.url || post?.source?.authorUrl || '';
    const idea = summarizeIdea(post?.content || '');
    const tags = toHashtags(post);
    return [
      `${index + 1}. ${idea}.`,
      `   Source: ${author} on ${provider}${url ? ` (${url})` : ''}`,
      tags.length ? `   ${tags.join(' ')}` : null,
    ].filter(Boolean).join('\n');
  }).join('\n\n');

  const summaryText = [
    `Curator pulse for ${podName || 'this pod'}:`,
    lines,
    'Want one of these expanded into a discussion thread? Mention me.',
  ].join('\n\n');

  return {
    text: summaryText,
    summary: {
      title: 'Social Feed Highlights',
      content: summaryText,
      summaryType: 'posts',
      messageCount: top.length,
      timeRange: {
        start: top[top.length - 1]?.createdAt || new Date().toISOString(),
        end: top[0]?.createdAt || new Date().toISOString(),
      },
    },
    topPosts: top,
  };
};

const isSystemLikeMessage = (msg = {}) => {
  const content = String(msg?.content || '').trim();
  if (!content) return true;
  const lower = content.toLowerCase();
  if (lower.startsWith('[bot_message]')) return true;
  if (lower.includes('recent pod activity snapshot')) return true;
  if (lower.includes('manual summary check event')) return true;
  if (lower.includes('i\'ve received a heartbeat from the commonly scheduler')) return true;
  if (lower.includes('user token is not valid for fetching messages')) return true;

  const username = String(msg?.username || msg?.userId?.username || '').toLowerCase();
  if (!username) return false;
  if (username.includes('commonly-bot')) return true;
  if (username.includes('commonly-summarizer')) return true;
  return false;
};

const buildHeuristicPodSummary = (messages = [], { podName = 'this pod' } = {}) => {
  const meaningful = messages
    .filter((msg) => msg?.content && String(msg.content).trim())
    .filter((msg) => !isSystemLikeMessage(msg))
    .slice(-30);
  if (!meaningful.length) {
    return null;
  }

  const topics = [];
  meaningful.forEach((msg) => {
    const text = String(msg.content || '').trim();
    if (text) topics.push(text);
  });

  const seenHighlights = new Set();
  const highlights = topics
    .slice(-4)
    .map((line) => line.substring(0, 140))
    .filter((line) => {
      const key = line.toLowerCase();
      if (seenHighlights.has(key)) return false;
      seenHighlights.add(key);
      return true;
    })
    .map((line) => `- ${line}`)
    .join('\n');
  const lead = meaningful.length >= 8
    ? `Quick conversational recap from ${podName}:`
    : `A quick update from ${podName}:`;

  return {
    type: 'chat-summary',
    source: 'pod',
    sourceLabel: 'Commonly',
    channel: 'pod-chat',
    messageCount: meaningful.length,
    summary: `${lead}\n\n${highlights}`,
  };
};

const buildLlmPodSummary = async ({ messages = [], podName = 'this pod' } = {}) => {
  if (!canUseLlm()) return null;
  const meaningful = messages
    .filter((msg) => msg?.content && String(msg.content).trim())
    .filter((msg) => !isSystemLikeMessage(msg))
    .slice(-40);

  if (!meaningful.length) return null;

  const transcript = meaningful.map((msg) => {
    const author = msg.username || msg.userId?.username || 'unknown';
    const text = String(msg.content || '').replace(/\s+/g, ' ').trim();
    return `${author}: ${text}`;
  }).join('\n');

  const prompt = [
    `You are summarizing recent pod chat activity for "${podName}".`,
    'Write an intelligent, concise summary for humans.',
    'Requirements:',
    '- high signal only, no fluff',
    '- include concrete developments/decisions/blockers',
    '- avoid repeating near-duplicate points',
    '- if mostly status/noise, say so briefly',
    'Return JSON only:',
    '{"summary":"...", "highlights":["...","..."]}',
    '',
    'Messages:',
    transcript,
  ].join('\n');

  try {
    const raw = await llmClient.chat(
      'You produce terse operational summaries for team chat.',
      prompt,
      { model: SOCIAL_REPHRASE_MODEL, temperature: 0.2, maxTokens: 380 },
    );
    const parsed = parseJsonBlock(raw);
    if (!parsed?.summary) {
      const plain = String(raw || '').trim();
      if (plain) {
        return {
          type: 'chat-summary',
          source: 'pod',
          sourceLabel: 'Commonly',
          channel: 'pod-chat',
          messageCount: meaningful.length,
          summary: plain.substring(0, 700),
        };
      }
      return null;
    }
    const highlights = Array.isArray(parsed.highlights)
      ? parsed.highlights.map((v) => String(v || '').trim()).filter(Boolean).slice(0, 5)
      : [];
    const highlightText = highlights.length
      ? highlights.map((line) => `- ${line}`).join('\n')
      : '- No major developments in this window.';
    return {
      type: 'chat-summary',
      source: 'pod',
      sourceLabel: 'Commonly',
      channel: 'pod-chat',
      messageCount: meaningful.length,
      summary: [
        String(parsed.summary).trim(),
        'Highlights:',
        highlightText,
      ].filter(Boolean).join('\n\n'),
    };
  } catch {
    return null;
  }
};

const postMessage = async (runtimeToken, podId, content, metadata = {}) => {
  const res = await fetch(`${baseUrl}/api/agents/runtime/pods/${podId}/messages`, {
    method: 'POST',
    headers: buildHeaders(runtimeToken),
    body: JSON.stringify({ content, metadata }),
  });
  if (!res.ok) {
    throw new Error(`Failed to post message: ${res.status}`);
  }
  return res.json();
};

const persistSummary = async (runtimeToken, podId, {
  summary,
  summaryType = 'chats',
  source = 'pod',
  sourceLabel = 'Commonly',
  messageCount = 0,
  timeRange = null,
  eventId = null,
  title = null,
}) => {
  const res = await fetch(`${baseUrl}/api/agents/runtime/pods/${podId}/summaries`, {
    method: 'POST',
    headers: buildHeaders(runtimeToken),
    body: JSON.stringify({
      summary,
      summaryType,
      source,
      sourceLabel,
      messageCount,
      timeRange,
      eventId,
      title,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to persist summary: ${res.status} ${text.slice(0, 220)}`);
  }
  return res.json();
};

const ackEvent = async (runtimeToken, eventId) => {
  const res = await fetch(`${baseUrl}/api/agents/runtime/events/${eventId}/ack`, {
    method: 'POST',
    headers: buildHeaders(runtimeToken),
  });
  if (!res.ok) {
    throw new Error(`Failed to ack event: ${res.status}`);
  }
};

const handleEvent = async (account, event) => {
  const runtimeToken = account?.runtimeToken;
  const silentDelivery = event?.payload?.silent === true;
  const accountUserToken = account?.userToken || userToken;
  if (event?.type === 'curate') {
    const topN = Math.min(Math.max(parseInt(event?.payload?.topN, 10) || 3, 1), 5);
    const context = await fetch(`${baseUrl}/api/agents/runtime/pods/${event.podId}/context`, {
      headers: buildHeaders(runtimeToken),
    }).then((res) => (res.ok ? res.json() : null)).catch(() => null);
    const hints = buildTopicHints(context);
    const socialPosts = await fetchSocialPosts(event?.payload?.limit || SOCIAL_POST_LIMIT);
    const ranked = socialPosts
      .map((post) => ({ post, score: scorePost(post, hints) }))
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.post);
    const digest = buildCuratedDigest({
      posts: ranked.slice(0, topN),
      podName: context?.pod?.name,
    });

    if (!digest) {
      await ackEvent(runtimeToken, event._id);
      return;
    }

    await postMessage(runtimeToken, event.podId, digest.text, {
      source: 'commonly-bot',
      eventId: event._id,
      summaryType: 'posts',
      messageCount: digest.summary.messageCount,
      summary: digest.summary,
    });

    const socialPolicy = await fetchSocialPolicy(runtimeToken, event.podId);
    const policyMode = String(socialPolicy?.socialMode || 'repost').toLowerCase();
    const policyPublishEnabled = Boolean(socialPolicy?.publishEnabled);
    const policyStrictAttribution = socialPolicy?.strictAttribution !== false;
    const useRewriteMode = policyMode === 'rewrite';

    // Optional per-item feed posts with policy-aware curation + optional generated image.
    if (ENABLE_SOCIAL_FEED_POST && digest.topPosts?.length) {
      let externalPublished = false;
      for (const post of digest.topPosts) {
        // eslint-disable-next-line no-await-in-loop
        const rewritten = useRewriteMode
          ? await rephraseSocialPost({
            post,
            podName: context?.pod?.name,
          })
          : null;
        const tags = (rewritten?.tags?.length ? rewritten.tags : toHashtags(post)).slice(0, 2);
        const sourceAuthor = post?.source?.author || 'Unknown source';
        const sourceProvider = String(post?.source?.provider || 'social').toUpperCase();
        const sourceUrl = post?.source?.url || post?.source?.authorUrl || '';
        const summaryLine = useRewriteMode
          ? (rewritten?.summary || summarizeIdea(post?.content || ''))
          : `Shared signal from ${sourceProvider}`;
        const whyLine = useRewriteMode && rewritten?.why ? `Why it matters: ${rewritten.why}` : '';
        // eslint-disable-next-line no-await-in-loop
        const generatedImage = await generateSocialImage({ headline: summaryLine, tags });
        const sourceLine = `Source: ${sourceAuthor} on ${sourceProvider}${sourceUrl ? ` (${sourceUrl})` : ''}`;
        const postContent = useRewriteMode
          ? [
            summaryLine,
            whyLine,
            tags.length ? tags.join(' ') : '',
            sourceLine,
          ].filter(Boolean).join('\n\n')
          : [
            summaryLine,
            sourceLine,
            tags.length ? tags.join(' ') : '',
          ].filter(Boolean).join('\n\n');
        // eslint-disable-next-line no-await-in-loop
        await postFeedEntry({
          tokenValue: accountUserToken,
          podId: event.podId,
          content: postContent,
          image: generatedImage || '',
          source: {
            type: 'external-rephrased',
            provider: post?.source?.provider || 'social',
            externalId: post?.source?.externalId || null,
            url: sourceUrl || null,
            author: sourceAuthor,
            authorUrl: post?.source?.authorUrl || null,
            channel: post?.source?.channel || null,
          },
        });

        if (ENABLE_SOCIAL_EXTERNAL_PUBLISH && policyPublishEnabled && !externalPublished) {
          if (policyStrictAttribution && !sourceUrl) {
            // Skip external publish when strict attribution requires a source link.
            // eslint-disable-next-line no-continue
            continue;
          }
          // eslint-disable-next-line no-await-in-loop
          const integrations = await listWritableIntegrations(runtimeToken, event.podId);
          const target = integrations.find((item) => ['x', 'instagram'].includes(String(item?.type || '').toLowerCase()));
          if (target?.id) {
            const publishText = useRewriteMode ? postContent : 'Shared via Commonly';
            // eslint-disable-next-line no-await-in-loop
            const published = await publishToIntegration({
              runtimeToken,
              podId: event.podId,
              integrationId: target.id,
              text: publishText,
              caption: publishText,
              imageUrl: generatedImage || post?.image || '',
              hashtags: tags,
              sourceUrl: sourceUrl || undefined,
            });
            if (published?.success) {
              externalPublished = true;
            }
          }
        }
      }
    }

    await ackEvent(runtimeToken, event._id);
    return;
  }

  if (!event?.payload?.summary && event?.type === 'summary.request') {
    const messages = await fetchRecentMessages(runtimeToken, event.podId, 30);
    const context = await fetch(`${baseUrl}/api/agents/runtime/pods/${event.podId}/context`, {
      headers: buildHeaders(runtimeToken),
    }).then((res) => (res.ok ? res.json() : null)).catch(() => null);

    const synthetic = await buildLlmPodSummary({
      messages,
      podName: context?.pod?.name || 'this pod',
    }) || buildHeuristicPodSummary(messages, {
      podName: context?.pod?.name || 'this pod',
    });
    if (!synthetic?.summary) {
      return ackEvent(runtimeToken, event._id);
    }

    if (silentDelivery) {
      await persistSummary(runtimeToken, event.podId, {
        summary: synthetic.summary,
        summaryType: 'chats',
        source: synthetic.source || 'pod',
        sourceLabel: synthetic.sourceLabel || 'Commonly',
        messageCount: synthetic.messageCount || 0,
        eventId: event._id?.toString?.() || event._id,
      });
      return ackEvent(runtimeToken, event._id);
    }

    const content = `[BOT_MESSAGE]${JSON.stringify(synthetic)}`;
    await postMessage(runtimeToken, event.podId, content, {
      source: 'commonly-bot',
      eventId: event._id,
      summaryType: 'chats',
      messageCount: synthetic.messageCount,
    });
    return ackEvent(runtimeToken, event._id);
  }

  if (!event?.payload?.summary) {
    return ackEvent(runtimeToken, event._id);
  }

  if (silentDelivery) {
    return ackEvent(runtimeToken, event._id);
  }

  const content = formatIntegrationSummary(event.payload.summary, event.payload.source);
  if (!content) {
    return ackEvent(runtimeToken, event._id);
  }

  await postMessage(runtimeToken, event.podId, content, {
    source: 'commonly-bot',
    eventId: event._id,
    summaryType: event.payload?.summary?.summaryType || 'chats',
    messageCount: event.payload?.summary?.messageCount || 0,
  });

  return ackEvent(runtimeToken, event._id);
};

const pollAccount = async (account) => {
  try {
    if (!account.runtimeToken) {
      return;
    }
    const events = await fetchEvents(account.runtimeToken);
    for (const event of events) {
      await handleEvent(account, event);
    }
  } catch (error) {
    console.error(`Commonly Bot poll failed (${account.id}):`, error.message);
  }
};

const intervalMs = parseInt(process.env.COMMONLY_AGENT_POLL_MS, 10) || 5000;

console.log('Commonly Bot starting...');
console.log(`  Commonly API: ${baseUrl}`);
console.log(`  Poll interval: ${intervalMs}ms`);
if (configPath) {
  console.log(`  Config: ${configPath}`);
}

if (userToken) {
  console.log('  User token: configured (single account)');
} else {
  console.log('  User token: not set (runtime-only mode)');
}

const initialAccounts = buildAccounts();
if (initialAccounts.length === 0) {
  console.error('No agent tokens configured. Set COMMONLY_AGENT_TOKEN or COMMONLY_AGENT_CONFIG_PATH.');
  process.exit(1);
}

Promise.all(
  initialAccounts.map((account) => (
    fetchEvents(account.runtimeToken)
      .then((events) => {
        console.log(`Commonly Bot connected (${account.id}). ${events.length} pending events.`);
      })
      .catch((err) => {
        console.error(`Commonly Bot connection failed (${account.id}):`, err.message);
      })
  )),
).catch(() => {});

let isPolling = false;
setInterval(async () => {
  if (isPolling) return;
  isPolling = true;
  const accounts = buildAccounts();
  for (const account of accounts) {
    // eslint-disable-next-line no-await-in-loop
    await pollAccount(account);
  }
  isPolling = false;
}, intervalMs);
