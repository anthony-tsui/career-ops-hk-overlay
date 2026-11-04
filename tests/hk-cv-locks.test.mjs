/**
 * HK CV locks: PDF extension fence, draft-markdown refusal, B&W print CSS,
 * page-budget default, and the one-column docx section order.
 * No network. No Notion. No tracker writes.
 */

import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pass, fail, results, ROOT, NODE } from './helpers.mjs';
import { assertPdfExtension, planFilesPack } from '../plugins/notion/files-pack.mjs';
import { applyPrintCss, CV_GRAYSCALE_STYLE_ID, cvSourceRefusal, enforcePageBudget } from '../generate-pdf.mjs';
import {
  CV_SECTION_ORDER,
  assertDocxHtmlInput,
  docxHeadings,
  extractCvDocument,
  htmlToDocxBuffer,
  runDocxSelftest,
  selftestHtml,
  unzipEntry,
} from '../lib/cv-html-docx.mjs';

const HUNT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function offlineEnv() {
  const env = { ...process.env, NOTION_ACCESS_TOKEN: '' };
  delete env.NOTION_ACCESS_TOKEN;
  return env;
}

try {
  assertPdfExtension('cv/tailored.PDF');
  pass('accepts a .PDF path in any letter case');
} catch (err) {
  fail(`uppercase pdf rejected: ${err.message}`);
}

for (const path of ['cv/tailored.docx', 'cv/tailored.DOCX', 'cv/draft.md', 'cv/draft.MD', 'cv/noext']) {
  try {
    assertPdfExtension(path);
    fail(`accepted non-pdf ${path}`);
  } catch (err) {
    if (/must be a \.pdf file/i.test(err.message)) pass(`refuses --pdf ${path}`);
    else fail(`unexpected refusal for ${path}: ${err.message}`);
  }
}

