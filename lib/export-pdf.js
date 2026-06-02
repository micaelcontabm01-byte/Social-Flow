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

// PDF de um carrossel. Se houver imagens por slide (carousel.slide_images:
// { slideIndex: Buffer }), renderiza 1 PAGINA por slide com a imagem de fundo
// cheia + texto branco legivel por cima. Sem imagens, cai no layout de lista.
function carouselPdf(carousel) {
  const doc = new PDFDocument({ size: 'A4', margin: 40, info: {
    Title: `Carrossel - ${carousel.title || ''}`,
    Author: 'SocialFlow',
  }});

  const template = getTemplate(carousel.template_id);
  const slides = carousel.slides && typeof carousel.slides === 'object' ? carousel.slides : {};
  const slideImages = carousel.slide_images || {};
  const hasImages = Object.keys(slideImages).length > 0;

  // Agrupa o texto por numero de slide (na ordem).
  const grouped = {};
  if (template) {
    for (const f of template.fields) (grouped[f.slide] = grouped[f.slide] || []).push(f);
  } else {
    Object.keys(slides).forEach((k, i) => { grouped[i + 1] = [{ key: k, label: '' }]; });
  }
  const slideNums = Object.keys(grouped).sort((a, b) => +a - +b);

  if (hasImages) {
    // Uma pagina por slide: imagem de fundo + overlay + texto branco centralizado.
    const W = doc.page.width, H = doc.page.height;
    slideNums.forEach((slideNum, i) => {
      if (i > 0) doc.addPage();
      const img = slideImages[Number(slideNum)];
      if (img) {
        try {
          doc.image(img, 0, 0, { cover: [W, H], width: W, height: H });
          doc.save();
          doc.rect(0, 0, W, H).fillOpacity(0.45).fill('#000000');
          doc.restore();
          doc.fillOpacity(1);
        } catch { doc.rect(0, 0, W, H).fill(BRAND.primaryDark); }
      } else {
        doc.rect(0, 0, W, H).fill(BRAND.bg);
      }
      // Texto do slide
      const isImg = !!img;
      const texts = grouped[slideNum].map((f) => slides[f.key]).filter(Boolean);
      doc.fillColor(isImg ? '#ffffff' : BRAND.text1);
      let y = H / 2 - (texts.length * 30);
      texts.forEach((t, idx) => {
        const size = idx === 0 ? 26 : 16;
        doc.font(idx === 0 ? 'Helvetica-Bold' : 'Helvetica').fontSize(size);
        doc.text(String(t), 50, y, { width: W - 100, align: 'center' });
        y = doc.y + 10;
      });
      // numero do slide
      doc.font('Helvetica').fontSize(11).fillColor(isImg ? 'rgba(255,255,255,0.8)' : BRAND.text3)
        .text(`${slideNum}/${slideNums.length}`, 0, H - 50, { width: W, align: 'center' });
    });
  } else {
    // Layout antigo (lista de texto) quando nao ha imagens.
    header(doc, { title: carousel.title || 'Carrossel', subtitle: carousel.client_name || '' });
    slideNums.forEach((slideNum) => {
      sectionTitle(doc, `Slide ${slideNum}`);
      for (const f of grouped[slideNum]) {
        const val = slides[f.key];
        if (val) {
          if (f.label) doc.fillColor(BRAND.text3).font('Helvetica-Bold').fontSize(9).text(f.label.toUpperCase());
          body(doc, val);
          doc.moveDown(0.2);
        }
      }
    });
    doc.fontSize(9).fillColor(BRAND.text3).font('Helvetica')
      .text(`Gerado em ${new Date().toLocaleString('pt-BR')} · SocialFlow`, 40, doc.page.height - 35, {
        align: 'center', width: doc.page.width - 80,
      });
  }

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
