const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const MODEL = 'claude-haiku-4-5-20251001';

async function generate({ system, prompt, maxTokens = 2000, temperature = 0.7 }) {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    temperature,
    system,
    messages: [{ role: 'user', content: prompt }],
  });
  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
  return {
    text,
    usage: response.usage,
  };
}

module.exports = { generate, MODEL };
