/**
 * lib/board-eval.mjs — HK board-eval on top of a career-ops score.
 *
 * career-ops (modes/_shared.md, modes/oferta.md, batch/batch-prompt.md) is the
 * only source of the five dimension scores and the global score. This module
 * copies those numbers. It does not average them, fill a missing one, or
 * accept a manual override.
 *
 * The HK overlay (hk-eval-gate) may change the tracker status and notes.
 * A level-fit line is a note. Neither one changes a dimension or the global.
 *
 * No network. No apply, fill, or Submit.
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { suggestEvalStatus } from '../hk-eval-gate.mjs';
import { withJdArchiveSection } from './jd-archive-section.mjs';
import { isPostingUrl, normalizedTrackerScore, slugifyCompany, tsvSafe } from './tracker-addition.mjs';
import { loadYaml } from './yaml-document.mjs';

/** Score-table labels from batch/batch-prompt.md. Keys come from that file at runtime. */
export const CAREER_OPS_DIM_LABELS = {
  cv_match: 'CV match',
  north_star: 'North Star alignment',
  compensation: 'Compensation',
  culture: 'Culture / working model',
  red_flags: 'Red flags',
};

const OVERRIDE_FIELDS = ['overrideScore', 'override_score', 'manualScore', 'manual_score'];
const EVIDENCE_STATES = new Set(['supported', 'partial', 'unknown']);
const ALLOWED_STATUS = new Set(['Evaluated', 'Review']);

export const NOTION_PUSH_DRY_RUN = 'node hunt-notion-sync.mjs push --dry-run';

/**
 * Dimension keys from every `score_evidence` block in the career-ops batch prompt.
 * A new key fails closed until CAREER_OPS_DIM_LABELS names its existing table row.
 *
 * @param {string} batchPrompt
 * @returns {string[]}
 */
