const TEMPLATES = [
  {
    id: 'minimal_quote',
    name: 'Quote Minimalista',
    description: 'Frases impactantes em fundo limpo, ideal para autoridade',
    slide_count: 6,
    palette: { bg: '#faf6f0', fg: '#3d2c1d', accent: '#a0826d', muted: '#6b5848' },
    font_family: '"Inter", -apple-system, sans-serif',
    fields: [
      { slide: 1, role: 'cover', key: 'cover_headline', label: 'Frase de capa', max: 90 },
      { slide: 1, role: 'cover', key: 'cover_subhead', label: 'Sub linha (opcional)', max: 60 },
      { slide: 2, role: 'content', key: 'point_1', label: 'Ponto 1', max: 180 },
      { slide: 3, role: 'content', key: 'point_2', label: 'Ponto 2', max: 180 },
      { slide: 4, role: 'content', key: 'point_3', label: 'Ponto 3', max: 180 },
      { slide: 5, role: 'content', key: 'closer', label: 'Fechamento', max: 200 },
      { slide: 6, role: 'cta', key: 'cta_text', label: 'CTA final', max: 100 },
    ],
  },
  {
    id: 'tutorial_steps',
    name: 'Tutorial em passos',
    description: 'Passos numerados para ensinar algo',
    slide_count: 7,
    palette: { bg: '#3d2c1d', fg: '#faf6f0', accent: '#d4a574', muted: '#c4b094' },
    font_family: '"Inter", -apple-system, sans-serif',
    fields: [
      { slide: 1, role: 'cover', key: 'cover_title', label: 'Titulo do tutorial', max: 80 },
      { slide: 1, role: 'cover', key: 'cover_promise', label: 'Promessa (o que vao aprender)', max: 100 },
      { slide: 2, role: 'step', key: 'step_1_title', label: 'Passo 1 - titulo', max: 60 },
      { slide: 2, role: 'step', key: 'step_1_body', label: 'Passo 1 - explicacao', max: 220 },
      { slide: 3, role: 'step', key: 'step_2_title', label: 'Passo 2 - titulo', max: 60 },
      { slide: 3, role: 'step', key: 'step_2_body', label: 'Passo 2 - explicacao', max: 220 },
      { slide: 4, role: 'step', key: 'step_3_title', label: 'Passo 3 - titulo', max: 60 },
      { slide: 4, role: 'step', key: 'step_3_body', label: 'Passo 3 - explicacao', max: 220 },
      { slide: 5, role: 'step', key: 'step_4_title', label: 'Passo 4 - titulo', max: 60 },
      { slide: 5, role: 'step', key: 'step_4_body', label: 'Passo 4 - explicacao', max: 220 },
      { slide: 6, role: 'recap', key: 'recap', label: 'Recapitulacao / dica bonus', max: 240 },
      { slide: 7, role: 'cta', key: 'cta', label: 'CTA final', max: 100 },
    ],
  },
  {
    id: 'bold_statement',
    name: 'Manifesto / Posicionamento',
    description: 'Headline grande com posicionamento forte e provas',
    slide_count: 6,
    palette: { bg: '#a0826d', fg: '#faf6f0', accent: '#3d2c1d', muted: '#ebe2d3' },
    font_family: '"Inter", -apple-system, sans-serif',
    fields: [
      { slide: 1, role: 'cover', key: 'hero_headline', label: 'Headline gigante', max: 70 },
      { slide: 1, role: 'cover', key: 'hero_subhead', label: 'Subheadline', max: 100 },
      { slide: 2, role: 'argument', key: 'arg_1', label: 'Argumento 1', max: 200 },
      { slide: 3, role: 'argument', key: 'arg_2', label: 'Argumento 2', max: 200 },
      { slide: 4, role: 'argument', key: 'arg_3', label: 'Argumento 3', max: 200 },
      { slide: 5, role: 'proof', key: 'proof', label: 'Prova social ou resultado', max: 220 },
      { slide: 6, role: 'cta', key: 'final_cta', label: 'CTA final', max: 100 },
    ],
  },
];

function getTemplate(id) {
  return TEMPLATES.find((t) => t.id === id) || null;
}

function listTemplates() {
  return TEMPLATES.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    slide_count: t.slide_count,
    palette: t.palette,
  }));
}

function emptySlides(template) {
  const slides = {};
  for (const f of template.fields) slides[f.key] = '';
  return slides;
}

module.exports = { TEMPLATES, getTemplate, listTemplates, emptySlides };
