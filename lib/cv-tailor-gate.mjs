/**
 * cv-tailor-gate.mjs — HK Slice F: hard-gate full CV rewrite / auto-tailor.
 *
 * Default is off. A full rewrite (openai-tailor, batch-tailor, pdf/text/latex
 * modes, prepare --tailor, or:apply --tailor) runs only when BOTH are true:
 *   1. The tracker row for that role is Approved (explicit GO for the role).
 *   2. This invocation passes a documented GO flag: --go, CAREER_OPS_CV_TAILOR=1,
 *      or --force with a non-empty --note (audit).
 *
 * CAREER_OPS_CV_TAILOR=0|false|off hard-disables rewrite even if those are set.
 * When the env is unset or 1, Approved + GO may tailor.
 * This module does not generate a CV. lib/cv-tailor-local.mjs does, and only
 * after this gate returns ok. A 3–5 bullet note is an optional human delta,
 * not a substitute for that file. See docs/HK_OVERLAY.md.
 */

import { readFileSync, existsSync } from 'fs';
import { getCareerOpsRoot, resolveTrackerPath } from '../path-resolver.mjs';
import { resolveColumns, parseTrackerRow } from '../tracker-parse.mjs';
import { trackerStatusForApplication } from './apply-gate.mjs';

export const CV_TAILOR_GATED = 'cv-tailor-gated';
export const CV_TAILOR_DISABLED = 'cv-tailor-disabled';

/** Optional human note. Not a substitute for the local tailored CV. */
export const HUMAN_DELTA_SOP = [
  'Optional human delta (not a substitute for the tailored CV):',
  '- When this gate is open, the local tailor writes a CV from cv.md (no new claims).',
  '- You may also add a 3–5 bullet note, and nothing else:',
  '  1. Lead with 1–2 proof points already in the base CV.',
  '  2. JD words that match real experience (no new claims).',
  '  3. What to leave off this time.',
  '  4. One line on why this role.',
  '  5. One honest gap, or omit this bullet if there is none.',
  '- Do not auto-submit, Easy Apply, scrape LinkedIn, or mark Applied.',
].join('\n');

/** @returns {boolean | undefined} undefined = no env override */
export function parseCvTailorEnv() {
  const raw = process.env.CAREER_OPS_CV_TAILOR?.trim();
  if (!raw) return undefined;
  const v = raw.toLowerCase();
  if (['0', 'false', 'off', 'no', 'disabled'].includes(v)) return false;
  if (['1', 'true', 'on', 'yes', 'go', 'enabled'].includes(v)) return true;
  return undefined;
}

/** @returns {boolean} */
export function isCvTailorHardOff() {
  return parseCvTailorEnv() === false;
}

/**
 * @param {string} cell
 * @param {number} n
 * @returns {boolean}
 */
export function reportCellMatchesNum(cell, n) {
  const text = String(cell ?? '');
  const label = text.match(/\[(\d+)\]/);
  if (label && parseInt(label[1], 10) === n) return true;
  const file = text.match(/reports\/0*(\d+)(?=-|\.|\)|\s|$)/);
  if (file && parseInt(file[1], 10) === n) return true;
  return false;
}

/**
 * @param {string | number} value
 * @returns {number | null}
 */
