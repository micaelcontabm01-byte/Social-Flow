const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const MODEL = 'claude-sonnet-5';

// Sonnet 5 rejeita temperature/top_p/top_k com valor nao-padrao (400) - por
// isso nao aceita mais esse parametro (era usado com o Haiku antes).
async function generate({ system, prompt, maxTokens = 2000 }) {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
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