export function parseScoreEvidenceKeys(batchPrompt) {
  const blocks = [];
  const re = /^score_evidence:\n((?:  \w+:[^\n]*\n)+)/gm;
  for (const match of String(batchPrompt ?? '').matchAll(re)) {
    blocks.push([...match[1].matchAll(/^  (\w+):/gm)].map((m) => m[1]));
  }
  if (blocks.length < 1) {
    throw Object.assign(new Error('batch/batch-prompt.md has no score_evidence block'), { code: 'career-ops-score-contract' });
  }
  const first = blocks[0].join(',');
  for (const block of blocks) {
    if (block.join(',') !== first) {
      throw Object.assign(
        new Error('score_evidence keys disagree inside batch/batch-prompt.md'),
        { code: 'career-ops-score-contract' },
      );
    }
  }
  if (blocks[0].length !== 5) {
    throw Object.assign(
      new Error(`career-ops score_evidence must list five dimensions, found ${blocks[0].length}`),
      { code: 'career-ops-score-contract' },
    );
  }
  return blocks[0];
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {number}
 */
export function requireUnitScore(value, name) {
  const text = String(value ?? '').trim();
  const match = text.match(/^(\d+(?:\.\d+)?)(?:\s*\/\s*5)?$/);
  if (!match) {
    throw Object.assign(new Error(`${name} is not a career-ops 0-5 score`), { code: 'career-ops-score-contract' });
  }
  const n = Math.round(Number(match[1]) * 10) / 10;
  if (!Number.isFinite(n) || n < 0 || n > 5) {
    throw Object.assign(new Error(`${name} is outside 0-5`), { code: 'career-ops-score-contract' });
  }
  return n;
}

/**
 * @param {number} n
 * @returns {string}
 */
export function formatScoreCell(n) {
  const cell = `${n.toFixed(1)}/5`;
  if (normalizedTrackerScore(cell) === 'N/A') {
    throw Object.assign(new Error(`score cell refused: ${cell}`), { code: 'career-ops-score-contract' });
  }
  return cell;
}

/**
 * Copy the career-ops global and the five dimensions. Extra keys are ignored.
 * A manual override field is an error, not a second score.
 *
 * @param {object} evaluation
 * @param {string[]} dimensionKeys
 */
export function takeCareerOpsScore(evaluation, dimensionKeys) {
  if (!evaluation || typeof evaluation !== 'object' || Array.isArray(evaluation)) {
    throw Object.assign(new Error('career-ops evaluation is missing'), { code: 'career-ops-score-contract' });
  }
  for (const field of OVERRIDE_FIELDS) {
    if (evaluation[field] != null && evaluation[field] !== '') {
      throw Object.assign(
        new Error(`refusing ${field}; career-ops score is the source of truth`),
        { code: 'career-ops-score-contract' },
      );
    }
  }
  const rawDims = evaluation.dimensions;
  if (!rawDims || typeof rawDims !== 'object' || Array.isArray(rawDims)) {
    throw Object.assign(new Error('career-ops evaluation is missing dimensions'), { code: 'career-ops-score-contract' });
  }
  /** @type {Record<string, number>} */
  const dimensions = {};
  for (const key of dimensionKeys) {
    if (!Object.prototype.hasOwnProperty.call(rawDims, key)) {
      throw Object.assign(
        new Error(`career-ops evaluation is missing dimension ${key}; refusing to fill it`),
        { code: 'career-ops-score-contract' },
      );
    }
    dimensions[key] = requireUnitScore(rawDims[key], key);
  }
  const score = requireUnitScore(evaluation.score, 'global');
  let scoreEvidence = null;
  if (evaluation.score_evidence != null) {
    scoreEvidence = {};
    for (const key of dimensionKeys) {
      const state = evaluation.score_evidence[key];
      if (!EVIDENCE_STATES.has(state)) {
        throw Object.assign(
          new Error(`score_evidence.${key} must be supported, partial, or unknown`),
          { code: 'career-ops-score-contract' },
        );
      }
      scoreEvidence[key] = state;
    }
  }
  const legitimacy = typeof evaluation.legitimacy_tier === 'string' && evaluation.legitimacy_tier.trim()
    ? evaluation.legitimacy_tier.trim()
    : 'unconfirmed';
  return { score, scoreCell: formatScoreCell(score), dimensions, scoreEvidence, legitimacy };
}

/**
 * @param {{ score: number, dimensions: Record<string, number> }} taken
 * @param {string[]} dimensionKeys
 * @returns {string}
 */
export function formatDimsNote(taken, dimensionKeys) {
  const parts = dimensionKeys.map((key) => `${key}=${taken.dimensions[key].toFixed(1)}`);
  parts.push(`global=${taken.score.toFixed(1)}`);
  return `career-ops-dims:${parts.join(',')}`;
}

/**
 * @param {{ dimsNote: string, hkNotes?: string, levelFit?: string }} parts
 * @returns {string}
 */
export function composeBoardNotes({ dimsNote, hkNotes, levelFit }) {
  const notes = [dimsNote];
  if (hkNotes && hkNotes.trim()) notes.push(hkNotes.trim());
  const fit = String(levelFit ?? '').replace(/[\t\r\n;]+/g, ' ').trim();
  if (fit) notes.push(`level-fit:${fit}`);
  return notes.join('; ');
}

/**
 * Read numeric dimension rows and the global from a career-ops report.
 * Machine Summary `score` and the Global table row must agree when both exist.
 *
 * @param {string} markdown
 * @param {string[]} dimensionKeys
 * @param {Record<string, string>} labels
 */
export function evaluationFromReport(markdown, dimensionKeys, labels) {
  const text = String(markdown ?? '');
  /** @type {Record<string, number>} */
  const dimensions = {};
  for (const key of dimensionKeys) {
    const label = String(labels[key] ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!label) {
      throw Object.assign(new Error(`no score-table label for ${key}`), { code: 'career-ops-score-contract' });
    }
    const row = text.match(new RegExp(`^\\|\\s*${label}\\s*\\|\\s*\\**\\s*(\\d+(?:\\.\\d+)?)\\s*/\\s*5`, 'im'));
    if (!row) {
      throw Object.assign(
        new Error(`career-ops report is missing the ${labels[key]} score; refusing to fill it`),
        { code: 'career-ops-score-contract' },
      );
    }
    dimensions[key] = requireUnitScore(row[1], key);
  }
  const tableGlobal = text.match(/^\|\s*\**\s*Global\s*\**\s*\|\s*\**\s*(\d+(?:\.\d+)?)\s*\/\s*5/im);
  const fence = text.match(/##\s*Machine Summary\s*\n+```(?:yaml|yml)?\s*\n([\s\S]*?)\n```/i);
  let summary = null;
  if (fence) {
    try {
      const parsed = loadYaml(fence[1]);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) summary = parsed;
    } catch {
      summary = null;
    }
  }
  const summaryScore = summary && summary.score != null ? requireUnitScore(summary.score, 'global') : null;
  const fromTable = tableGlobal ? requireUnitScore(tableGlobal[1], 'global') : null;
  if (summaryScore == null && fromTable == null) {
    throw Object.assign(new Error('career-ops report has no global score'), { code: 'career-ops-score-contract' });
  }
  if (summaryScore != null && fromTable != null && summaryScore !== fromTable) {
    throw Object.assign(
      new Error('career-ops global disagrees between the score table and Machine Summary'),
      { code: 'career-ops-score-contract' },
    );
  }
  return {
    score: summaryScore ?? fromTable,
    dimensions,
    score_evidence: summary?.score_evidence,
    legitimacy_tier: summary?.legitimacy_tier,
  };
}

function yamlQuote(value) {
  return JSON.stringify(String(value ?? ''));
}

/**
 * @param {object} spec
 * @returns {string}
 */
export function renderBoardReport(spec) {
  const { company, role, today, taken, dimensionKeys, labels, jdText, url, notes } = spec;
  const rows = dimensionKeys.map((key) => `| ${labels[key]} | ${taken.dimensions[key].toFixed(1)}/5 |`);
  const evidence = taken.scoreEvidence
    ? ['score_evidence:', ...dimensionKeys.map((key) => `  ${key}: ${taken.scoreEvidence[key]}`)]
    : [];
  const yaml = [
    `company: ${yamlQuote(company)}`,
    `role: ${yamlQuote(role)}`,
    `score: ${taken.score.toFixed(1)}`,
    `legitimacy_tier: ${yamlQuote(taken.legitimacy)}`,
    ...evidence,
  ].join('\n');
  const body = [
    `# Evaluation: ${company} — ${role}`,
    '',
    `**Date:** ${today}`,
    `**Score:** ${taken.scoreCell}`,
    `**Legitimacy:** ${taken.legitimacy}`,
    `**URL:** ${url || '(pasted)'}`,
    '',
    'Scored by career-ops (modes/_shared.md + modes/oferta.md). The numbers below are copied from that evaluation. HK overlay and level-fit text are notes only.',
    '',
    '| Dimension | Score |',
    '|-----------|-------|',
    ...rows,
    `| **Global** | **${taken.scoreCell}** |`,
    '',
    '## Machine Summary',
    '',
    '```yaml',
    yaml,
    '```',
    '',
    `Board notes: ${notes}`,
    '',
  ].join('\n');
  return withJdArchiveSection(body, jdText);
}

function headedTsv({ num, today, company, role, status, score, reportFile, notes, url }) {
  const labels = ['num', 'date', 'company', 'role', 'status', 'score', 'pdf', 'report', 'notes'];
  const fields = [
    num,
    today,
    tsvSafe(company),
    tsvSafe(role),
    status,
    score,
    '❌',
    `[${num}](reports/${reportFile})`,
    tsvSafe(notes),
  ];
  if (url) {
    labels.push('url');
    fields.push(url);
  }
  return `${labels.join('\t')}\n${fields.join('\t')}\n`;
}

/**
 * @param {object} input
 */
export function runBoardEval(input) {
  const company = String(input.company ?? '').trim();
  const role = String(input.role ?? '').trim();
  const jdText = String(input.jdText ?? '');
  if (!company || !role) {
    throw Object.assign(new Error('company and role are required'), { code: 'career-ops-score-contract' });
  }
  if (!jdText.trim()) {
    throw Object.assign(new Error('job text is required'), { code: 'career-ops-score-contract' });
  }
  const url = String(input.url ?? '').trim();
  if (url && !isPostingUrl(url)) {
    throw Object.assign(new Error('url is not an http(s) posting URL'), { code: 'career-ops-score-contract' });
  }
  const num = String(input.num ?? '').trim();
  if (!/^\d+$/.test(num) || Number(num) < 1) {
    throw Object.assign(new Error('report number must be a positive integer'), { code: 'career-ops-score-contract' });
  }
  const today = String(input.today ?? '').trim();
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(today)) {
    throw Object.assign(new Error('date must be YYYY-MM-DD'), { code: 'career-ops-score-contract' });
  }
  const keys = input.dimensionKeys;
  if (!Array.isArray(keys) || keys.length !== 5) {
    throw Object.assign(new Error('career-ops dimension keys are missing'), { code: 'career-ops-score-contract' });
  }
  const taken = takeCareerOpsScore(input.evaluation, keys);
  const hk = suggestEvalStatus(
    {
      title: role,
      company,
      workType: input.workType || '',
      description: jdText,
      status: 'Evaluated',
    },
    input.portals || {},
  );
  if (!ALLOWED_STATUS.has(hk.suggestedStatus)) {
    throw Object.assign(
      new Error(`board-eval refuses status ${hk.suggestedStatus}`),
      { code: 'career-ops-score-contract' },
    );
  }
  const notes = composeBoardNotes({
    dimsNote: formatDimsNote(taken, keys),
    hkNotes: hk.notes,
    levelFit: input.levelFit,
  });
  const numStr = String(Number(num)).padStart(3, '0');
  const slug = slugifyCompany(company);
  const reportFile = `${numStr}-${slug}-${today}.md`;
  const markdown = renderBoardReport({
    company,
    role,
    today,
    taken,
    dimensionKeys: keys,
    labels: input.labels,
    jdText,
    url,
    notes,
  });
  const result = {
    ok: true,
    score: taken.scoreCell,
    global: taken.score,
    dimensions: taken.dimensions,
    status: hk.suggestedStatus,
    notes,
    applied: false,
    submit: false,
    rubricSources: input.rubricSources || [],
    notionPushDryRun: NOTION_PUSH_DRY_RUN,
    reportFile,
    reportPath: null,
    tsvPath: null,
    dryRun: Boolean(input.dryRun),
  };
  if (input.dryRun) return result;

  const dataRoot = input.dataRoot;
  if (!dataRoot) {
    throw Object.assign(new Error('data root is required'), { code: 'career-ops-score-contract' });
  }
  const reportsDir = join(dataRoot, 'reports');
  const additionsDir = join(dataRoot, 'batch', 'tracker-additions');
  mkdirSync(reportsDir, { recursive: true });
  mkdirSync(additionsDir, { recursive: true });
  const reportPath = join(reportsDir, reportFile);
  const tsvPath = join(additionsDir, `${numStr}-${slug}.tsv`);
  writeFileSync(reportPath, markdown, 'utf8');
  writeFileSync(tsvPath, headedTsv({
    num: numStr,
    today,
    company,
    role,
    status: hk.suggestedStatus,
    score: taken.scoreCell,
    reportFile,
    notes,
    url,
  }), 'utf8');
  result.reportPath = reportPath;
  result.tsvPath = tsvPath;
  return result;
}
