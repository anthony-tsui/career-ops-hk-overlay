/**
 * Tailored CV HTML → one-column .docx.
 *
 * Section order is the one-column reading order (no tables):
 * header, then PROFESSIONAL SUMMARY, CORE COMPETENCIES & TECHNICAL STACK,
 * PROFESSIONAL EXPERIENCE, INDEPENDENT APPLIED-AI PROTOTYPES, EDUCATION,
 * LANGUAGES, SELECTED RECOGNITION.
 * A section the HTML does not contain is left out. Extra HTML sections are
 * appended after that list, still in one column.
 */

import { extname } from 'path';
import { classifyCvArtifact } from './cv-notion-source.mjs';

/** One-column headings, in reading order. Header is not a heading. */
export const CV_SECTION_ORDER = [
  'PROFESSIONAL SUMMARY',
  'CORE COMPETENCIES & TECHNICAL STACK',
  'PROFESSIONAL EXPERIENCE',
  'INDEPENDENT APPLIED-AI PROTOTYPES',
  'EDUCATION',
  'LANGUAGES',
  'SELECTED RECOGNITION',
];

const SECTION_RULES = [
  { heading: CV_SECTION_ORDER[0], test: (t) => /summary|profile/.test(t) && !/competenc/.test(t) },
  { heading: CV_SECTION_ORDER[1], test: (t) => /competenc|technical stack|\bskills\b/.test(t) },
  { heading: CV_SECTION_ORDER[2], test: (t) => /experience|employment|work history/.test(t) },
  { heading: CV_SECTION_ORDER[3], test: (t) => /prototype|\bprojects?\b/.test(t) },
  { heading: CV_SECTION_ORDER[4], test: (t) => /education|qualifications/.test(t) },
  { heading: CV_SECTION_ORDER[5], test: (t) => /language/.test(t) },
  { heading: CV_SECTION_ORDER[6], test: (t) => /recognition|award|honou?r/.test(t) },
];

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/**
 * @param {string} filePath
 * @param {string} text
 */
export function assertDocxHtmlInput(filePath, text) {
  const verdict = classifyCvArtifact(filePath, text);
  if (!verdict.notionSource) {
    const err = new Error(verdict.reason);
    err.code = 'CV_SOURCE';
    throw err;
  }
  const ext = extname(String(filePath || '')).toLowerCase();
  if (ext !== '.html' && ext !== '.htm') {
    throw new Error(`cv-html-to-docx reads tailored CV HTML (.html). Got ${ext || 'no extension'}.`);
  }
}

/**
 * @param {string} value
 * @returns {string}
 */
function decode(value) {
  return String(value).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (full, token) => {
    if (token[0] === '#') {
      const cp = token[1] === 'x' || token[1] === 'X'
        ? parseInt(token.slice(2), 16)
        : parseInt(token.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : full;
    }
    return ENTITIES[token.toLowerCase()] ?? full;
  });
}

/**
 * @param {string} value
 * @returns {string}
 */