const dir = mkdtempSync(join(tmpdir(), 'hk-cv-locks-'));
try {
  const report = join(dir, 'report.md');
  const jd = join(dir, 'jd.md');
  writeFileSync(report, '# Report\n\n**Score:** 4.0/5\n');
  writeFileSync(jd, '# JD\n');
  const docx = join(dir, 'tailored.docx');
  writeFileSync(docx, 'PK');
  try {
    planFilesPack({ huntPageId: HUNT, report, jd, pdfs: [docx] });
    fail('planFilesPack accepted a docx');
  } catch (err) {
    if (/must be a \.pdf file/i.test(err.message)) pass('planFilesPack refuses a .docx --pdf');
    else fail(`plan error: ${err.message}`);
  }

  let cliRefused = false;
  let cliOut = '';
  try {
    cliOut = execFileSync(NODE, [
      join(ROOT, 'plugins.mjs'), 'run', 'notion', 'files-pack',
      '--dry-run', '--hunt-page-id', HUNT, '--report', report, '--jd', jd, '--pdf', docx,
    ], { cwd: ROOT, env: offlineEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    cliRefused = true;
    cliOut = `${err.stdout || ''}\n${err.stderr || ''}`;
  }
  if (cliRefused && /must be a \.pdf file/i.test(cliOut) && !/api\.notion\.com/.test(cliOut)) {
    pass('files-pack CLI refuses a .docx and does not call Notion');
  } else fail(`files-pack CLI fence: refused=${cliRefused} ${cliOut.slice(0, 400)}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const localDraft = '# Tailored CV (local) — Example — Role\n\nDraft only. Copied from cv.md. No new claims.\n';
const draftRefusal = cvSourceRefusal('output/cv-tailored-001-example.md', localDraft);
if (draftRefusal && /draft markdown only/i.test(draftRefusal)) pass('generate-pdf refuses --local markdown');
else fail(`draft refusal missing: ${draftRefusal}`);

const mdRefusal = cvSourceRefusal('notes.md', '<html><body>not a draft</body></html>');
if (mdRefusal && /Refusing markdown/i.test(mdRefusal)) pass('generate-pdf refuses a .md path');
else fail(`md refusal missing: ${mdRefusal}`);

if (cvSourceRefusal('cv.html', '<html><body><h1>Ada</h1></body></html>') === null) {
  pass('HTML from the CV builder is still a render source');
} else fail('html was refused');

const sample = '<html><head></head><body><div class="header-gradient"></div></body></html>';
const cvCss = applyPrintCss(sample, { kind: 'cv', format: 'a4' });
const coverCss = applyPrintCss(sample, { kind: 'cover', format: 'a4' });
if (cvCss.includes(CV_GRAYSCALE_STYLE_ID) && /grayscale\(1\)/.test(cvCss) && cvCss.includes('career-ops-page-setup')) {
  pass('kind=cv injects black-and-white print CSS');
} else fail('cv grayscale CSS missing');
if (!coverCss.includes(CV_GRAYSCALE_STYLE_ID) && coverCss.includes('career-ops-page-setup')) {
  pass('kind=cover keeps page setup and skips grayscale');
} else fail('cover letter received CV grayscale CSS');

let warned = '';
const origWarn = console.warn;
console.warn = (msg) => { warned += String(msg); };
let strictThrew = false;
try {
  enforcePageBudget(3);
  try {
    enforcePageBudget(3, { strictPages: true });
  } catch {
    strictThrew = true;
  }
} finally {
  console.warn = origWarn;
}
if (/warning-only/.test(warned) && strictThrew) {
  pass('max-pages default stays 2 and --strict-pages stays off');
} else fail(`page budget default drifted: warned=${warned} strictThrew=${strictThrew}`);

const doc = extractCvDocument(selftestHtml());
if (doc.sections.map((s) => s.heading).join('|') === CV_SECTION_ORDER.join('|')) {
  pass('template titles map onto the one-column section order');
} else fail(`mapped headings: ${doc.sections.map((s) => s.heading).join(' | ')}`);

const skills = doc.sections.find((s) => s.heading.startsWith('CORE COMPETENCIES'));
if (skills && skills.paragraphs.some((line) => line.includes('Leadership & Commercial')) && skills.paragraphs.length >= 5) {
  pass('skills stay labelled lines under core competencies');
} else fail(`skills lines: ${JSON.stringify(skills && skills.paragraphs)}`);

const shuffled = `<html><body>
<h1>Ada Example</h1>
<div class="contact-row"><span>Hong Kong</span></div>
<div class="section"><div class="section-title">Education</div><div class="edu-title">BSc</div></div>
<div class="section"><div class="section-title">PROFESSIONAL SUMMARY</div><div class="summary-text">One paragraph.</div></div>
<div class="section"><div class="section-title">Professional Experience</div><div class="job-role">Director</div></div>
</body></html>`;
const shuffledDoc = extractCvDocument(shuffled);
const shuffledHeads = shuffledDoc.sections.map((s) => s.heading);
if (shuffledHeads[0] === 'PROFESSIONAL SUMMARY' && shuffledHeads[1] === 'PROFESSIONAL EXPERIENCE' && shuffledHeads[2] === 'EDUCATION') {
  pass('one-column section order wins over the HTML order');
} else fail(`shuffled order: ${shuffledHeads.join(' | ')}`);

const buf = htmlToDocxBuffer(selftestHtml());
const xml = unzipEntry(buf, 'word/document.xml').toString('utf8');
if (!xml.includes('<w:tbl') && !xml.includes('<w:drawing') && xml.includes('<w:cols w:space="720"/>') && !/w:num=/.test(xml)) {
  pass('docx is one column with no table and no drawing');
} else fail('docx shape drifted');
if (docxHeadings(buf).join('|') === CV_SECTION_ORDER.join('|')) {
  pass('docx smoke matches the one-column section list');
} else fail(`docx headings: ${docxHeadings(buf).join(' | ')}`);

try {
  assertDocxHtmlInput('output/cv-tailored.md', localDraft);
  fail('docx CLI source check accepted a local draft');
} catch (err) {
  if (/draft markdown only/i.test(err.message)) pass('docx refuses --local markdown');
  else fail(`docx refusal: ${err.message}`);
}

const self = runDocxSelftest();
if (self.ok) pass('docx library selftest is offline and matches the section list');
else fail(`selftest: ${self.errors.join('; ')}`);

try {
  const out = execFileSync(NODE, [join(ROOT, 'cv-html-to-docx.mjs'), '--selftest'], {
    cwd: ROOT,
    env: offlineEnv(),
    encoding: 'utf8',
  });
  if (out.includes('cv-html-to-docx selftest: ok') && out.includes('liveNotion: false') && out.includes('columns: 1')) {
    pass('docx CLI selftest stays offline');
  } else fail(`docx CLI selftest output: ${out}`);
} catch (err) {
  fail(`docx CLI selftest: ${err.stdout || ''} ${err.stderr || err.message}`);
}

if (results().failed > 0) process.exitCode = 1;
