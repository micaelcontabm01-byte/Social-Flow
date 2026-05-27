function personaPrompt({ niche, target, goal, tone, notes, clientName }) {
  const system = `Voce e especialista em construcao de persona para marketing digital brasileiro.
Gera personas realistas, profundas e acionaveis com base em informacoes do negocio.
Sempre responde no formato JSON solicitado, sem comentarios adicionais.`;

  const user = `Crie uma persona detalhada para o seguinte negocio:

Cliente/marca: ${clientName || '(nao especificado)'}
Nicho/segmento: ${niche || '(nao especificado)'}
Publico-alvo descrito: ${target || '(nao especificado)'}
Objetivo principal: ${goal || '(nao especificado)'}
Tom de voz desejado: ${tone || '(nao especificado)'}
Observacoes: ${notes || '(nenhuma)'}

Responda APENAS um JSON valido no seguinte formato, em portugues brasileiro:

{
  "name": "Nome descritivo curto (ex: 'Marina, empreendedora urbana')",
  "age_range": "Faixa etaria (ex: '28-35')",
  "gender": "Feminino, Masculino ou Misto",
  "location": "Cidade/regiao principal (ex: 'Capitais do Sudeste')",
  "profession": "Profissao ou ocupacao",
  "income_range": "Faixa de renda (ex: 'R$ 5k a R$ 15k')",
  "pain_points": ["dor 1 especifica", "dor 2 especifica", "dor 3 especifica"],
  "desires": ["desejo 1", "desejo 2", "desejo 3"],
  "objections": ["objecao 1", "objecao 2", "objecao 3"],
  "language_tone": "Descricao breve do tom (ex: 'Direto, informal, acolhedor')",
  "channels": ["Instagram", "TikTok", "YouTube"]
}

Importante: dores, desejos e objecoes devem ser frases curtas e especificas (nao genericas).`;

  return { system, user };
}

function personaSummaryForPrompt(persona) {
  if (!persona) return '(persona nao informada)';
  return [
    `Nome: ${persona.name}`,
    persona.profession && `Profissao: ${persona.profession}`,
    persona.age_range && `Idade: ${persona.age_range}`,
    persona.gender && `Genero: ${persona.gender}`,
    persona.location && `Local: ${persona.location}`,
    persona.income_range && `Renda: ${persona.income_range}`,
    persona.pain_points?.length && `Dores: ${persona.pain_points.join('; ')}`,
    persona.desires?.length && `Desejos: ${persona.desires.join('; ')}`,
    persona.objections?.length && `Objecoes: ${persona.objections.join('; ')}`,
    persona.language_tone && `Tom: ${persona.language_tone}`,
    persona.channels?.length && `Canais: ${persona.channels.join(', ')}`,
  ].filter(Boolean).join('\n');
}

const FUNNEL_GUIDANCE = {
  topo: 'TOPO de funil (descoberta): conteudo educativo, gancho com dor abstrata ou curiosidade, sem mencionar produto, voltado a atrair publico novo. CTA leve (salvar, comentar).',
  meio: 'MEIO de funil (consideracao): aprofunda a dor, mostra que existe solucao, gera relacionamento com quem ja conhece. Pode citar metodologia/diferencial. CTA medio (comentar, conversar no DM).',
  fundo: 'FUNDO de funil (conversao): apresenta oferta clara, prova social, urgencia, CTA direto pra compra/contato.',
};

const FORMAT_GUIDANCE = {
  reel: 'REEL (video curto 15-60s): hook nos 3 primeiros segundos, narrativa visual, ritmo dinamico, gancho continuo. Body = roteiro falado.',
  carrossel: 'CARROSSEL (6 a 10 slides): primeiro slide e o gancho/capa, slides 2-N constroem a narrativa, ultimo slide e o CTA. Body = um slide por linha com prefixo "Slide N:".',
  post: 'POST estatico (1 imagem + legenda): copy direta na legenda, hook na primeira linha, CTA no final.',
  story: 'STORY (sequencia de stories): perguntas, enquetes, conexao direta. Body = um story por linha com prefixo "Story N:".',
};