function xmlText(value) {
  return String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * @param {string} html
 * @returns {string}
 */
function textOf(html) {
  return decode(String(html).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * @param {string} html
 * @param {number} openAt index of the opening <div
 * @returns {{ inner: string, end: number }}
 */
function sliceDiv(html, openAt) {
  const openEnd = html.indexOf('>', openAt);
  if (openEnd < 0) return { inner: '', end: html.length };
  let depth = 1;
  const re = /<\/?div\b[^>]*>/gi;
  re.lastIndex = openEnd + 1;
  let m;
  while ((m = re.exec(html))) {
    if (m[0].startsWith('</')) depth -= 1;
    else depth += 1;
    if (depth === 0) {
      return { inner: html.slice(openEnd + 1, m.index), end: re.lastIndex };
    }
  }
  return { inner: html.slice(openEnd + 1), end: html.length };
}

/**
 * @param {string} openTag
 * @returns {string[]}
 */
function classList(openTag) {
  const m = String(openTag).match(/class\s*=\s*["']([^"']*)["']/i);
  return m ? m[1].split(/\s+/).filter(Boolean) : [];
}

/**
 * @param {string} html
 * @param {string} className
 * @returns {Array<{ inner: string, index: number }>}
 */
function findClassDivs(html, className) {
  const out = [];
  const re = /<div\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    if (!classList(m[0]).includes(className)) continue;
    const sliced = sliceDiv(html, m.index);
    out.push({ inner: sliced.inner, index: m.index });
    re.lastIndex = sliced.end;
  }
  return out;
}

/**
 * @param {string[]} lines
 * @returns {string[]}
 */
function joinPipeLines(lines) {
  /** @type {string[]} */
  const out = [];
  for (const line of lines) {
    if (line.startsWith('|') && out.length) {
      out[out.length - 1] = `${out[out.length - 1]} ${line}`.replace(/\s+/g, ' ').trim();
    } else {
      out.push(line);
    }
  }
  return out;
}

/**
 * @param {string} inner section inner HTML, title div already removed
 * @returns {string[]}
 */
function paragraphsFromSection(inner) {
  const tags = [...inner.matchAll(/<span\b[^>]*class="[^"]*\bcompetency-tag\b[^"]*"[^>]*>([\s\S]*?)<\/span>/gi)]
    .map((m) => textOf(m[1]))
    .filter(Boolean);
  const skills = [...inner.matchAll(/<div\b[^>]*class="[^"]*\bskill-item\b[^"]*"[^>]*>([\s\S]*?)<\/div>/gi)]
    .map((m) => textOf(m[1]))
    .filter(Boolean);
  let rest = inner
    .replace(/<div\b[^>]*class="[^"]*\bskill-item\b[^"]*"[^>]*>[\s\S]*?<\/div>/gi, '')
    .replace(/<span\b[^>]*class="[^"]*\bcompetency-tag\b[^"]*"[^>]*>[\s\S]*?<\/span>/gi, '');
  rest = rest
    .replace(/<(?:span|div)\b[^>]*class="[^"]*\b(?:job-period|edu-year)\b[^"]*"[^>]*>/gi, ' | ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    .replace(/<\/(?:p|li|h1|h2|h3|div|tr)>/gi, '\n');
  const blocks = joinPipeLines(
    decode(rest.replace(/<[^>]+>/g, ' '))
      .split('\n')
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter(Boolean),
  );
  /** @type {string[]} */
  const lines = [];
  if (tags.length && skills.length === 0) lines.push(tags.join(', '));
  lines.push(...skills, ...blocks);
  return lines;
}

/**
 * @param {string} title
 * @returns {string | null}
 */
function sectionHeadingFor(title) {
  const key = String(title || '').toLowerCase();
  for (const rule of SECTION_RULES) {
    if (rule.test(key)) return rule.heading;
  }
  return null;
}

/**
 * @param {string} html
 * @returns {{ name: string, contact: string, sections: Array<{ heading: string, paragraphs: string[] }> }}
 */
export function extractCvDocument(html) {
  const src = String(html)
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  const nameMatch = src.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  const name = nameMatch ? textOf(nameMatch[1]) : '';
  const contactDiv = findClassDivs(src, 'contact-row')[0];
  let contact = '';
  if (contactDiv) {
    const parts = [];
    const re = /<(a|span)\b[^>]*>([\s\S]*?)<\/\1>/gi;
    let m;
    while ((m = re.exec(contactDiv.inner))) {
      const bit = textOf(m[2]);
      if (bit) parts.push(bit);
    }
    contact = parts.join(' | ') || textOf(contactDiv.inner);
  }

  /** @type {Map<string, string[]>} */
  const grouped = new Map();
  /** @type {Array<{ heading: string, paragraphs: string[] }>} */
  const extras = [];
  for (const section of findClassDivs(src, 'section')) {
    const titleDiv = section.inner.match(/<div\b[^>]*class="[^"]*\bsection-title\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    const title = titleDiv ? textOf(titleDiv[1]) : '';
    const body = titleDiv ? section.inner.replace(titleDiv[0], '') : section.inner;
    const paragraphs = paragraphsFromSection(body);
    if (!title || paragraphs.length === 0) continue;
    const mapped = sectionHeadingFor(title);
    if (mapped) {
      const prev = grouped.get(mapped) || [];
      grouped.set(mapped, prev.concat(paragraphs));
    } else {
      extras.push({ heading: title.toUpperCase(), paragraphs });
    }
  }

  const sections = CV_SECTION_ORDER
    .filter((heading) => grouped.has(heading))
    .map((heading) => ({ heading, paragraphs: grouped.get(heading) || [] }));
  return { name, contact, sections: sections.concat(extras) };
}

/**
 * Headings present in the document, in reading order, then any extras.
 * @param {{ sections: Array<{ heading: string }> }} doc
 * @returns {string[]}
 */
export function sectionHeadings(doc) {
  return doc.sections.map((section) => section.heading);
}

/**
 * @param {{ bold?: boolean, underline?: boolean, size?: number }} [run]
 * @param {string} text
 * @returns {string}
 */
function paragraphXml(text, run = {}) {
  const size = run.size || 22;
  const bold = run.bold ? '<w:b/><w:bCs/>' : '';
  const underline = run.underline ? '<w:u w:val="single"/>' : '';
  return `<w:p><w:pPr><w:spacing w:after="60" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/>${bold}${underline}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr><w:t xml:space="preserve">${xmlText(text)}</w:t></w:r></w:p>`;
}

/**
 * @param {{ name: string, contact: string, sections: Array<{ heading: string, paragraphs: string[] }> }} doc
 * @returns {string}
 */
export function documentXml(doc) {
  const parts = [];
  if (doc.name) parts.push(paragraphXml(doc.name, { bold: true, size: 28 }));
  if (doc.contact) parts.push(paragraphXml(doc.contact, { size: 20 }));
  for (const section of doc.sections) {
    parts.push(paragraphXml(section.heading, { bold: true, underline: true, size: 20 }));
    for (const line of section.paragraphs) parts.push(paragraphXml(line, { size: 20 }));
  }
  // A4, 0.5in margins, one column. No tables, drawings, or theme colours.
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
${parts.join('\n')}
<w:sectPr>
<w:pgSz w:w="11906" w:h="16838"/>
<w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720" w:header="720" w:footer="720" w:gutter="0"/>
<w:cols w:space="720"/>
</w:sectPr>
</w:body>
</w:document>`;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * @param {Buffer} buf
 * @returns {number}
 */
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * @param {Array<{ name: string, data: Buffer }>} files
 * @returns {Buffer}
 */
function zipStore(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const crc = crc32(file.data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(file.data.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    locals.push(local, file.data);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(file.data.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length + file.data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

/**
 * @param {string} html
 * @returns {Buffer}
 */
export function htmlToDocxBuffer(html) {
  const xml = documentXml(extractCvDocument(html));
  const files = [
    {
      name: '[Content_Types].xml',
      data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`, 'utf8'),
    },
    {
      name: '_rels/.rels',
      data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`, 'utf8'),
    },
    { name: 'word/document.xml', data: Buffer.from(xml, 'utf8') },
    {
      name: 'word/_rels/document.xml.rels',
      data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`, 'utf8'),
    },
  ];
  return zipStore(files);
}

