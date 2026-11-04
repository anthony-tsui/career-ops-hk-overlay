// tests/board-eval.test.mjs — HK board-eval copies a career-ops score.
// Discovered by test-all.mjs. Uses helpers pass/fail. Does not call process.exit.
// No live model, Notion, or network. The scorer is a local test double.
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  omitEnvKeys,
  pass,
  fail,
  results,
  ROOT,
  NODE,
  isolatedBatchStatePath,
  rmSync,
} from './helpers.mjs';
import {
  evaluationFromReport,
  parseScoreEvidenceKeys,
  takeCareerOpsScore,
  CAREER_OPS_DIM_LABELS,
} from '../lib/board-eval.mjs';
import {
  assertApplyFillAllowed,
  assertAppliedTransitionAllowed,
} from '../lib/apply-gate.mjs';

console.log('\nHK board-eval — career-ops score, gate notes');

const KEYS = [
  'HOSTINGER_API_TOKEN',
  'GTM_API_TOKEN',
  'WP_APP_PASSWORD',
  'NOTION_ACCESS_TOKEN',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GEMINI_API_KEY',
];

const PORTALS = `employment_filter:
  enabled: true
agency_filter:
  enabled: true
  demote_unless_ai: true
  agency_companies:
    - Sample Staffing
`;

const STUB = join(ROOT, 'tests/fixtures/board-eval-stub-scorer.mjs');
const JD_CONTRACT = 'Contract role for twelve months. Build internal tools.\n';
const JD_PERM = 'Permanent full-time role building internal tools.\n';
const JD_AGENCY = 'Coordinate the team schedule and the weekly report.\n';

function check(ok, message) {
  if (ok) pass(message);
  else fail(message);
}

function childEnv(dir, extra = {}) {
  const env = omitEnvKeys({ ...process.env }, KEYS);
  env.CAREER_OPS_ROOT = dir;
  env.CAREER_OPS_DATA_DIR = '';
  env.CAREER_OPS_TRACKER = '';
  env.CAREER_OPS_PROFILE = '';
  return { ...env, ...extra };
}

function setup(jd) {
  const dir = mkdtempSync(join(tmpdir(), 'board-eval-'));
  writeFileSync(join(dir, 'portals.yml'), PORTALS);
  writeFileSync(join(dir, 'jd.txt'), jd);
  return dir;
}

