/**
 * hunt-notion-sync.test.mjs — HK Slice C unit tests (mock Notion client, no live API).
 */

import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { pass, fail, rmSync, ROOT, NODE } from './helpers.mjs';
import {
  trackerStatusToNotionPush,
  notionRowToTrackerStatus,
  mergeNotionStatusMarker,
  parseNotionStatusMarker,
  HUNT_JOBS_DATA_SOURCE_ID,
} from '../plugins/notion/hunt-status.mjs';
import {
  buildHuntProperties,
  createHuntNotionClient,
  huntPushRows,
  planHuntPullUpdates,
  readTrackerRowsForHunt,
  extractJobUrl,
  applyHuntPullUpdates,
} from '../plugins/notion/hunt-sync.mjs';

console.log('\nHK Slice C — hunt-notion-sync');

function makePullSandbox(status = 'Evaluated') {
  const dir = mkdtempSync(join(tmpdir(), 'co-hunt-pull-'));
  mkdirSync(join(dir, 'data'), { recursive: true });
  writeFileSync(
    join(dir, 'data', 'applications.md'),
    `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
| 1 | 2026-06-01 | Acme | Engineer | 4.2/5 | ${status} | ✅ | [1](../reports/001.md) | — |
`,
  );
  const lock = join(dir, 'career-ops-hunt-pull-test.lock');
  return { dir, lock };
}

