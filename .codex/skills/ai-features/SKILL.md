---
name: ai-features
description: AI and prompt engineering context for Gemini API integration, summarization, sentiment analysis, and daily digests. Use when working on AI-powered features.
---

# AI & Prompt Engineering

**Technologies**: Google Gemini API, LiteLLM (OpenAI-compatible), NLP, Text Summarization

## Required Knowledge
- LLM API integration (Gemini) and gateway routing (LiteLLM)
- Prompt engineering techniques
- Text summarization algorithms
- Sentiment analysis concepts
- JSON response parsing from AI
- Fallback handling for AI failures

## Relevant Documentation

| Document | Topics Covered |
|----------|----------------|
| [AI_FEATURES.md](../../../docs/ai-features/AI_FEATURES.md) | Three-layer architecture, prompts, analytics |
| [DAILY_DIGESTS.md](../../../docs/ai-features/DAILY_DIGESTS.md) | Newsletter generation, personalization |
| [VISUALIZATION_ROADMAP.md](../../../docs/ai-features/VISUALIZATION_ROADMAP.md) | Future keyword extraction, graphs |

## AI Architecture

```
Layer 1: Real-time Collection
├── Message ingestion
├── Basic summarization
└── Immediate display

Layer 2: Enhanced Analytics
├── Timeline event detection
├── Quote extraction & sentiment
├── Insight identification
└── Atmosphere analysis

Layer 3: Daily Intelligence
├── Cross-pod pattern recognition
├── Personalized digest generation
└── Community health metrics
```

## Key Services

```
backend/services/
├── llmService.js             # LLM routing (LiteLLM -> Gemini fallback)
├── summarizerService.js       # Basic AI summarization
├── chatSummarizerService.js   # Enhanced chat analysis
├── dailyDigestService.js      # Newsletter generation
└── podSkillService.js         # LLM markdown skill synthesis
```

## LLM Routing

- Use `LITELLM_BASE_URL` + `LITELLM_API_KEY` to route chat completions through LiteLLM.
- If LiteLLM is unset, services fall back to Gemini via `GEMINI_API_KEY`.

## Prompt Engineering Patterns

### Structured Output
```javascript
const prompt = `Analyze the following messages and return JSON:
{
  "summary": "2-3 sentence summary",
  "sentiment": "positive|neutral|negative",
  "topics": ["topic1", "topic2"],
  "keyQuotes": [{ "text": "...", "author": "..." }]
}

Messages:
${messages.map(m => `${m.author}: ${m.content}`).join('\n')}`;
```

### Fallback Handling
```javascript
try {
  const text = await generateText(prompt, { temperature: 0.2 });
  return JSON.parse(text);
} catch (error) {
  return { summary: "Unable to generate summary", error: true };
}
```