/**
 * Read headings out of a docx buffer this module wrote.
 * @param {Buffer} buf
 * @returns {string[]}
 */
export function docxHeadings(buf) {
  const xml = unzipEntry(buf, 'word/document.xml').toString('utf8');
  const headings = [];
  const re = /<w:t[^>]*>([^<]*)<\/w:t>/g;
  let m;
  while ((m = re.exec(xml))) {
    const text = m[1]
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');
    if (CV_SECTION_ORDER.includes(text) || /^(CERTIFICATIONS|INTERESTS|SKILLS)$/.test(text)) {
      headings.push(text);
    }
  }
  return headings;
}

/**
 * @param {Buffer} buf
 * @param {string} name
 * @returns {Buffer}
 */
export function unzipEntry(buf, name) {
  let offset = 0;
  while (offset + 30 <= buf.length) {
    const sig = buf.readUInt32LE(offset);
    if (sig !== 0x04034b50) break;
    const nameLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const compSize = buf.readUInt32LE(offset + 18);
    const fileName = buf.slice(offset + 30, offset + 30 + nameLen).toString('utf8');
    const dataStart = offset + 30 + nameLen + extraLen;
    const data = buf.slice(dataStart, dataStart + compSize);
    if (fileName === name) return data;
    offset = dataStart + compSize;
  }
  throw new Error(`docx is missing ${name}`);
}