function scriptPrompt({ persona, funnelStage, format, theme, goal, notes }) {
  const system = `Voce e especialista em copywriting para Instagram brasileiro.
Cria conteudo persuasivo, autentico e adaptado a persona, etapa do funil e formato.
Escreve em portugues brasileiro natural, evita jargao gringo, usa lingua coloquial quando faz sentido.
Sempre responde no formato JSON solicitado, sem comentarios adicionais.`;

  const user = `Crie um conteudo para Instagram com as seguintes especificacoes:

PERSONA:
${personaSummaryForPrompt(persona)}

ETAPA DO FUNIL:
${FUNNEL_GUIDANCE[funnelStage] || funnelStage}

FORMATO:
${FORMAT_GUIDANCE[format] || format}

TEMA / ASSUNTO:
${theme || '(livre, escolha baseado na persona)'}

OBJETIVO DESSE CONTEUDO:
${goal || '(adequar a etapa do funil)'}

OBSERVACOES:
${notes || '(nenhuma)'}

Responda APENAS um JSON valido no formato:

{
  "title": "Titulo curto descritivo do conteudo (3-7 palavras, so pra organizacao interna)",
  "hook": "Frase de abertura impactante (1-2 linhas, prende atencao)",
  "body": "Corpo principal adaptado ao formato. Para carrossel/story, use prefixo 'Slide N:' ou 'Story N:' por linha.",
  "cta": "Chamada para acao curta e direta",
  "caption": "Legenda completa pronta pra publicar: junte hook + body + cta em um texto fluido, com emojis estrategicos e quebras de linha. Para reel essa e a legenda do video. Para carrossel/post e o texto completo.",
  "hashtags": ["#hashtag1", "#hashtag2", "..."]
}

Importante:
- 5 a 12 hashtags relevantes ao nicho e tema
- Caption deve ser pronta pra copiar e colar no Instagram
- Tom da persona deve ser refletido em toda copy`;

  return { system, user };
}

function carouselPrompt({ persona, template, theme, scriptContent, goal, notes }) {
  const fieldsList = template.fields
    .map((f) => `  "${f.key}": ${f.label} (max ${f.max} caracteres)`)
    .join('\n');

  const system = `Voce e copywriter de carrosseis para Instagram brasileiro.
Cria textos curtos, impactantes, claros - cada campo respeita o limite de caracteres.
Considera o template, o objetivo e a persona pra escolher tom e abordagem.
Sempre responde no formato JSON solicitado.`;

  const user = `Crie o conteudo de um carrossel com base nas informacoes abaixo:

PERSONA:
${personaSummaryForPrompt(persona)}

TEMA / ASSUNTO:
${theme || '(escolha baseado na persona e script)'}

${scriptContent ? 'ROTEIRO BASE:\n' + scriptContent + '\n' : ''}OBJETIVO:
${goal || '(autoridade e engajamento)'}

TEMPLATE: ${template.name}
DESCRICAO: ${template.description}

CAMPOS PRA PREENCHER:
${fieldsList}

OBSERVACOES:
${notes || '(nenhuma)'}

Responda APENAS um JSON valido onde cada chave e um dos campos acima, e o valor e o texto pronto pra usar.
Importante:
- Cada texto deve respeitar o limite de caracteres
- Capa deve ser hook forte que prende atencao
- CTA final deve ser claro e direto
- Tom da persona deve refletir em toda copy
- Para tutoriais, cada step deve ter acao concreta`;

  return { system, user };
}

function parseJsonFromText(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const match = cleaned.match(/\{[\s\S]*\}/);
  const candidate = match ? match[0] : cleaned;
  return JSON.parse(candidate);
}

module.exports = {
  personaPrompt,
  scriptPrompt,
  carouselPrompt,
  personaSummaryForPrompt,
  parseJsonFromText,
  FUNNEL_GUIDANCE,
  FORMAT_GUIDANCE,
};