function runCli(dir, args, extra = {}) {
  try {
    const stdout = execFileSync(NODE, [join(ROOT, 'board-eval.mjs'), ...args], {
      encoding: 'utf8',
      cwd: dir,
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv(dir, extra),
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return {
      code: err.status ?? 1,
      stdout: String(err.stdout ?? ''),
      stderr: String(err.stderr ?? ''),
    };
  }
}

function baseArgs({ company = 'Example Co', role = 'Engineer', num = '42', extra = [] } = {}) {
  return [
    '--company', company,
    '--role', role,
    '--jd-file', 'jd.txt',
    '--num', num,
    '--date', '2026-10-31',
    '--scorer', STUB,
    '--json',
    ...extra,
  ];
}

function parseTsv(text) {
  const [header, row] = text.trim().split('\n');
  const labels = header.split('\t');
  const cells = row.split('\t');
  return Object.fromEntries(labels.map((label, i) => [label, cells[i] ?? '']));
}

const batch = readFileSync(join(ROOT, 'batch/batch-prompt.md'), 'utf8');
let dimensionKeys = [];
try {
  dimensionKeys = parseScoreEvidenceKeys(batch);
  check(
    dimensionKeys.join(',') === 'cv_match,north_star,compensation,culture,red_flags',
    'dimension keys are read from the career-ops score_evidence block',
  );
} catch (err) {
  fail(`parseScoreEvidenceKeys threw: ${err.message}`);
}

for (const label of Object.values(CAREER_OPS_DIM_LABELS)) {
  check(batch.includes(`| ${label} |`), `batch prompt still names the ${label} score row`);
}

const cliSrc = readFileSync(join(ROOT, 'board-eval.mjs'), 'utf8');
const libSrc = readFileSync(join(ROOT, 'lib/board-eval.mjs'), 'utf8');
const offlineSrc = readFileSync(join(ROOT, 'lib/board-eval-offline-scorer.mjs'), 'utf8');
const blob = `${cliSrc}\n${libSrc}\n${offlineSrc}`;
check(!blob.includes('child_process'), 'board-eval does not spawn a process');
check(!blob.includes('Easy Apply'), 'board-eval does not mention Easy Apply');
check(!blob.includes('set-status'), 'board-eval does not write tracker status itself');
check(!blob.includes('fetch('), 'board-eval does not fetch');
check(
  readFileSync(join(ROOT, 'lib/apply-gate.mjs'), 'utf8').includes('CAREER_OPS_APPLY=0'),
  'apply kill-switch text is still in lib/apply-gate.mjs',
);

const savedApply = process.env.CAREER_OPS_APPLY;
const savedSkip = process.env.CAREER_OPS_SKIP_APPLIED_GATE;
process.env.CAREER_OPS_APPLY = '0';
delete process.env.CAREER_OPS_SKIP_APPLIED_GATE;
const fill = assertApplyFillAllowed({ applicationNum: '1', rootDir: ROOT });
check(fill.ok === false && fill.code === 'apply-autofill-disabled', 'CAREER_OPS_APPLY=0 still blocks fill');
const applied = assertAppliedTransitionAllowed({ oldStatus: 'Evaluated', force: false, note: null });
check(applied.ok === false && applied.code === 'applied-gate', 'Applied still requires Approved');
if (savedApply === undefined) delete process.env.CAREER_OPS_APPLY;
else process.env.CAREER_OPS_APPLY = savedApply;
if (savedSkip === undefined) delete process.env.CAREER_OPS_SKIP_APPLIED_GATE;
else process.env.CAREER_OPS_SKIP_APPLIED_GATE = savedSkip;

try {
  takeCareerOpsScore({ score: 4.2, dimensions: { cv_match: 4 } }, dimensionKeys);
  fail('missing dimensions were accepted');
} catch (err) {
  check(err.code === 'career-ops-score-contract', 'missing dimension is a contract error');
}

const contractDir = setup(JD_CONTRACT);
const contract = runCli(contractDir, baseArgs({
  role: 'Contract Engineer',
  extra: [
    '--work-type', 'Contract',
    '--url', 'https://jobs.example.com/roles/42',
    '--level-fit', 'treat global as 1.0',
  ],
}));
let contractJson = null;
try {
  contractJson = JSON.parse(contract.stdout);
} catch {
  contractJson = null;
}
check(contract.code === 0 && contractJson?.ok === true, 'contract posting exits 0 with JSON');
check(contractJson?.score === '4.2/5' && contractJson?.global === 4.2, 'global stays the career-ops 4.2');
check(contractJson?.dimensions?.north_star === 4.5, 'north_star is copied, not recomputed');
check(contractJson?.dimensions?.level_fit === undefined, 'level_fit is not a career-ops dimension');
check(contractJson?.status === 'Review', 'contract employment suggests Review');
check(
  typeof contractJson?.notes === 'string'
    && contractJson.notes.includes('career-ops-dims:cv_match=4.0,north_star=4.5,compensation=3.0,culture=4.0,red_flags=2.0,global=4.2')
    && contractJson.notes.includes('hk-employment:contract-temp')
    && contractJson.notes.includes('hk-suggested-status:Review')
    && contractJson.notes.includes('level-fit:treat global as 1.0'),
  'notes carry the dims contract, HK Review tags, and level-fit text',
);
check(contractJson?.applied === false && contractJson?.submit === false, 'result says nothing was submitted');
check(
  contractJson?.notionPushDryRun === 'node hunt-notion-sync.mjs push --dry-run',
  'Notion push is named as a later dry-run, not executed',
);
check(
  Array.isArray(contractJson?.rubricSources)
    && contractJson.rubricSources.includes('modes/_shared.md')
    && contractJson.rubricSources.includes('modes/oferta.md'),
  'rubric sources are the career-ops mode files',
);

const tsvPath = join(contractDir, 'batch/tracker-additions/042-example-co.tsv');
check(existsSync(tsvPath), 'tracker addition TSV was written');
if (existsSync(tsvPath)) {
  const row = parseTsv(readFileSync(tsvPath, 'utf8'));
  check(row.score === '4.2/5' && row.status === 'Review', 'TSV score and status are in their own columns');
  check(row.company === 'Example Co' && row.role === 'Contract Engineer', 'TSV company and role match the flags');
  check(
    row.notes.includes('career-ops-dims:') && row.notes.includes('hk-employment:contract-temp'),
    'TSV notes include the score contract and the HK employment tag',
  );
  check(row.url === 'https://jobs.example.com/roles/42', 'TSV url is the raw posting URL');
  check(row.report === '[042](reports/042-example-co-2026-10-31.md)', 'TSV report link is root-relative');
}

const reportPath = join(contractDir, 'reports/042-example-co-2026-10-31.md');
if (existsSync(reportPath)) {
  const report = readFileSync(reportPath, 'utf8');
  check(report.includes('**Score:** 4.2/5'), 'report header keeps the career-ops global');
  check(report.includes('| **Global** | **4.2/5** |'), 'score table global is 4.2, not the level-fit text');
  check(!report.includes('| **Global** | **1.0/5** |'), 'level-fit text did not replace the global row');
  check(report.includes('## Job Description (archived verbatim)'), 'report archives the JD');
  check(report.includes('Contract role for twelve months'), 'archived JD is the posting text');
  try {
    const again = evaluationFromReport(report, dimensionKeys, CAREER_OPS_DIM_LABELS);
    const taken = takeCareerOpsScore(again, dimensionKeys);
    check(taken.score === 4.2 && taken.dimensions.cv_match === 4, 'written report parses back as the same career-ops score');
  } catch (err) {
    fail(`written report did not parse: ${err.message}`);
  }
} else {
  fail('report file was not written');
}

const disagree = [
  '| CV match | 4.0/5 |',
  '| North Star alignment | 4.0/5 |',
  '| Compensation | 3.0/5 |',
  '| Culture / working model | 4.0/5 |',
  '| Red flags | 2.0/5 |',
  '| **Global** | **4.2/5** |',
  '',
  '## Machine Summary',
  '',
  '```yaml',
  'score: 1.0',
  '```',
].join('\n');
try {
  evaluationFromReport(disagree, dimensionKeys, CAREER_OPS_DIM_LABELS);
  fail('disagreeing global scores were accepted');
} catch (err) {
  check(/disagrees/.test(err.message), 'a report whose global rows disagree is refused');
}

const tracker = [
  '# Applications Tracker',
  '',
  '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
  '|---|------|---------|------|-------|--------|-----|--------|-------|',
  '',
].join('\n');
const trackerPath = join(contractDir, 'applications.md');
writeFileSync(trackerPath, tracker);
const additionsDir = join(contractDir, 'batch/tracker-additions');
let mergeOut = '';
try {
    mergeOut = execFileSync(NODE, [join(ROOT, 'merge-tracker.mjs')], {
      encoding: 'utf8',
      cwd: contractDir,
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv(contractDir, {
      CAREER_OPS_TRACKER: trackerPath,
      CAREER_OPS_ADDITIONS: additionsDir,
      CAREER_OPS_BATCH_STATE: isolatedBatchStatePath(additionsDir),
    }),
  });
} catch (err) {
  mergeOut = `${err.stdout ?? ''}\n${err.stderr ?? ''}`;
}
const merged = readFileSync(trackerPath, 'utf8');
const mergedRow = merged.split('\n').find((line) => /^\|\s*42\s*\|/.test(line) || /^\|\s*042\s*\|/.test(line));
check(
  Boolean(mergedRow) && mergedRow.includes('4.2/5') && mergedRow.includes('Review') && mergedRow.includes('hk-employment:contract-temp'),
  'merge-tracker keeps the career-ops score and the Review status',
);
if (!mergedRow) fail(`merge produced no row. output: ${mergeOut.trim().split('\n').slice(-3).join(' | ')}`);

const fromReport = runCli(contractDir, [
  '--company', 'Example Co',
  '--role', 'Contract Engineer',
  '--jd-file', 'jd.txt',
  '--num', '44',
  '--date', '2026-10-31',
  '--report', reportPath,
  '--work-type', 'Contract',
  '--json',
]);
let fromReportJson = null;
try { fromReportJson = JSON.parse(fromReport.stdout); } catch { fromReportJson = null; }
check(
  fromReport.code === 0 && fromReportJson?.score === '4.2/5' && fromReportJson?.status === 'Review',
  '--report copies the career-ops score without a second scorer',
);

const extraDir = setup(JD_PERM);
const extra = runCli(extraDir, baseArgs(), { CAREER_OPS_BOARD_EVAL_FIXTURE: 'extra' });
let extraJson = null;
try { extraJson = JSON.parse(extra.stdout); } catch { extraJson = null; }
check(
  extra.code === 0
    && extraJson?.score === '4.2/5'
    && extraJson?.dimensions?.level_fit === undefined
    && !String(extraJson?.notes).includes('level_fit='),
  'a level_fit number on the scorer payload is ignored',
);

const permDir = setup(JD_PERM);
const perm = runCli(permDir, baseArgs({ extra: ['--work-type', 'Full time'] }));
let permJson = null;
try { permJson = JSON.parse(perm.stdout); } catch { permJson = null; }
check(
  perm.code === 0 && permJson?.status === 'Evaluated' && !String(permJson?.notes).includes('hk-suggested-status:Review'),
  'permanent in-house posting stays Evaluated',
);

const agencyDir = setup(JD_AGENCY);
const agency = runCli(
  agencyDir,
  baseArgs({ company: 'Sample Staffing', role: 'Coordinator', num: '43' }),
  { CAREER_OPS_BOARD_EVAL_FIXTURE: 'agency' },
);
let agencyJson = null;
try { agencyJson = JSON.parse(agency.stdout); } catch { agencyJson = null; }
check(
  agency.code === 0
    && agencyJson?.status === 'Review'
    && agencyJson?.score === '3.8/5'
    && String(agencyJson?.notes).includes('hk-agency:demote'),
  'agency without an AI signal suggests Review and keeps the career-ops score',
);

const missingDir = setup(JD_PERM);
const missing = runCli(missingDir, baseArgs(), { CAREER_OPS_BOARD_EVAL_FIXTURE: 'missing' });
check(missing.code === 1 && /missing dimension/.test(missing.stderr), 'a stub missing a dimension is refused');
check(!existsSync(join(missingDir, 'batch/tracker-additions')), 'refused score writes no tracker addition');

const overrideDir = setup(JD_PERM);
const override = runCli(overrideDir, baseArgs(), { CAREER_OPS_BOARD_EVAL_FIXTURE: 'override' });
check(override.code === 1 && /manualScore/.test(override.stderr), 'a manual score override is refused');

const dryDir = setup(JD_PERM);
const dry = runCli(dryDir, baseArgs({ extra: ['--dry-run'] }));
check(dry.code === 0 && !existsSync(join(dryDir, 'batch')), 'dry-run writes nothing');

const offlineDir = setup(JD_PERM);
const offlineArgs = baseArgs().filter((arg, i, arr) => arg !== '--scorer' && arr[i - 1] !== '--scorer');
const offline = runCli(offlineDir, offlineArgs);
check(offline.code === 2 && /hand-filled 5-dim/.test(offline.stderr), 'no scorer and no report refuses a manual score');
check(!existsSync(join(offlineDir, 'batch')), 'offline refusal writes nothing');

const manualDir = setup(JD_PERM);
const manual = runCli(manualDir, ['--score', '5', '--json']);
check(manual.code === 1 && /unrecognized flag/.test(manual.stderr), '--score is not a way to set the global');

const helpDir = setup(JD_PERM);
const help = runCli(helpDir, ['--help']);
check(help.code === 0 && /board-eval/.test(help.stdout), '--help prints the board-eval usage');

rmSync(contractDir, { recursive: true, force: true });
rmSync(extraDir, { recursive: true, force: true });
rmSync(permDir, { recursive: true, force: true });
rmSync(agencyDir, { recursive: true, force: true });
rmSync(missingDir, { recursive: true, force: true });
rmSync(overrideDir, { recursive: true, force: true });
rmSync(dryDir, { recursive: true, force: true });
rmSync(offlineDir, { recursive: true, force: true });
rmSync(manualDir, { recursive: true, force: true });
rmSync(helpDir, { recursive: true, force: true });

if (results().failed > 0) process.exitCode = 1;