/**
 * Minimal HTML with the one-column section set, for --selftest.
 * @returns {string}
 */
export function selftestHtml() {
  return `<!DOCTYPE html><html><head><title>CV</title></head><body><div class="page">
<div class="header"><h1>Ada Example</h1>
<div class="contact-row"><span>Hong Kong</span><a href="mailto:ada@example.com">ada@example.com</a></div>
</div>
<div class="section"><div class="section-title">Professional Summary</div><div class="summary-text">Data leader with 10 years of real work.</div></div>
<div class="section"><div class="section-title">Core Competencies</div><div class="competencies-grid"><span class="competency-tag">SQL</span></div></div>
<div class="section"><div class="section-title">Skills</div>
<div class="skill-item"><span class="skill-category">Leadership &amp; Commercial: </span>team leadership</div>
<div class="skill-item"><span class="skill-category">Measurement &amp; Modelling: </span>MMM</div>
<div class="skill-item"><span class="skill-category">Programming &amp; Applied AI: </span>Python, SQL</div>
<div class="skill-item"><span class="skill-category">Data &amp; BI: </span>BigQuery</div>
<div class="skill-item"><span class="skill-category">MarTech &amp; AdTech: </span>GA4</div>
</div>
<div class="section"><div class="section-title">Work Experience</div>
<div class="job"><div class="job-header"><span class="job-company">Example Co</span><span class="job-period">2020 – 2024</span></div>
<div class="job-role">Director</div><ul><li>Led a team of 4.</li></ul></div></div>
<div class="section"><div class="section-title">Projects</div><div class="project"><div class="project-title">Tracking assistant</div><div class="project-desc">A small prototype.</div></div></div>
<div class="section"><div class="section-title">Education</div><div class="edu-item"><div class="edu-header"><div class="edu-title">MSc</div><div class="edu-year">2024</div></div></div></div>
<div class="section"><div class="section-title">Languages</div><div class="interests-line">Language A — Native | Language B — Fluent</div></div>
<div class="section"><div class="section-title">Awards &amp; Honors</div><div class="award">Agency award, 2023</div></div>
</div></body></html>`;
}

/**
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function runDocxSelftest() {
  const errors = [];
  const html = selftestHtml();
  const doc = extractCvDocument(html);
  const headings = sectionHeadings(doc);
  if (headings.join('|') !== CV_SECTION_ORDER.join('|')) {
    errors.push(`headings ${headings.join(' | ')}`);
  }
  const buf = htmlToDocxBuffer(html);
  const xml = unzipEntry(buf, 'word/document.xml').toString('utf8');
  if (xml.includes('<w:tbl')) errors.push('docx contains a table');
  if (xml.includes('<w:drawing') || xml.includes('<w:pict')) errors.push('docx contains a drawing');
  if (/<w:color\b/i.test(xml)) errors.push('docx sets a text colour');
  if (!xml.includes('<w:cols w:space="720"/>')) errors.push('docx is not a single column');
  if (xml.includes('w:num=')) errors.push('docx sets a column count');
  const readBack = docxHeadings(buf);
  if (readBack.join('|') !== CV_SECTION_ORDER.join('|')) errors.push(`docx headings ${readBack.join(' | ')}`);
  try {
    assertDocxHtmlInput('output/cv-tailored-001-example.md', '# Tailored CV (local) — Example — Role\n\nDraft only. Copied from cv.md. No new claims.\n');
    errors.push('local draft was accepted');
  } catch (err) {
    if (!(err instanceof Error) || !/draft markdown only/i.test(err.message)) errors.push(`local draft refusal: ${err}`);
  }
  return { ok: errors.length === 0, errors };
}
