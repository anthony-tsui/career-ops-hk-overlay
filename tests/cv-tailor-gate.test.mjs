// tests/cv-tailor-gate.test.mjs — HK CV tailor gate + local writer.
// Discovered by test-all.mjs. Uses helpers pass/fail. Does not call process.exit.
import { execFileSync } from 'child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { delimiter, join } from 'path';
import { tmpdir } from 'os';
import { pass, fail, results, rmSync, ROOT, NODE } from './helpers.mjs';
import {
  assertCvRewriteAllowed,
  reportCellMatchesNum,
  CV_TAILOR_GATED,
  CV_TAILOR_DISABLED,
} from '../lib/cv-tailor-gate.mjs';
import { buildTailoredMarkdown } from '../lib/cv-tailor-local.mjs';
import {
  assertApplyFillAllowed,
  assertAppliedTransitionAllowed,
} from '../lib/apply-gate.mjs';
import { classifyEmployment, evaluateAgencyGate } from '../lib/hk-scan-filters.mjs';
import {
  HUNT_JOBS_DATA_SOURCE_ID,
  trackerStatusToNotionPush,
} from '../plugins/notion/hunt-status.mjs';

console.log('\nHK CV tailor gate — local writer, CAREER_OPS_CV_TAILOR');

const CV_TEXT = `# CV

## Experience

- Built SQL pipelines for retail analytics.
- Wrote Python scripts for weekly reports.
`;

const REPORT_TEXT = `# Evaluation: Beta - Engineer

Need SQL pipelines. Kubernetes is required.
`;

const TRACKER = `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
| 1 | 2026-06-01 | Acme | Engineer | 4.2/5 | Evaluated | ✅ | [1](../reports/001-acme-2026-06-01.md) | — |
| 2 | 2026-06-02 | Beta | Engineer | 4.0/5 | Approved | ✅ | [2](../reports/002-beta-2026-06-02.md) | operator GO |
`;

const saved = {
  CAREER_OPS_APPLY: process.env.CAREER_OPS_APPLY,
  CAREER_OPS_CV_TAILOR: process.env.CAREER_OPS_CV_TAILOR,
  CAREER_OPS_TRACKER: process.env.CAREER_OPS_TRACKER,
  CAREER_OPS_ROOT: process.env.CAREER_OPS_ROOT,
  CAREER_OPS_PROFILE: process.env.CAREER_OPS_PROFILE,
};

function restoreEnv() {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function makeSandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'co-cv-tailor-'));
  mkdirSync(join(dir, 'config'), { recursive: true });
  writeFileSync(join(dir, 'config', 'profile.yml'), 'apply:\n  autofill: true\n');
  writeFileSync(join(dir, 'cv.md'), CV_TEXT);
  mkdirSync(join(dir, 'reports'), { recursive: true });
  writeFileSync(join(dir, 'reports', '002-beta-2026-06-02.md'), REPORT_TEXT);
  const tracker = join(dir, 'applications.md');
  writeFileSync(tracker, TRACKER);
  return { dir, tracker };
}

function tailoredLooksHonest(markdown) {
  const gapAt = markdown.indexOf('## Not claimed');
  if (gapAt < 0) return 'missing gap section';
  const emphasis = markdown.slice(0, gapAt);
  if (!emphasis.includes('Built SQL pipelines for retail analytics.')) return 'SQL bullet was not kept';
  if (emphasis.includes('Kubernetes') || emphasis.includes('kubernetes')) return 'gap word landed in the emphasis';
  if (!markdown.slice(gapAt).includes('kubernetes')) return 'kubernetes was not listed as unclaimed';
  if (!markdown.includes('Wrote Python scripts for weekly reports.')) return 'base CV line was dropped';
  if (!markdown.includes('does not submit')) return 'draft rules missing';
  return '';
}