function runSetStatus(args, sandbox) {
  const env = {
    ...process.env,
    CAREER_OPS_ROOT: sandbox.dir,
    CAREER_OPS_TRACKER: join(sandbox.dir, 'data', 'applications.md'),
    CAREER_OPS_TRACKER_LOCK: sandbox.lock,
  };
  try {
    execFileSync(NODE, [join(ROOT, 'set-status.mjs'), ...args], {
      cwd: ROOT,
      env,
      encoding: 'utf-8',
      timeout: 30000,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { code: 0 };
  } catch (e) {
    return { code: e.status ?? 1, stderr: e.stderr || '', stdout: e.stdout || '' };
  }
}

if (HUNT_JOBS_DATA_SOURCE_ID == null) {
  pass('Hunt data source id ships null; set NOTION_HUNT_DATA_SOURCE_ID');
} else fail('Hunt data source id must ship null');

const short = trackerStatusToNotionPush('Shortlisted');
if (short.notionSelect === 'Evaluated' && short.workflowNote === 'Shortlisted') {
  pass('Shortlisted → Evaluated + workflow note');
} else fail(`Shortlisted map: ${JSON.stringify(short)}`);

if (notionRowToTrackerStatus('DEAD', '') === 'Discarded') pass('DEAD → Discarded on pull');
else fail('DEAD map');

if (notionRowToTrackerStatus('Evaluated', 'foo notion-status=Approved bar') === 'Approved') {
  pass('pull reads notion-status=Approved from Notes');
} else fail('notion-status marker pull');

const merged = mergeNotionStatusMarker('req JR-1', 'Review');
if (merged.includes('notion-status=Review') && merged.includes('JR-1')) pass('merge notion-status marker');
else fail(`merge marker: ${merged}`);

if (parseNotionStatusMarker(merged) === 'Review') pass('parse marker');
else fail('parse marker');

if (extractJobUrl('see https://jobs.example.com/123?utm=1) thanks') === 'https://jobs.example.com/123?utm=1') {
  pass('extractJobUrl');
} else fail('extractJobUrl');

function mockClient(existing = []) {
  const pages = [...existing];
  let statusPatchAttempt = false;
  return {
    dataSourceId: HUNT_JOBS_DATA_SOURCE_ID,
    async findRecords() {
      return pages.map((p) => ({
        id: p.id,
        company: p.company,
        role: p.role,
        status: p.status,
        score: p.score,
        jobUrl: p.url,
        notes: p.notes || '',
        url: `https://notion.so/${p.id}`,
      }));
    },
    async api(path, _method, body) {
      const id = path.replace('pages/', '');
      const idx = pages.findIndex((p) => p.id === id);
      if (idx === -1) throw new Error('missing page');
      if (body?.properties?.Status) {
        statusPatchAttempt = true;
        fail('push must not PATCH Status on existing row');
      }
      const patch = flattenProps(body.properties);
      pages[idx] = { ...pages[idx], ...patch };
      return { id };
    },
    async createPage(_ds, properties) {
      const flat = flattenProps(properties);
      pages.push({ id: `page-${pages.length}`, ...flat });
      return { id: pages[pages.length - 1].id };
    },
    statusPatchAttempt: () => statusPatchAttempt,
  };
}

function textOf(items) {
  return (items || []).map((t) => t.plain_text || t.text?.content || '').join('');
}

function flattenProps(properties) {
  const out = {};
  if (properties.Name?.title) out.name = textOf(properties.Name.title);
  if (properties.Company?.rich_text) out.company = textOf(properties.Company.rich_text);
  if (properties.Role?.rich_text) out.role = textOf(properties.Role.rich_text);
  if (properties.Status?.select) out.status = properties.Status.select.name;
  if (properties.Score?.rich_text) out.score = textOf(properties.Score.rich_text);
  else if (properties.Score?.number != null) out.score = properties.Score.number;
  if (properties.URL?.url) out.url = properties.URL.url;
  if (properties.Notes?.rich_text) out.notes = textOf(properties.Notes.rich_text);
  return out;
}

const createProps = buildHuntProperties(
  { company: 'Acme', role: 'Engineer', score: '4.2/5', status: 'Shortlisted', notes: '', url: 'https://x.test/1' },
  { includeStatus: true },
);
if (createProps.Status?.select?.name === 'Evaluated') pass('create includes Evaluated for Shortlisted');
else fail('create status');

if (
  createProps.Name?.title?.[0]?.text?.content === 'Acme — Engineer'
  && !createProps.Name?.rich_text
) pass('Name is the title property (Company — Role)');
else fail(`Name shape: ${JSON.stringify(createProps.Name)}`);

if (
  createProps.Role?.rich_text?.[0]?.text?.content === 'Engineer'
  && !createProps.Role?.title
) pass('Role is rich_text, not title');
else fail(`Role shape: ${JSON.stringify(createProps.Role)}`);

if (
  createProps.Score?.rich_text?.[0]?.text?.content === '4.2/5'
  && createProps.Score?.number == null
) pass('Score is rich_text string, not number');
else fail(`Score shape: ${JSON.stringify(createProps.Score)}`);

if (createProps.URL?.url === 'https://x.test/1') pass('URL property unchanged');
else fail(`URL shape: ${JSON.stringify(createProps.URL)}`);

const companyOnly = buildHuntProperties(
  { company: 'Solo Co', role: '', score: '   ', status: 'Evaluated', notes: '', url: '' },
  { includeStatus: false },
);
if (companyOnly.Name?.title?.[0]?.text?.content === 'Solo Co' && !companyOnly.Score && !companyOnly.Status) {
  pass('Name falls back to company; blank score omitted; update omits Status');
} else fail(`company-only payload: ${JSON.stringify(companyOnly)}`);

const updateProps = buildHuntProperties(
  { company: 'Acme', role: 'Engineer', score: '4.5/5', status: 'Approved', notes: 'n', url: 'https://x.test/1' },
  { includeStatus: false },
);
if (!updateProps.Status) pass('update payload omits Status');
else fail('update should omit Status');
if (updateProps.Score?.rich_text?.[0]?.text?.content === '4.5/5' && updateProps.Score?.number == null) {
  pass('update Score stays rich_text');
} else fail(`update Score shape: ${JSON.stringify(updateProps.Score)}`);

const huntClient = createHuntNotionClient({ token: 'offline-test-token', dataSourceId: 'replace-me' });
const fromText = huntClient.summarize({
  id: 's1',
  url: 'https://notion.so/s1',
  properties: {
    Company: { rich_text: [{ plain_text: 'Acme' }] },
    Role: { rich_text: [{ plain_text: 'Engineer' }] },
    Score: { rich_text: [{ plain_text: '4.2/5' }], number: 9 },
    URL: { url: 'https://x.test/1' },
    Status: { select: { name: 'Interview' } },
  },
});
if (fromText.score === '4.2/5' && fromText.role === 'Engineer') pass('summarize prefers Score rich_text');
else fail(`summarize rich_text: ${JSON.stringify(fromText)}`);

const fromNum = huntClient.summarize({
  id: 's2',
  url: 'https://notion.so/s2',
  properties: { Score: { number: 4.2 } },
});
if (fromNum.score === 4.2) pass('summarize falls back to Score number');
else fail(`summarize number: ${JSON.stringify(fromNum)}`);

await (async () => {
  const client = mockClient([
    { id: 'p1', company: 'Acme', role: 'Engineer', status: 'Interview', score: 4, url: 'https://x.test/1', notes: '' },
  ]);
  const pushResult = await huntPushRows(
    [{ company: 'Acme', role: 'Engineer', score: '4.5/5', status: 'Approved', notes: '', url: 'https://x.test/1' }],
    client,
    { dryRun: false },
  );
  if (pushResult.updated === 1) {
    const row = (await client.findRecords())[0];
    if (row.status === 'Interview') pass('push preserves existing Notion Status');
    else fail(`status overwritten to ${row.status}`);
  } else fail(`push update count ${JSON.stringify(pushResult)}`);

  const trackerRows = [{ num: 1, company: 'Beta', role: 'Lead', status: 'Evaluated', notes: '', url: '' }];
  const notionRows = [{ company: 'Beta', role: 'Lead', status: 'Evaluated', notes: 'notion-status=Shortlisted' }];
  const planned = planHuntPullUpdates(trackerRows, notionRows);
  if (planned.length === 1 && planned[0].to === 'Shortlisted') pass('pull plan maps workflow note');
  else fail(`pull plan: ${JSON.stringify(planned)}`);
})();

const readDir = mkdtempSync(join(tmpdir(), 'co-hunt-'));
mkdirSync(join(readDir, 'data'), { recursive: true });
writeFileSync(
  join(readDir, 'data', 'applications.md'),
  `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
| 1 | 2026-10-01 | Gamma | PM | 4.0/5 | Evaluated | ❌ | | https://jobs.test/g |
`,
);
process.env.CAREER_OPS_ROOT = readDir;
const read = readTrackerRowsForHunt(readDir);
if (read.length === 1 && read[0].url.includes('jobs.test')) pass('readTrackerRowsForHunt + URL from notes');
else fail(`tracker read: ${JSON.stringify(read)}`);
delete process.env.CAREER_OPS_ROOT;
rmSync(readDir, { recursive: true, force: true });

const sb = makePullSandbox('Evaluated');
try {
  const pullResults = applyHuntPullUpdates(
    [{ num: 1, to: 'Applied', company: 'Acme', role: 'Engineer' }],
    sb.dir,
    { trackerLock: sb.lock },
  );
  if (pullResults[0]?.ok) pass('notion-hunt-pull sets Applied from Evaluated');
  else fail(`notion-hunt-pull failed: ${JSON.stringify(pullResults)}`);

  const trackerAfter = readFileSync(join(sb.dir, 'data', 'applications.md'), 'utf-8');
  if (/Applied/.test(trackerAfter)) pass('tracker shows Applied after notion-hunt-pull');
  else fail('tracker not updated to Applied');

  const manualSb = makePullSandbox('Evaluated');
  try {
    const manual = runSetStatus(['--row', '1', 'Applied'], manualSb);
    if (manual.code !== 0 && /Approved/.test(manual.stderr + manual.stdout)) {
      pass('manual set-status Applied still blocked without Approved');
    } else fail(`manual Applied should fail from Evaluated: code=${manual.code}`);
  } finally {
    rmSync(manualSb.dir, { recursive: true, force: true });
  }
} finally {
  rmSync(sb.dir, { recursive: true, force: true });
}
