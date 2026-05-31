// Geracao de PDF de roteiros e carrosseis pra exportar pro Drive.
// Reaproveita pdfkit (ja e dependencia) e a paleta visual de lib/reports.js.
const PDFDocument = require('pdfkit');
const { getTemplate } = require('./templates');

const BRAND = {
  primary: '#8b6f47',
  primaryDark: '#3d2c1d',
  bg: '#faf6f0',
  accent: '#a0826d',
  text1: '#3d2c1d',
  text2: '#6b5848',
  text3: '#9a8970',
  line: '#d9c9b0',
};

function bufferFromDoc(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

function sectionTitle(doc, text) {
  doc.moveDown(0.6);
  doc.fillColor(BRAND.text3).font('Helvetica-Bold').fontSize(11)
    .text(String(text).toUpperCase(), { characterSpacing: 0.5 });
  const y = doc.y + 2;
  doc.strokeColor(BRAND.line).lineWidth(1).moveTo(40, y).lineTo(doc.page.width - 40, y).stroke();
  doc.moveDown(0.5);
}

function body(doc, text) {
  doc.fillColor(BRAND.text1).font('Helvetica').fontSize(12).text(String(text || '-'), { lineGap: 2 });
}

function header(doc, { title, subtitle }) {
  doc.save();
  doc.rect(0, 0, doc.page.width, 90).fill(BRAND.primary);
  doc.fillColor('#ffffff');
  doc.fontSize(10).font('Helvetica').text('SocialFlow', 40, 26);
  doc.fontSize(20).font('Helvetica-Bold').text(String(title || '').slice(0, 80), 40, 42, { width: doc.page.width - 80 });
  if (subtitle) {
    doc.fontSize(10).font('Helvetica').text(subtitle, 40, 70, { width: doc.page.width - 80 });
  }
  doc.restore();
  doc.y = 120;
  doc.x = 40;
}

// PDF de um roteiro (script). script = linha da tabela scripts (+ client_name).
function scriptPdf(script) {
  const doc = new PDFDocument({ size: 'A4', margin: 40, info: {
    Title: `Roteiro - ${script.title || ''}`,
    Author: 'SocialFlow',
  }});

  const subParts = [
    script.client_name,
    script.funnel_stage ? script.funnel_stage.toUpperCase() : null,
    script.format,
  ].filter(Boolean);
  header(doc, { title: script.title || 'Roteiro', subtitle: subParts.join('  ·  ') });

  if (script.hook) { sectionTitle(doc, 'Hook'); body(doc, script.hook); }
  if (script.body) { sectionTitle(doc, 'Corpo'); body(doc, script.body); }
  if (script.cta) { sectionTitle(doc, 'CTA'); body(doc, script.cta); }
  if (script.caption) { sectionTitle(doc, 'Legenda'); body(doc, script.caption); }

  const hashtags = Array.isArray(script.hashtags) ? script.hashtags : [];
  if (hashtags.length) { sectionTitle(doc, 'Hashtags'); body(doc, hashtags.join(' ')); }

  doc.fontSize(9).fillColor(BRAND.text3).font('Helvetica')
    .text(`Gerado em ${new Date().toLocaleString('pt-BR')} · SocialFlow`, 40, doc.page.height - 35, {
      align: 'center', width: doc.page.width - 80,
    });

  return bufferFromDoc(doc);
}

// PDF de um carrossel: 1 bloco por slide, na ordem do template.
// carousel = linha da tabela carousels (+ client_name). slides e um objeto key->texto.
function carouselPdf(carousel) {
  const doc = new PDFDocument({ size: 'A4', margin: 40, info: {
    Title: `Carrossel - ${carousel.title || ''}`,
    Author: 'SocialFlow',
  }});

  header(doc, { title: carousel.title || 'Carrossel', subtitle: carousel.client_name || '' });

  const template = getTemplate(carousel.template_id);
  const slides = carousel.slides && typeof carousel.slides === 'object' ? carousel.slides : {};

  if (template) {
    // Agrupa fields por numero de slide e renderiza em ordem.
    const grouped = {};
    for (const f of template.fields) {
      (grouped[f.slide] = grouped[f.slide] || []).push(f);
    }
    Object.keys(grouped).sort((a, b) => +a - +b).forEach((slideNum) => {
      sectionTitle(doc, `Slide ${slideNum}`);
      for (const f of grouped[slideNum]) {
        const val = slides[f.key];
        if (val) {
          doc.fillColor(BRAND.text3).font('Helvetica-Bold').fontSize(9).text(f.label.toUpperCase());
          body(doc, val);
          doc.moveDown(0.2);
        }
      }
    });
  } else {
    // Fallback: template desconhecido, despeja os valores na ordem das chaves.
    Object.entries(slides).forEach(([key, val], i) => {
      if (val) { sectionTitle(doc, `Slide ${i + 1}`); body(doc, val); }
    });
  }

  doc.fontSize(9).fillColor(BRAND.text3).font('Helvetica')
    .text(`Gerado em ${new Date().toLocaleString('pt-BR')} · SocialFlow`, 40, doc.page.height - 35, {
      align: 'center', width: doc.page.width - 80,
    });

  return bufferFromDoc(doc);
}

// Nome de arquivo seguro pro Drive.
function safeFilename(name, ext = 'pdf') {
  const base = String(name || 'arquivo')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9-_ ]/g, '').trim().replace(/\s+/g, '-').slice(0, 80) || 'arquivo';
  return `${base}.${ext}`;
}

module.exports = { scriptPdf, carouselPdf, safeFilename };
