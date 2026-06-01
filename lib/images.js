// Geracao de imagem via OpenAI Images API (gpt-image-1), usado pra capa de carrossel.
// Usa a chave unica da agencia (OPENAI_API_KEY). Sem SDK - fetch direto.
const API = 'https://api.openai.com/v1/images/generations';

// Monta um prompt de FUNDO (sem texto - o texto do slide vai por cima via HTML/PDF).
function buildCoverPrompt({ niche, theme, title }) {
  const assunto = [theme, title].filter(Boolean).join(' - ') || niche || 'negocio';
  return [
    `Imagem de fundo profissional para post de Instagram sobre: ${assunto}.`,
    niche ? `Segmento: ${niche}.` : '',
    'Estilo: fotografia publicitaria moderna, iluminacao suave, cores harmonicas,',
    'composicao com area limpa (espaco negativo) para sobrepor texto depois.',
    'IMPORTANTE: nao escreva nenhum texto, letra ou logo na imagem.',
    'Alta qualidade, visual premium, adequado para redes sociais.',
  ].filter(Boolean).join(' ');
}

// Gera 1 imagem quadrada (1024x1024) e retorna { buffer, mime }.
// quality: 'low' | 'medium' | 'high' (default medium - bom custo/qualidade).
async function generateCoverImage({ niche, theme, title, quality = 'medium' }) {
  if (!process.env.OPENAI_API_KEY) {
    const e = new Error('OPENAI_API_KEY nao configurada');
    e.code = 'NO_OPENAI_KEY';
    throw e;
  }

  const prompt = buildCoverPrompt({ niche, theme, title });
  const res = await fetch(API, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-image-1',
      prompt,
      n: 1,
      size: '1024x1024',
      quality,
    }),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error('OpenAI imagem falhou: ' + (data.error?.message || res.status));
  }

  // gpt-image-1 retorna sempre base64 em data[0].b64_json
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) throw new Error('OpenAI nao retornou imagem');
  return { buffer: Buffer.from(b64, 'base64'), mime: 'image/png' };
}

module.exports = { generateCoverImage, buildCoverPrompt };
