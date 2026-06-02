// Geracao de imagem via OpenAI Images API (gpt-image-1) para fundos de slide
// de carrossel. Usa a chave unica da agencia (OPENAI_API_KEY). Sem SDK - fetch direto.
const API = 'https://api.openai.com/v1/images/generations';

// Prompt de fundo pra um slide especifico, usando o texto do slide como contexto
// visual (mas SEM escrever texto na imagem).
function buildSlidePrompt({ niche, theme, slideText }) {
  const contexto = [slideText, theme].filter(Boolean).join('. ').slice(0, 300) || niche || 'negocio';
  return [
    `Imagem de fundo profissional para slide de carrossel de Instagram.`,
    niche ? `Segmento do negocio: ${niche}.` : '',
    `Tema/contexto do slide: ${contexto}.`,
    'Estilo: fotografia publicitaria moderna, iluminacao suave, cores harmonicas,',
    'composicao com bastante espaco limpo (espaco negativo) para sobrepor texto depois.',
    'IMPORTANTE: nao escreva nenhum texto, letra, numero ou logo na imagem.',
    'Alta qualidade, visual premium, coeso para redes sociais.',
  ].filter(Boolean).join(' ');
}

// Gera 1 imagem 1024x1024 a partir de um prompt ja montado. Retorna { buffer, mime }.
// quality: 'low' | 'medium' | 'high' (default medium - bom custo/qualidade).
async function generateImageFromPrompt(prompt, quality = 'medium') {
  if (!process.env.OPENAI_API_KEY) {
    const e = new Error('OPENAI_API_KEY nao configurada');
    e.code = 'NO_OPENAI_KEY';
    throw e;
  }
  const res = await fetch(API, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: 'gpt-image-1', prompt, n: 1, size: '1024x1024', quality }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error('OpenAI imagem falhou: ' + (data.error?.message || res.status));
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) throw new Error('OpenAI nao retornou imagem');
  return { buffer: Buffer.from(b64, 'base64'), mime: 'image/png' };
}

module.exports = { buildSlidePrompt, generateImageFromPrompt };
