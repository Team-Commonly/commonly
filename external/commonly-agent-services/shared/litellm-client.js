/**
 * LiteLLM Client
 *
 * Wrapper for calling LLM models via LiteLLM gateway.
 * Supports OpenAI-compatible API format.
 */

class LiteLLMClient {
  constructor(config = {}) {
    this.baseUrl = config.baseUrl || process.env.LITELLM_BASE_URL || 'http://litellm:4000';
    this.apiKey = config.apiKey || process.env.LITELLM_API_KEY || process.env.LITELLM_MASTER_KEY;
    this.defaultModel = config.model || process.env.AGENT_MODEL || 'gemini-2.5-flash';
    this.defaultTemperature = config.temperature || 0.7;
    this.defaultMaxTokens = config.maxTokens || 1024;
  }

  /**
   * Get headers for API calls
   */
  get headers() {
    const headers = { 'Content-Type': 'application/json' };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  /**
   * Call the chat completions endpoint
   */
  async chatCompletion(messages, options = {}) {
    const model = options.model || this.defaultModel;
    const temperature = options.temperature ?? this.defaultTemperature;
    const maxTokens = options.maxTokens || this.defaultMaxTokens;

    const body = {
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
    };

    // Add optional parameters
    if (options.tools) body.tools = options.tools;
    if (options.toolChoice) body.tool_choice = options.toolChoice;
    if (options.stop) body.stop = options.stop;

    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`LiteLLM request failed: ${res.status} ${text.slice(0, 200)}`);
    }

    return res.json();
  }

  /**
   * Simple helper to get text response
   */
  async chat(systemPrompt, userMessage, options = {}) {
    const messages = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: userMessage });

    const response = await this.chatCompletion(messages, options);
    return response?.choices?.[0]?.message?.content || '';
  }

  /**
   * Call with conversation history
   */
  async chatWithHistory(systemPrompt, history, userMessage, options = {}) {
    const messages = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }

    // Add conversation history
    for (const msg of history) {
      messages.push({
        role: msg.role || (msg.isAgent ? 'assistant' : 'user'),
        content: msg.content,
      });
    }

    // Add current user message
    messages.push({ role: 'user', content: userMessage });

    const response = await this.chatCompletion(messages, options);
    return response?.choices?.[0]?.message?.content || '';
  }

  /**
   * Sanitize response to remove internal thinking/tooling leakage
   */
  static sanitizeResponse(raw) {
    const text = String(raw || '').trim();
    if (!text) return '';

    // Filter out common problematic patterns
    if (text.includes('NO_REPLY') || /no reply from agent\.?/i.test(text)) {
      return '';
    }

    const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
    const filtered = lines.filter((line) => (
      !/^i (will|am|seem|see|checked|cannot|can't|do not|don't|will try|will now|will respond)/i.test(line)
      && !/channel is required|unknown channel|unknown target|action send requires/i.test(line)
      && !/telegram|discord|slack|webchat|tool/i.test(line)
    ));

    if (filtered.length === 0) {
      return '';
    }

    return filtered.join('\n').trim();
  }

  /**
   * Test connection to LiteLLM
   */
  async testConnection() {
    try {
      const res = await fetch(`${this.baseUrl}/health`, {
        headers: this.headers,
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * List available models
   */
  async listModels() {
    const res = await fetch(`${this.baseUrl}/v1/models`, {
      headers: this.headers,
    });
    if (!res.ok) {
      throw new Error(`Failed to list models: ${res.status}`);
    }
    const data = await res.json();
    return data.data || [];
  }
}

module.exports = LiteLLMClient;