export function normalizeReportNum(value) {
  const s = String(value ?? '').trim();
  if (!/^\d+$/.test(s)) return null;
  const n = parseInt(s, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * @param {string} [rootDir]
 * @returns {{ num: number, status: string, report: string, company: string, role: string }[]}
 */
export function readTrackerRows(rootDir = getCareerOpsRoot()) {
  const trackerPath = resolveTrackerPath(rootDir);
  if (!existsSync(trackerPath)) return [];
  const lines = readFileSync(trackerPath, 'utf-8').split('\n');
  const colmap = resolveColumns(lines);
  if (!colmap) return [];
  /** @type {{ num: number, status: string, report: string, company: string, role: string }[]} */
  const rows = [];
  for (const line of lines) {
    const row = parseTrackerRow(line, colmap);
    if (!row) continue;
    rows.push({
      num: row.num,
      status: String(row.status ?? '').trim(),
      report: String(row.report ?? ''),
      company: String(row.company ?? '').trim(),
      role: String(row.role ?? '').trim(),
    });
  }
  return rows;
}

/**
 * @param {string | number} reportNum
 * @param {string} [rootDir]
 * @returns {string | null}
 */
export function trackerStatusForReport(reportNum, rootDir = getCareerOpsRoot()) {
  const n = normalizeReportNum(reportNum);
  if (n == null) return null;
  for (const row of readTrackerRows(rootDir)) {
    if (reportCellMatchesNum(row.report, n)) return row.status || null;
  }
  return null;
}

/**
 * @param {{
 *   applicationNum?: string,
 *   reportNums?: Array<string | number>,
 *   go?: boolean,
 *   force?: boolean,
 *   note?: string | null,
 *   rootDir?: string,
 * }} [opts]
 * @returns {{ ok: true, code: string, message: string } | { ok: false, code: string, message: string }}
 */
export function assertCvRewriteAllowed(opts = {}) {
  const rootDir = opts.rootDir ?? getCareerOpsRoot();
  if (isCvTailorHardOff()) {
    return {
      ok: false,
      code: CV_TAILOR_DISABLED,
      message:
        `[${CV_TAILOR_DISABLED}] CAREER_OPS_CV_TAILOR=0 hard-disables full CV rewrite, including --go. `
        + 'Use the base CV. See docs/HK_OVERLAY.md.',
    };
  }

  const envGo = parseCvTailorEnv() === true;
  const go = opts.go === true || envGo;
  const force = opts.force === true;
  if (!go && !force) {
    return {
      ok: false,
      code: CV_TAILOR_GATED,
      message:
        `[${CV_TAILOR_GATED}] Full CV rewrite is off. `
        + 'Pass --go (or CAREER_OPS_CV_TAILOR=1) only when the tracker row is Approved, '
        + 'or --force with --note for an audited bypass. While this gate is closed, send the base CV. '
        + 'A 3–5 bullet note is an optional human delta, not a tailored CV. '
        + 'See docs/HK_OVERLAY.md.',
    };
  }

  const audit = opts.note != null ? String(opts.note).trim() : '';
  if (force && !go && !audit) {
    return {
      ok: false,
      code: CV_TAILOR_GATED,
      message:
        `[${CV_TAILOR_GATED}] --force requires --note (audit trail). `
        + 'Approved + --go is the normal unlock. Full CV rewrite stays off without it.',
    };
  }

  /** @type {{ label: string, status: string | null }[]} */
  const targets = [];
  const app = opts.applicationNum != null ? String(opts.applicationNum).trim() : '';
  if (app) {
    targets.push({
      label: `tracker #${app}`,
      status: trackerStatusForApplication(app, rootDir),
    });
  }
  const reports = Array.isArray(opts.reportNums) ? opts.reportNums : [];
  const seen = new Set();
  for (const raw of reports) {
    const n = normalizeReportNum(raw);
    if (n == null || seen.has(n)) continue;
    seen.add(n);
    targets.push({
      label: `report ${String(n).padStart(3, '0')}`,
      status: trackerStatusForReport(n, rootDir),
    });
  }

  if (targets.length === 0) {
    return {
      ok: false,
      code: CV_TAILOR_GATED,
      message:
        `[${CV_TAILOR_GATED}] Full CV rewrite needs the role id (--application <tracker #> `
        + 'or a report number) so Approved can be checked. Refusing to rewrite without one.',
    };
  }

  for (const target of targets) {
    if (target.status !== 'Approved') {
      const shown = target.status ? `"${target.status}"` : 'missing';
      return {
        ok: false,
        code: CV_TAILOR_GATED,
        message:
          `[${CV_TAILOR_GATED}] Full CV rewrite blocked: ${target.label} is ${shown}, not Approved. `
          + 'Explicit GO is Approved plus --go, CAREER_OPS_CV_TAILOR=1, or --force with --note. '
          + 'While blocked, send the base CV. A 3–5 bullet note is optional (docs/HK_OVERLAY.md).',
      };
    }
  }

  const who = targets.map((t) => t.label).join(', ');
  return {
    ok: true,
    code: 'cv-tailor-open',
    message:
      `[cv-tailor-open] Rewrite gate open for ${who}. `
      + 'A local tailored CV may be written from cv.md (no new claims). '
      + 'The 3–5 bullet note is an optional human delta, not the only kit. '
      + 'Do not submit, Easy Apply, scrape LinkedIn, or mark Applied.',
  };
}