function runNode(script, args, env) {
  try {
    const out = execFileSync(NODE, [script, ...args], {
      cwd: ROOT,
      env,
      encoding: 'utf-8',
      timeout: 30000,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` };
  }
}

function offlineEnv(extra = {}, sandbox = null) {
  const env = { ...process.env, ...extra };
  const strip = [
    'OPENAI_API_KEY',
    'OPENROUTER_API_KEY',
    'NOTION_ACCESS_TOKEN',
    'HOSTINGER_API_TOKEN',
    'GTM_API_TOKEN',
    'WP_APP_PASSWORD',
    'CAREER_OPS_CV_TAILOR',
    'CAREER_OPS_APPLY',
  ];
  for (const key of strip) {
    if (!Object.prototype.hasOwnProperty.call(extra, key)) delete env[key];
  }
  if (sandbox) {
    env.CAREER_OPS_ROOT = sandbox.dir;
    env.CAREER_OPS_TRACKER = sandbox.tracker;
    env.CAREER_OPS_PROFILE = join(sandbox.dir, 'config', 'profile.yml');
  }
  return env;
}

const sandbox = makeSandbox();

try {
  const cell = '[2](../reports/002-beta-2026-06-02.md)';
  if (reportCellMatchesNum(cell, 2) && !reportCellMatchesNum(cell, 2026) && !reportCellMatchesNum(cell, 6)) {
    pass('report cell matches report 2, not the date digits');
  } else fail(`report cell match drifted: 2=${reportCellMatchesNum(cell, 2)} 2026=${reportCellMatchesNum(cell, 2026)}`);

  delete process.env.CAREER_OPS_CV_TAILOR;
  const closed = assertCvRewriteAllowed({ applicationNum: '2', rootDir: sandbox.dir });
  if (!closed.ok && closed.code === CV_TAILOR_GATED) pass('rewrite blocked with no GO flag');
  else fail(`expected closed gate: ${JSON.stringify(closed)}`);

  const notApproved = assertCvRewriteAllowed({ applicationNum: '1', go: true, rootDir: sandbox.dir });
  if (!notApproved.ok && notApproved.message.includes('not Approved')) pass('--go still blocked when status is Evaluated');
  else fail(`Evaluated + --go should stay blocked: ${JSON.stringify(notApproved)}`);

  const opened = assertCvRewriteAllowed({ applicationNum: '2', go: true, rootDir: sandbox.dir });
  if (opened.ok) pass('--go opens the gate for Approved #2');
  else fail(`Approved + --go should open: ${JSON.stringify(opened)}`);

  const forceBare = assertCvRewriteAllowed({ applicationNum: '2', force: true, note: '  ', rootDir: sandbox.dir });
  if (!forceBare.ok) pass('--force without an audit note stays blocked');
  else fail('--force without note should stay blocked');

  const forceOk = assertCvRewriteAllowed({
    applicationNum: '2', force: true, note: 'audit: operator GO relayed', rootDir: sandbox.dir,
  });
  if (forceOk.ok) pass('--force + --note opens the gate for Approved #2');
  else fail(`force+note should open: ${JSON.stringify(forceOk)}`);

  const byReport = assertCvRewriteAllowed({ reportNums: ['002'], go: true, rootDir: sandbox.dir });
  if (byReport.ok) pass('--go opens the gate for Approved report 002');
  else fail(`report 002 should open: ${JSON.stringify(byReport)}`);

  const reportDenied = assertCvRewriteAllowed({ reportNums: ['1'], go: true, rootDir: sandbox.dir });
  if (!reportDenied.ok) pass('report 001 stays blocked (Evaluated)');
  else fail('report 001 should stay blocked');

  process.env.CAREER_OPS_CV_TAILOR = '0';
  const hardOff = assertCvRewriteAllowed({ applicationNum: '2', go: true, rootDir: sandbox.dir });
  if (!hardOff.ok && hardOff.code === CV_TAILOR_DISABLED) pass('CAREER_OPS_CV_TAILOR=0 blocks even Approved + --go');
  else fail(`hard off failed: ${JSON.stringify(hardOff)}`);

  process.env.CAREER_OPS_CV_TAILOR = '1';
  const envGo = assertCvRewriteAllowed({ applicationNum: '2', rootDir: sandbox.dir });
  if (envGo.ok) pass('CAREER_OPS_CV_TAILOR=1 counts as the GO flag for an Approved row');
  else fail(`env GO should open Approved row: ${JSON.stringify(envGo)}`);
  const envGoDenied = assertCvRewriteAllowed({ applicationNum: '1', rootDir: sandbox.dir });
  if (!envGoDenied.ok) pass('CAREER_OPS_CV_TAILOR=1 does not open an Evaluated row');
  else fail('env GO must not skip Approved');
  delete process.env.CAREER_OPS_CV_TAILOR;

  // ── CLI proofs (no network, no model) ──
  const gateCli = join(ROOT, 'cv-tailor-gate.mjs');
  const blockedCli = runNode(gateCli, ['--application', '2', '--json'], offlineEnv({}, sandbox));
  if (blockedCli.code !== 0 && blockedCli.out.includes(CV_TAILOR_GATED)) {
    pass('cv-tailor-gate CLI blocks Approved row when --go is absent');
  } else fail(`CLI should block without --go: code=${blockedCli.code} ${blockedCli.out.slice(0, 240)}`);

  const openCli = runNode(gateCli, ['--application', '2', '--go', '--json'], offlineEnv({}, sandbox));
  if (openCli.code === 0 && openCli.out.includes('"ok":true') && openCli.out.includes('3–5')) {
    pass('cv-tailor-gate CLI opens for Approved + --go and prints the delta SOP');
  } else fail(`CLI open failed: code=${openCli.code} ${openCli.out.slice(0, 240)}`);

  const tailorScript = join(ROOT, 'openai-tailor.mjs');
  const tailorBlocked = runNode(
    tailorScript,
    ['--jd', join(sandbox.dir, 'missing-jd.txt'), '--report', join(sandbox.dir, 'nope.md')],
    offlineEnv({}, sandbox),
  );
  if (
    tailorBlocked.code !== 0
    && tailorBlocked.out.includes(CV_TAILOR_GATED)
    && !tailorBlocked.out.includes('Loading context')
    && !tailorBlocked.out.includes('chat/completions')
  ) {
    pass('openai-tailor exits on the gate before reading files or calling a model');
  } else fail(`openai-tailor was not gated: code=${tailorBlocked.code} ${tailorBlocked.out.slice(0, 300)}`);

  const stateDir = mkdtempSync(join(tmpdir(), 'co-batch-tailor-gate-'));
  const stateFile = join(stateDir, 'batch-state.tsv');
  writeFileSync(
    stateFile,
    'id\turl\tstatus\tstarted_at\tcompleted_at\treport_num\tscore\terror\tretries\n'
    + '1\thttps://example.com/job\tcompleted\t-\t-\t001\t4.5\t-\t0\n',
  );
  const batchBlocked = runNode(
    join(ROOT, 'batch-tailor.mjs'),
    ['--min-score', '1'],
    offlineEnv({ CAREER_OPS_BATCH_STATE: stateFile }, sandbox),
  );
  if (
    batchBlocked.code !== 0
    && batchBlocked.out.includes(CV_TAILOR_GATED)
    && !batchBlocked.out.includes('Beginning bulk tailoring')
  ) {
    pass('batch-tailor refuses to spawn workers when the gate is closed');
  } else fail(`batch-tailor was not gated: code=${batchBlocked.code} ${batchBlocked.out.slice(0, 300)}`);
  rmSync(stateDir, { recursive: true, force: true });

  const orBlocked = runNode(
    join(ROOT, 'openrouter-runner.mjs'),
    ['apply', '2', '--tailor'],
    offlineEnv({}, sandbox),
  );
  if (
    orBlocked.code !== 0
    && orBlocked.out.includes(CV_TAILOR_GATED)
    && !orBlocked.out.includes('Generating application')
    && !orBlocked.out.includes('OpenRouter')
  ) {
    pass('or:apply --tailor is blocked before any model call');
  } else fail(`or:apply --tailor was not gated: code=${orBlocked.code} ${orBlocked.out.slice(0, 300)}`);

  const unitMd = buildTailoredMarkdown({
    cvText: CV_TEXT,
    jdText: 'Need SQL pipelines. Kubernetes is required.',
    company: 'Beta',
    role: 'Engineer',
  });
  const unitProblem = tailoredLooksHonest(unitMd);
  if (!unitProblem) pass('local tailor copies cv.md lines and does not claim missing job words');
  else fail(`local tailor markdown drifted: ${unitProblem}`);

  const trackerBefore = readFileSync(sandbox.tracker, 'utf-8');
  const tailoredName = 'cv-tailored-002-beta-engineer.md';
  const orOpen = runNode(
    join(ROOT, 'openrouter-runner.mjs'),
    ['apply', '2', '--tailor', '--go'],
    offlineEnv({}, sandbox),
  );
  const orFile = join(sandbox.dir, 'output', tailoredName);
  const orMd = existsSync(orFile) ? readFileSync(orFile, 'utf-8') : '';
  if (
    orOpen.code === 0
    && orOpen.out.includes(`Tailored CV (local): output/${tailoredName}`)
    && !orOpen.out.includes('does not rewrite the CV')
    && !orOpen.out.includes('Generating application')
    && !orOpen.out.includes('OpenRouter')
    && !orOpen.out.includes('chat/completions')
    && !tailoredLooksHonest(orMd)
    && readFileSync(sandbox.tracker, 'utf-8') === trackerBefore
  ) {
    pass('or:apply --tailor --go writes a local CV and does not call a model or mark Applied');
  } else fail(`or:apply allowed path drifted: code=${orOpen.code} ${orOpen.out.slice(0, 300)} file=${orMd.slice(0, 120)}`);

  const orJsonPath = join(sandbox.dir, 'output', 'cv-tailored-002-beta-engineer.json');
  let orJson = {};
  try { orJson = JSON.parse(readFileSync(orJsonPath, 'utf-8')); } catch { /* asserted below */ }
  if (orJson.mode === 'local' && orJson.artifact === 'draft-md' && orJson.notionSource === false && orJson.submitted === false && orJson.applied === false && orJson.easyApply === false && orJson.linkedInScrape === false) {
    pass('tailor sidecar says local draft: not submitted, not Applied, no Easy Apply, no LinkedIn scrape');
  } else fail(`sidecar drifted: ${JSON.stringify(orJson)}`);

  rmSync(join(sandbox.dir, 'output'), { recursive: true, force: true });
  const hardOffCli = runNode(
    join(ROOT, 'openrouter-runner.mjs'),
    ['apply', '2', '--tailor', '--go'],
    offlineEnv({ CAREER_OPS_CV_TAILOR: '0' }, sandbox),
  );
  if (
    hardOffCli.code !== 0
    && hardOffCli.out.includes(CV_TAILOR_DISABLED)
    && !existsSync(orFile)
    && !hardOffCli.out.includes('Generating application')
  ) {
    pass('CAREER_OPS_CV_TAILOR=0 blocks Approved + --go before any CV write');
  } else fail(`env 0 did not block the writer: code=${hardOffCli.code} ${hardOffCli.out.slice(0, 240)}`);

  const envGoWrite = runNode(
    join(ROOT, 'openrouter-runner.mjs'),
    ['apply', '2', '--tailor'],
    offlineEnv({ CAREER_OPS_CV_TAILOR: '1' }, sandbox),
  );
  if (envGoWrite.code === 0 && existsSync(orFile) && envGoWrite.out.includes('Tailored CV (local):')) {
    pass('CAREER_OPS_CV_TAILOR=1 plus Approved writes a local CV without a separate --go');
  } else fail(`env 1 write failed: code=${envGoWrite.code} ${envGoWrite.out.slice(0, 240)}`);

  const prepOrder = runNode(
    join(ROOT, 'prepare-application.mjs'),
    ['--url', 'https://boards.greenhouse.io/example/jobs/1', '--pdf', 'output/x.pdf', '--application', '2', '--tailor', '--go'],
    offlineEnv({ CAREER_OPS_APPLY: '0' }, sandbox),
  );
  if (
    prepOrder.code !== 0
    && (prepOrder.out.includes('apply-autofill-disabled') || prepOrder.out.includes('autofill is disabled'))
    && !prepOrder.out.includes(CV_TAILOR_GATED)
  ) {
    pass('prepare --tailor still hits the Slice A autofill gate first');
  } else fail(`prepare gate order drifted: code=${prepOrder.code} ${prepOrder.out.slice(0, 300)}`);

  const prepTailor = runNode(
    join(ROOT, 'prepare-application.mjs'),
    ['--url', 'https://boards.greenhouse.io/example/jobs/1', '--pdf', 'output/x.pdf', '--application', '2', '--tailor'],
    offlineEnv({}, sandbox),
  );
  if (prepTailor.code !== 0 && prepTailor.out.includes(CV_TAILOR_GATED) && !prepTailor.out.includes('chat/completions')) {
    pass('prepare --tailor blocked when Approved but no GO flag');
  } else fail(`prepare --tailor should be gated: code=${prepTailor.code} ${prepTailor.out.slice(0, 300)}`);

  mkdirSync(join(sandbox.dir, 'output'), { recursive: true });
  writeFileSync(join(sandbox.dir, 'output', 'x.pdf'), '%PDF-1.1\n');
  const trackerMid = readFileSync(sandbox.tracker, 'utf-8');
  const prepGo = runNode(
    join(ROOT, 'prepare-application.mjs'),
    ['--url', 'https://boards.greenhouse.io/example/jobs/1', '--pdf', 'output/x.pdf', '--application', '2', '--tailor', '--go'],
    offlineEnv({}, sandbox),
  );
  const prepFile = join(sandbox.dir, 'output', tailoredName);
  if (
    prepGo.code === 0
    && prepGo.out.includes(`Tailored CV (local): output/${tailoredName}`)
    && !prepGo.out.includes('does not rewrite the CV')
    && existsSync(prepFile)
    && !tailoredLooksHonest(readFileSync(prepFile, 'utf-8'))
    && readFileSync(sandbox.tracker, 'utf-8') === trackerMid
  ) {
    pass('prepare --tailor --go writes a local CV and still does not submit');
  } else fail(`prepare allowed path drifted: code=${prepGo.code} ${prepGo.out.slice(0, 300)}`);

  mkdirSync(join(sandbox.dir, 'jds'), { recursive: true });
  const jdFile = join(sandbox.dir, 'jds', 'job.txt');
  writeFileSync(jdFile, 'Need SQL pipelines. Kubernetes is required.\n');
  const localTailor = runNode(
    join(ROOT, 'openai-tailor.mjs'),
    ['--local', '--jd', jdFile, '--report', join(sandbox.dir, 'reports', '002-beta-2026-06-02.md'), '--application', '2', '--go'],
    offlineEnv({}, sandbox),
  );
  if (
    localTailor.code === 0
    && localTailor.out.includes(`Tailored CV (local): output/${tailoredName}`)
    && !localTailor.out.includes('Loading context')
    && !localTailor.out.includes('chat/completions')
    && !localTailor.out.includes('Privacy:')
    && readFileSync(sandbox.tracker, 'utf-8') === trackerMid
  ) {
    pass('openai-tailor --local writes a CV offline when Approved + --go');
  } else fail(`openai-tailor --local drifted: code=${localTailor.code} ${localTailor.out.slice(0, 300)}`);

  const stubDir = mkdtempSync(join(tmpdir(), 'co-cli-stub-'));
  const marker = join(stubDir, 'claude-ran');
  writeFileSync(join(stubDir, 'claude'), `#!/bin/sh\necho ran > '${marker}'\nexit 99\n`);
  chmodSync(join(stubDir, 'claude'), 0o755);
  const pathWithStub = `${stubDir}${delimiter}${process.env.PATH || ''}`;
  if (pathWithStub.split(delimiter)[0] === stubDir) pass('cli-stub PATH[0] is the stub');
  else fail(`cli-stub PATH[0] drifted: ${pathWithStub.split(delimiter)[0]}`);

  const batchDir = mkdtempSync(join(tmpdir(), 'co-batch-tailor-open-'));
  const batchState = join(batchDir, 'batch-state.tsv');
  writeFileSync(
    batchState,
    'id\turl\tstatus\tstarted_at\tcompleted_at\treport_num\tscore\terror\tretries\n'
    + '1\thttps://example.com/job\tcompleted\t-\t-\t002\t4.5\t-\t0\n',
  );
  const batchOpen = runNode(
    join(ROOT, 'batch-tailor.mjs'),
    ['--min-score', '4', '--go'],
    offlineEnv({ CAREER_OPS_BATCH_STATE: batchState, PATH: pathWithStub }, sandbox),
  );
  if (
    batchOpen.code === 0
    && batchOpen.out.includes(`Tailored CV (local): output/${tailoredName}`)
    && !existsSync(marker)
    && !batchOpen.out.includes('Beginning bulk tailoring')
    && readFileSync(sandbox.tracker, 'utf-8') === trackerMid
  ) {
    pass('batch-tailor --go writes a local CV and does not run the cli stub');
  } else fail(`batch-tailor open path drifted: code=${batchOpen.code} marker=${existsSync(marker)} ${batchOpen.out.slice(0, 300)}`);
  rmSync(batchDir, { recursive: true, force: true });
  rmSync(stubDir, { recursive: true, force: true });

  // ── Slice A / C / D contracts (canaries — do not widen those gates) ──
  process.env.CAREER_OPS_APPLY = '0';
  const fillDeny = assertApplyFillAllowed({ applicationNum: '2', rootDir: sandbox.dir });
  if (!fillDeny.ok && fillDeny.code === 'apply-autofill-disabled') pass('Slice A fill gate still blocks when autofill is off');
  else fail(`Slice A fill gate drifted: ${JSON.stringify(fillDeny)}`);
  delete process.env.CAREER_OPS_APPLY;

  const appliedDeny = assertAppliedTransitionAllowed({ oldStatus: 'Evaluated', force: false });
  if (!appliedDeny.ok && appliedDeny.code === 'applied-gate') pass('Slice A still blocks Applied from Evaluated');
  else fail('Slice A Applied-from-Evaluated gate drifted');

  const appliedOk = assertAppliedTransitionAllowed({ oldStatus: 'Approved', force: false });
  if (appliedOk.ok) pass('Slice A still allows Applied from Approved');
  else fail('Slice A Applied-from-Approved gate drifted');

  const dPortals = {
    employment_filter: { enabled: true },
    agency_filter: { enabled: true, demote_unless_ai: true },
  };
  const emp = classifyEmployment({ title: 'Data Lead', workType: ['Contract'], company: 'HSBC' }, dPortals.employment_filter);
  if (emp.class === 'contract_temp') pass('Slice D contract workType still classifies as contract_temp');
  else fail(`Slice D employment class drifted: ${JSON.stringify(emp)}`);

  const ag = evaluateAgencyGate(
    { title: 'Marketing Manager', company: 'Hays Hong Kong', description: 'Manage campaigns.' },
    dPortals.agency_filter,
  );
  if (ag.demote && ag.channel === 'agency') pass('Slice D agency demote without AI signal unchanged');
  else fail(`Slice D agency gate drifted: ${JSON.stringify(ag)}`);

  if (HUNT_JOBS_DATA_SOURCE_ID == null) {
    pass('Hunt data source id ships null; set NOTION_HUNT_DATA_SOURCE_ID');
  } else fail(`Hunt data source id must ship null, got: ${HUNT_JOBS_DATA_SOURCE_ID}`);

  const push = trackerStatusToNotionPush('Approved');
  if (push.notionSelect === 'Evaluated' && push.workflowNote === 'Approved') {
    pass('Slice C still maps Approved to Notion Evaluated + notion-status note');
  } else fail(`Slice C Approved push drifted: ${JSON.stringify(push)}`);
} finally {
  restoreEnv();
  rmSync(sandbox.dir, { recursive: true, force: true });
}

if (results().failed > 0) process.exitCode = 1;
