#!/usr/bin/env node
/**
 * board-eval.mjs — HK overlay entry for one posting.
 *
 * Copies a career-ops score (five oferta dimensions + global), then applies
 * the HK eval gate. Level-fit text is a note. Nothing here fills a form,
 * clicks Submit, or marks Applied.
 *
 *   node board-eval.mjs --company "Example Co" --role "Engineer" --jd-file jd.txt --num 042 --json
 *   node board-eval.mjs --company "Example Co" --role "Engineer" --jd-file jd.txt --num 042 --report reports/042-example-co-2026-10-31.md --json
 *   node board-eval.mjs --company "Example Co" --role "Engineer" --jd-file jd.txt --num 042 --scorer ./tests/fixtures/board-eval-stub-scorer.mjs --json
 *
 * After merge-tracker, the optional Hunt push (not run by this command) is:
 *   node hunt-notion-sync.mjs push --dry-run
 */

import { readFileSync } from 'fs';
import { dirname, isAbsolute, join, resolve } from 'path';
import { pathToFileURL, fileURLToPath } from 'url';
import { flagValue, hasFlag, validateFlags } from './lib/cli-flags.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { localToday } from './lib/local-today.mjs';
import {
  evaluationFromReport,
  parseScoreEvidenceKeys,
  runBoardEval,
  CAREER_OPS_DIM_LABELS,
} from './lib/board-eval.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { loadYaml } from './lib/yaml-document.mjs';

const CODE_ROOT = dirname(fileURLToPath(import.meta.url));

const USAGE = `Usage: node board-eval.mjs [options]

HK board-eval. career-ops scores the five oferta dimensions and the global.
This command copies that score, then applies hk-eval-gate. A hand-filled
5-dim sheet is refused. Level-fit text is a note and does not change scores.

Options:
  --company <name>       Employer name
  --role <title>         Role title
  --jd-file <path>       Posting text (used for the HK gate and the JD archive)
  --num <n>              Report number (reserve one with node reserve-report-num.mjs)
  --date <YYYY-MM-DD>    Evaluation date (default: local today)
  --url <https://...>    Employer posting URL
  --work-type <text>     Employment type, when the posting has one
  --report <path>        Existing career-ops report (oferta / batch / openrouter)
  --scorer <module.mjs>  Test double that exports scorePosting (not a rubric)
  --level-fit <text>     Optional note. Does not change scores
  --dry-run              Print the plan and write nothing
  --json                 Print one JSON object
  --help                 Show this help

Writes reports/{num}-{slug}-{date}.md and batch/tracker-additions/{num}-{slug}.tsv
under the career-ops data root. Does not merge the tracker, push Notion, fill
a form, or mark Applied.

Optional next step, after merge-tracker (this command does not run it):
  node hunt-notion-sync.mjs push --dry-run
`;

const KNOWN_FLAGS = [
  '--company', '--role', '--jd-file', '--num', '--date', '--url', '--work-type',
  '--report', '--scorer', '--level-fit', '--dry-run', '--json', '--help', '-h',
];

const VALUE_FLAGS = [
  '--company', '--role', '--jd-file', '--num', '--date', '--url', '--work-type',
  '--report', '--scorer', '--level-fit',
];

function fail(error, code = 1) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = code;
}

function loadRubric() {
  const shared = readFileSync(join(CODE_ROOT, 'modes/_shared.md'), 'utf8');
  const oferta = readFileSync(join(CODE_ROOT, 'modes/oferta.md'), 'utf8');
  const batch = readFileSync(join(CODE_ROOT, 'batch/batch-prompt.md'), 'utf8');
  if (!/scores five dimensions/.test(shared)) {
    throw Object.assign(
      new Error('modes/_shared.md does not contain the career-ops five-dimension scoring section'),
      { code: 'career-ops-score-contract' },
    );
  }
  if (!oferta.includes('## Score Evidence')) {
    throw Object.assign(
      new Error('modes/oferta.md does not contain the career-ops Score Evidence section'),
      { code: 'career-ops-score-contract' },
    );
  }
  const keys = parseScoreEvidenceKeys(batch);
  for (const key of keys) {
    if (!CAREER_OPS_DIM_LABELS[key]) {
      throw Object.assign(
        new Error(`career-ops dimension ${key} has no score-table label; refusing to invent one`),
        { code: 'career-ops-score-contract' },
      );
    }
  }
  return {
    keys,
    labels: CAREER_OPS_DIM_LABELS,
    sources: ['modes/_shared.md', 'modes/oferta.md', 'batch/batch-prompt.md'],
  };
}

