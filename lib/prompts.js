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
  reel: `REEL (vídeo curto de 20-60s). Este é o formato que exige o roteiro MAIS detalhado e específico.
O campo "body" deve ser um roteiro de vídeo completo, dividido em CENAS, não um texto corrido. Estruture assim:
- [0-3s] GANCHO: a fala exata de abertura + o que aparece na tela (ação/enquadramento) + o texto curto que vai sobreposto na tela.
- DESENVOLVIMENTO: quebre em 4 a 6 cenas numeradas ("Cena 1:", "Cena 2:", ...). Em CADA cena escreva três coisas: a FALA/narração (o que é dito, palavra por palavra), a AÇÃO (o que está sendo filmado/mostrado) e o TEXTO NA TELA (legenda sobreposta).
- FECHAMENTO: frase de virada que prepara o CTA.
Inclua sugestões de corte, b-roll e ritmo entre as cenas. O body do reel deve ser claramente mais longo e granular que os outros formatos (no mínimo 6 a 10 blocos entre gancho, cenas e fechamento).`,
  carrossel: `CARROSSEL (6 a 10 slides): o primeiro slide é o gancho/capa, os slides do meio constroem a narrativa (uma ideia por slide), o último slide é o CTA.
O campo "body" deve ter um slide por linha com prefixo "Slide N:", cada um com texto curto, escaneável e com começo de frase que puxa pro próximo slide.`,
  post: `POST estático (1 imagem + legenda): conteúdo direto e enxuto.
O campo "body" é a mensagem central em poucos parágrafos curtos — hook na primeira linha, desenvolvimento objetivo, fechamento que leva ao CTA. Não divida em cenas nem em slides.`,
  story: `STORY (sequência de 3 a 5 stories): tom pessoal e direto, com interação (enquete, caixa de pergunta, contagem regressiva, link).
O campo "body" deve ter um story por linha com prefixo "Story N:", indicando em cada um a fala/texto na tela e a interação sugerida.`,
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
  "body": "Corpo principal seguindo EXATAMENTE a estrutura descrita em FORMATO acima. Para reel, entregue o roteiro cena por cena, detalhado e mais longo. Para carrossel/story, use prefixo 'Slide N:' ou 'Story N:' por linha. Para post, parágrafos curtos.",
  "cta": "Chamada para acao curta e direta",
  "caption": "Legenda pronta pra publicar no Instagram (texto fluido, com emojis estrategicos e quebras de linha). Para REEL, a caption NAO repete o roteiro de cenas: e uma legenda curta e envolvente que acompanha o video. Para carrossel/post, pode reunir o conteudo principal num texto corrido.",
  "hashtags": ["#hashtag1", "#hashtag2", "..."]
}

Importante:
- Adapte profundamente o conteudo ao FORMATO: o body de um reel deve ser o mais detalhado (cena por cena), enquanto post e o mais enxuto
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

function clientSummaryForPrompt(client) {
  if (!client) return '(cliente nao informado)';
  return [
    `Nome/marca: ${client.name}`,
    client.niche && `Nicho: ${client.niche}`,
    client.instagram_handle && `Instagram: ${client.instagram_handle}`,
  ].filter(Boolean).join('\n');
}

// Planejamento estrategico de conteudo (pilares, cadencia, objetivos, mix de formatos).
function planningPrompt({ client, persona, goal, notes }) {
  const system = `Voce e estrategista de conteudo para Instagram no mercado brasileiro.
Monta planejamentos editoriais claros, acionaveis e adaptados ao negocio e a persona.
Escreve em portugues brasileiro natural. Sempre responde no formato JSON solicitado, sem comentarios.`;

  const user = `Crie um planejamento de conteudo para o seguinte cliente:

CLIENTE:
${clientSummaryForPrompt(client)}

PERSONA:
${personaSummaryForPrompt(persona)}

OBJETIVO PRINCIPAL:
${goal || '(crescer audiencia e gerar vendas de forma equilibrada)'}

OBSERVACOES:
${notes || '(nenhuma)'}

Responda APENAS um JSON valido no formato, em portugues brasileiro:

{
  "title": "Titulo curto do planejamento (ex: 'Planejamento Q3 - autoridade e vendas')",
  "summary": "Resumo de 2-4 frases da estrategia geral",
  "pillars": [
    { "name": "Nome do pilar (ex: 'Bastidores')", "description": "O que entra nesse pilar e por que" }
  ],
  "cadence": "Frequencia recomendada de posts (ex: '5 posts por semana: 3 reels, 1 carrossel, 1 story diario')",
  "objectives": ["objetivo mensuravel 1", "objetivo 2", "objetivo 3"],
  "format_mix": { "reel": 40, "carrossel": 30, "post": 15, "story": 15 }
}

Importante:
- 3 a 5 pilares de conteudo coerentes com a persona e o nicho
- format_mix em porcentagem, somando 100
- Objetivos especificos (nao genericos)`;

  return { system, user };
}

// Ideias de conteudo derivadas (idealmente) de um planejamento.
function ideasPrompt({ client, persona, plan, count = 10 }) {
  const system = `Voce e roteirista de conteudo para Instagram brasileiro.
Gera ideias de post especificas, originais e prontas pra virar roteiro/carrossel.
Escreve em portugues brasileiro natural. Sempre responde no formato JSON solicitado, sem comentarios.`;

  const planBlock = plan
    ? `PLANEJAMENTO BASE (siga os pilares e o mix de formatos):
Titulo: ${plan.title || ''}
Resumo: ${plan.summary || ''}
Pilares: ${Array.isArray(plan.pillars) ? plan.pillars.map((p) => p.name || p).join('; ') : ''}
Cadencia: ${plan.cadence || ''}
Mix de formatos: ${plan.format_mix ? JSON.stringify(plan.format_mix) : '(livre)'}
`
    : '(sem planejamento; gere ideias equilibradas por etapa do funil e formato)\n';

  const user = `Gere ${count} ideias de conteudo para o cliente abaixo.

CLIENTE:
${clientSummaryForPrompt(client)}

PERSONA:
${personaSummaryForPrompt(persona)}

${planBlock}
Responda APENAS um JSON valido no formato:

{
  "ideas": [
    {
      "title": "Titulo/gancho curto da ideia",
      "description": "1-2 frases explicando o angulo do conteudo",
      "format": "reel | carrossel | post | story",
      "funnel_stage": "topo | meio | fundo",
      "pillar": "nome do pilar (se houver planejamento; senao deixe vazio)"
    }
  ]
}

Importante:
- Exatamente ${count} ideias, variando formato e etapa do funil
- Cada ideia especifica e acionavel (nao generica)
- "format" e "funnel_stage" sempre em minusculo e dentro das opcoes dadas`;

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
  planningPrompt,
  ideasPrompt,
  personaSummaryForPrompt,
  clientSummaryForPrompt,
  parseJsonFromText,
  FUNNEL_GUIDANCE,
  FORMAT_GUIDANCE,
};
