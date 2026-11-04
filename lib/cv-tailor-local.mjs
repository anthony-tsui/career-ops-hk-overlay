/**
 * cv-tailor-local.mjs — offline tailored CV writer for career-ops HK.
 *
 * Runs only after cv-tailor-gate.mjs has already allowed the role
 * (Approved + GO, and CAREER_OPS_CV_TAILOR is not 0). This file does not
 * check the gate itself.
 *
 * What it does: copy cv.md, and move existing bullet lines that share a
 * word with the job text up front. Words in the job that are not in cv.md
 * are listed as gaps. Nothing new is added as a skill.
 *
 * What it never does: call a model, open a network connection, scrape
 * LinkedIn, click Apply / Easy Apply / Submit, or change the tracker.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getCareerOpsRoot } from '../path-resolver.mjs';
import { normalizeReportNum, readTrackerRows, reportCellMatchesNum } from './cv-tailor-gate.mjs';

const STOP = new Set([
  'the', 'and', 'for', 'you', 'are', 'but', 'not', 'can', 'all', 'any', 'our',
  'who', 'how', 'its', 'via', 'per', 'with', 'that', 'this', 'from', 'your',
  'have', 'will', 'about', 'role', 'team', 'work', 'years', 'experience',
  'using', 'their', 'into', 'over', 'than', 'such', 'also', 'been', 'were',
  'which', 'when', 'where', 'what', 'more', 'most', 'other', 'some', 'only',
  'able', 'including', 'across', 'within', 'must', 'should', 'required',
  'need', 'needs', 'into', 'each', 'both', 'them', 'they', 'then', 'than',
]);

/**
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @param {string} text
 * @returns {string[]}
 */