function loadPortals(root) {
  try {
    const doc = loadYaml(readFileSync(join(root, 'portals.yml'), 'utf8'));
    return doc && typeof doc === 'object' ? doc : {};
  } catch {
    return {};
  }
}

async function loadEvaluation(args, rubric) {
  const reportPath = flagValue(args, '--report');
  const scorerPath = flagValue(args, '--scorer');
  if (reportPath && scorerPath) {
    throw Object.assign(
      new Error('pass either --report or --scorer, not both'),
      { code: 'career-ops-score-contract' },
    );
  }
  if (reportPath) {
    const markdown = readFileSync(resolve(reportPath), 'utf8');
    return evaluationFromReport(markdown, rubric.keys, rubric.labels);
  }
  const modulePath = scorerPath
    ? (isAbsolute(scorerPath) ? scorerPath : resolve(scorerPath))
    : join(CODE_ROOT, 'lib/board-eval-offline-scorer.mjs');
  const mod = await import(pathToFileURL(modulePath).href);
  if (typeof mod.scorePosting !== 'function') {
    throw Object.assign(
      new Error('scorer module must export scorePosting'),
      { code: 'career-ops-score-contract' },
    );
  }
  return mod.scorePosting({
    company: flagValue(args, '--company') || '',
    role: flagValue(args, '--role') || '',
    jdText: flagValue(args, '--jd-file') ? readFileSync(resolve(flagValue(args, '--jd-file')), 'utf8') : '',
  });
}

async function main() {
  const args = process.argv.slice(2);
  validateFlags(args, KNOWN_FLAGS, USAGE, { valueFlags: VALUE_FLAGS, requireOperand: true });
  if (!hasFlag(args, '--company') || !hasFlag(args, '--role') || !hasFlag(args, '--jd-file') || !hasFlag(args, '--num')) {
    fail('company, role, jd-file, and num are required\n' + USAGE);
    return;
  }
  try {
    const rubric = loadRubric();
    const jdText = readFileSync(resolve(flagValue(args, '--jd-file')), 'utf8');
    const evaluation = await loadEvaluation(args, rubric);
    const dataRoot = getCareerOpsRoot();
    const result = runBoardEval({
      dataRoot,
      company: flagValue(args, '--company'),
      role: flagValue(args, '--role'),
      jdText,
      url: flagValue(args, '--url') || '',
      workType: flagValue(args, '--work-type') || '',
      num: flagValue(args, '--num'),
      today: flagValue(args, '--date') || localToday(),
      evaluation,
      dimensionKeys: rubric.keys,
      labels: rubric.labels,
      portals: loadPortals(dataRoot),
      levelFit: flagValue(args, '--level-fit') || '',
      dryRun: hasFlag(args, '--dry-run'),
      rubricSources: rubric.sources,
    });
    if (hasFlag(args, '--json')) {
      console.log(JSON.stringify(result));
    } else {
      console.log(`Score: ${result.score}`);
      console.log(`Status: ${result.status}`);
      console.log(`Notes: ${result.notes}`);
      console.log(result.dryRun ? 'Dry run: wrote nothing' : `Wrote ${result.reportPath}`);
      console.log(`Applied: no. Submit: no.`);
      console.log(`Optional later: ${result.notionPushDryRun}`);
    }
  } catch (err) {
    const code = err?.code === 'career-ops-scorer-offline' ? 2 : 1;
    fail(err, code);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