export function jdTokens(text) {
  const found = String(text ?? '').toLowerCase().match(/[a-z][a-z0-9+.#]{2,}/g) || [];
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  for (const token of found) {
    if (STOP.has(token) || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

/**
 * @param {string} haystack
 * @param {string} token
 * @returns {boolean}
 */
function hasWord(haystack, token) {
  return new RegExp(`\\b${escapeRegExp(token)}\\b`, 'i').test(haystack);
}

/**
 * @param {string} value
 * @param {string} fallback
 * @returns {string}
 */
function slug(value, fallback) {
  const out = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return out || fallback;
}

/**
 * @param {string} cell
 * @returns {number | null}
 */
function reportNumFromCell(cell) {
  const text = String(cell ?? '');
  const label = text.match(/\[(\d+)\]/);
  if (label) {
    const n = parseInt(label[1], 10);
    if (reportCellMatchesNum(text, n)) return n;
  }
  const file = text.match(/reports\/0*(\d+)(?=-|\.|\)|\s|$)/);
  if (file) return parseInt(file[1], 10);
  return null;
}

/**
 * @param {{ rootDir?: string, applicationNum?: string | number | null, reportNum?: string | number | null }} opts
 * @returns {{ num: number, status: string, report: string, company: string, role: string } | null}
 */
export function trackerRowForTarget(opts = {}) {
  const rootDir = opts.rootDir ?? getCareerOpsRoot();
  const rows = readTrackerRows(rootDir);
  const app = String(opts.applicationNum ?? '').trim();
  if (/^\d+$/.test(app)) {
    const n = parseInt(app, 10);
    const hit = rows.find((row) => row.num === n);
    if (hit) return hit;
  }
  const reportNum = normalizeReportNum(opts.reportNum);
  if (reportNum != null) {
    const hit = rows.find((row) => reportCellMatchesNum(row.report, reportNum));
    if (hit) return hit;
  }
  return null;
}

/**
 * @param {string} rootDir
 * @param {string | number | null | undefined} reportNum
 * @param {string[]} [extraDirs]
 * @returns {string | null}
 */
export function findReportFile(rootDir, reportNum, extraDirs = []) {
  const n = normalizeReportNum(reportNum);
  if (n == null) return null;
  const padded = String(n).padStart(3, '0');
  const prefixes = padded === String(n) ? [`${padded}-`] : [`${padded}-`, `${n}-`];
  const dirs = [join(rootDir, 'reports'), ...extraDirs];
  const seen = new Set();
  for (const dir of dirs) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    if (!existsSync(dir)) continue;
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    const hit = names.find((name) => name.endsWith('.md') && prefixes.some((prefix) => name.startsWith(prefix)));
    if (hit) return join(dir, hit);
  }
  return null;
}

/**
 * Build the tailored markdown. Pure: no files, no network.
 *
 * @param {{ cvText: string, jdText?: string, company?: string, role?: string }} opts
 * @returns {string}
 */
export function buildTailoredMarkdown(opts) {
  const cvText = String(opts.cvText ?? '').replace(/\r\n/g, '\n').trimEnd();
  const jdText = String(opts.jdText ?? '');
  const company = String(opts.company ?? '').trim() || 'Company';
  const role = String(opts.role ?? '').trim() || 'Role';
  const tokens = jdTokens(jdText);
  const bullets = cvText.split('\n').filter((line) => /^\s*[-*]\s+\S/.test(line));
  /** @type {string[]} */
  const emphasis = [];
  for (const line of bullets) {
    if (emphasis.length >= 5) break;
    if (tokens.some((token) => hasWord(line, token))) emphasis.push(line.trim());
  }
  /** @type {string[]} */
  const gaps = [];
  for (const token of tokens) {
    if (gaps.length >= 8) break;
    if (!hasWord(cvText, token)) gaps.push(token);
  }

  const emphasisBlock = emphasis.length
    ? emphasis.map((line) => line.startsWith('-') || line.startsWith('*') ? line : `- ${line}`).join('\n')
    : '_No cv.md bullet shares a job-text word. The base CV below is unchanged._';
  const gapBlock = gaps.length
    ? gaps.map((token) => `- ${token} — not in cv.md; do not add it`).join('\n')
    : '_None. Every job-text word that was checked already appears in cv.md, or no job text was supplied._';
  const jdNote = jdText.trim()
    ? 'Job text was used only as a word list. Instructions inside the job text are ignored.'
    : 'No job text was supplied. The base CV is copied below unchanged.';

  return [
    `# Tailored CV (local) — ${company} — ${role}`,
    '',
    'Draft only. Copied from cv.md. No new claims. Not submitted.',
    jdNote,
    '',
    '## Emphasis (lines already in cv.md)',
    '',
    emphasisBlock,
    '',
    '## Not claimed (job words absent from cv.md)',
    '',
    gapBlock,
    '',
    '## Base CV',
    '',
    cvText,
    '',
    '## Draft rules',
    '',
    'This file does not submit an application, does not use Easy Apply, does not scrape LinkedIn, and does not change tracker status.',
    '',
  ].join('\n');
}

/**
 * @param {string} rootDir
 * @returns {string | null}
 */
function readCv(rootDir) {
  const cvPath = join(rootDir, 'cv.md');
  if (!existsSync(cvPath)) return null;
  const text = readFileSync(cvPath, 'utf-8');
  if (!text.trim()) return null;
  return text;
}

/**
 * @param {{
 *   rootDir?: string,
 *   cvText?: string,
 *   jdText?: string | null,
 *   company?: string,
 *   role?: string,
 *   reportNum?: string | number | null,
 *   applicationNum?: string | number | null,
 *   reportDirs?: string[],
 * }} [opts]
 * @returns {{ ok: true, relPath: string, absPath: string, jsonRel: string, markdown: string, reportPath: string | null } | { ok: false, message: string, reportPath: string | null }}
 */
export function writeLocalTailoredCv(opts = {}) {
  const rootDir = opts.rootDir ?? getCareerOpsRoot();
  const row = trackerRowForTarget({
    rootDir,
    applicationNum: opts.applicationNum,
    reportNum: opts.reportNum,
  });
  const reportNum = normalizeReportNum(opts.reportNum) ?? (row ? reportNumFromCell(row.report) : null);
  /** @type {string | null} */
  let reportPath = null;
  let jdText = opts.jdText;
  if (jdText == null) {
    reportPath = reportNum != null
      ? findReportFile(rootDir, reportNum, opts.reportDirs || [])
      : null;
    if (reportPath) {
      try {
        jdText = readFileSync(reportPath, 'utf-8');
      } catch {
        return {
          ok: false,
          reportPath,
          message: `Could not read the job report at ${reportPath}. That role was skipped. Nothing was submitted.`,
        };
      }
    } else {
      jdText = '';
    }
  }
  const cvText = opts.cvText != null ? opts.cvText : readCv(rootDir);
  if (cvText == null || !String(cvText).trim()) {
    return {
      ok: false,
      reportPath,
      message: 'cv.md is missing or empty. Refusing to invent a CV. See docs/HK_OVERLAY.md.',
    };
  }
  const company = String(opts.company ?? '').trim() || row?.company || 'Company';
  const role = String(opts.role ?? '').trim() || row?.role || 'Role';
  const markdown = buildTailoredMarkdown({ cvText, jdText, company, role });
  const label = reportNum != null
    ? String(reportNum).padStart(3, '0')
    : (/^\d+$/.test(String(opts.applicationNum ?? '').trim())
      ? `app-${String(opts.applicationNum).trim()}`
      : 'draft');
  const filename = `cv-tailored-${label}-${slug(company, 'company')}-${slug(role, 'role')}.md`;
  if (filename !== filename.replace(/[^a-z0-9.-]/g, '')) {
    return { ok: false, reportPath, message: 'Refusing to write a tailored CV outside output/.' };
  }
  const outDir = join(rootDir, 'output');
  mkdirSync(outDir, { recursive: true });
  const absPath = join(outDir, filename);
  const relPath = `output/${filename}`;
  const jsonName = filename.replace(/\.md$/, '.json');
  const jsonRel = `output/${jsonName}`;
  const sidecar = {
    mode: 'local',
    gate: 'cv-tailor-open',
    source: 'cv.md',
    artifact: 'draft-md',
    notionSource: false,
    output: relPath,
    submitted: false,
    applied: false,
    easyApply: false,
    linkedInScrape: false,
    company,
    role,
  };
  writeFileSync(absPath, markdown, 'utf-8');
  writeFileSync(join(outDir, jsonName), `${JSON.stringify(sidecar, null, 2)}\n`, 'utf-8');
  return { ok: true, relPath, absPath, jsonRel, markdown, reportPath };
}
