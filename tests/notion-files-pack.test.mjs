/**
 * notion-files-pack.test.mjs — inline Hunt Files pack. Mocked fetch only.
 * No live Notion. Token stays unset for the CLI dry-run.
 */

import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pass, fail, results, ROOT, NODE } from './helpers.mjs';
import { HOOK_KINDS } from '../plugins/_engine.mjs';
import {
  FILES_KIND_OPTIONS,
  KIND_AH,
  KIND_PDF,
  contentTypeFor,
  createFilesPackClient,
  createMemoryNotionFetch,
  filesDatabaseCreateBody,
  mainFilesPack,
  namePdfRows,
  packFiles,
  parseHuntPageId,
  planFilesPack,
  runFilesPackSelftest,
} from '../plugins/notion/files-pack.mjs';

const HUNT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function offlineEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      key === 'NOTION_ACCESS_TOKEN'
      || key === 'NOTION_PARENT_PAGE_ID'
      || key.startsWith('HOSTINGER_')
      || key.startsWith('GTM_')
      || key.startsWith('WP_')
    ) delete env[key];
  }
  return env;
}

function fixtureDir() {
  const dir = mkdtempSync(join(tmpdir(), 'files-pack-test-'));
  const report = join(dir, 'report.md');
  const jd = join(dir, 'jd.md');
  writeFileSync(report, '# Report\n\n**Score:** 4.2/5\n\n## Block A\nfit\n## Block C\nproof\n');
  writeFileSync(jd, '# Job description\n\nText.\n');
  return { dir, report, jd };
}

if (!HOOK_KINDS.includes('files-pack') && HOOK_KINDS.includes('export')) {
  pass('files-pack is not a plugin hook (closed hook set unchanged)');
} else fail(`HOOK_KINDS drifted: ${HOOK_KINDS.join(',')}`);

if (FILES_KIND_OPTIONS.includes('A\u2013H') && !FILES_KIND_OPTIONS.includes('A-H')) {
  pass('Kind A–H uses an en dash');
} else fail(`kind options: ${FILES_KIND_OPTIONS.join('|')}`);

try {
  parseHuntPageId('draft');
  fail('draft hunt page id should be rejected');
} catch {
  pass('rejects a non-id hunt page');
}

if (parseHuntPageId(`https://www.notion.so/${HUNT}`) === HUNT) pass('accepts a Notion URL that contains the page id');
else fail('notion URL id');

const pdfNames = namePdfRows(['cv/tailored.pdf', 'cv/master-cv.docx']);
if (pdfNames[0].name === 'Tailored PDF' && pdfNames[1].name === 'Master CV') pass('PDF names from file names');
else fail(`pdf names: ${JSON.stringify(pdfNames)}`);

const bothMaster = namePdfRows(['master-a.pdf', 'master-b.pdf']);
if (bothMaster[0].name !== bothMaster[1].name) pass('two master files stay distinct rows');
else fail(`collapsed pdf names: ${JSON.stringify(bothMaster)}`);

if (contentTypeFor('a.md') === 'text/markdown' && contentTypeFor('a.pdf') === 'application/pdf') {
  pass('content types for md and pdf');
} else fail('content types');

const body = filesDatabaseCreateBody(HUNT);
if (
  body.is_inline === true
  && body.parent?.type === 'page_id'
  && body.parent.page_id === HUNT
  && body.initial_data_source?.properties?.Summary?.rich_text
  && body.initial_data_source.properties.Kind.select.options.some((o) => o.name === 'A\u2013H')
  && !body.initial_data_source.properties.Status
) pass('create body is an inline Files database under the hunt page');
else fail(`create body: ${JSON.stringify(body)}`);

const fx = fixtureDir();
try {
  const plan = planFilesPack({
    huntPageId: HUNT.replace(/-/g, ''),
    report: fx.report,
    jd: fx.jd,
    pdfs: [],
    tracker: fx.jd,
  });
  const kinds = plan.rows.map((r) => r.kind).join(',');
  if (kinds === `hub,${KIND_AH},report,JD,tracker` && plan.rows.at(-1).name === 'Tracker') {
    pass('plan includes hub, A–H, report, JD, and optional tracker');
  } else fail(`plan kinds: ${kinds}`);
  if (plan.rows[0].summary === 'score 4.2/5' && plan.rows[2].summary.includes('4.2/5')) {
    pass('summaries use the score that is in the report');
  } else fail(`summaries: ${plan.rows.map((r) => r.summary).join(' | ')}`);
  if (plan.rows[1].summary.includes('blocks') && plan.rows[1].summary.includes('A') && plan.rows[1].summary.includes('C')) {
    pass('A–H summary names the blocks present in the report');
  } else fail(`A–H summary: ${plan.rows[1].summary}`);

  let called = false;
  const dry = await packFiles(plan, {
    dryRun: true,
    client: { api() { called = true; throw new Error('network'); }, sendUpload() { called = true; throw new Error('network'); } },
  });
  if (!called && dry.notion === false && dry.rows.length === plan.rows.length) pass('dry-run does not call Notion');
  else fail('dry-run called Notion or dropped rows');

  const savedToken = process.env.NOTION_ACCESS_TOKEN;
  process.env.NOTION_ACCESS_TOKEN = 'should-not-be-used';
  const lines = [];
  const code = await mainFilesPack([
    '--dry-run',
    '--hunt-page-id', HUNT,
    '--report', fx.report,
    '--jd', fx.jd,
  ], {
    loadEnv: false,
    fetch() { called = true; throw new Error('network'); },
    log: (s) => lines.push(s),
  });
  if (savedToken === undefined) delete process.env.NOTION_ACCESS_TOKEN;
  else process.env.NOTION_ACCESS_TOKEN = savedToken;
  if (code === 0 && !called && lines.join('\n').includes('notion: no')) pass('CLI dry-run ignores a set token');
  else fail(`dry-run with token code=${code} called=${called}`);

  const missing = await mainFilesPack(['--hunt-page-id', HUNT, '--report', fx.report, '--jd', fx.jd], {
    loadEnv: false,
    token: '',
    fetch() { throw new Error('live notion'); },
  });
  if (missing === 1) pass('live pack refuses to run without a token');
  else fail(`missing token exit ${missing}`);

  const memory = createMemoryNotionFetch({
    huntPageId: HUNT,
    seedDb: true,
    properties: {
      Name: { title: {} },
      Kind: { select: { options: FILES_KIND_OPTIONS.map((name) => ({ name })) } },
      Ready: { checkbox: {} },
    },
  });
  const client = createFilesPackClient({ token: 'offline-test-token', fetch: memory.fetch, sleepMs: 0 });
  const repaired = await packFiles(plan, { dryRun: false, client });
  const schemaPatch = memory.calls.find((c) => c.method === 'PATCH' && c.url.includes('/data_sources/'));
  if (repaired.database?.created === false && schemaPatch?.body?.properties?.Summary?.rich_text) {
    pass('existing Files database gains a Summary property instead of a second database');
  } else fail('schema repair did not patch Summary');
  if (memory.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/v1/databases')).length === 0) {
    pass('seeded Files database is reused');
  } else fail('created a second database');
  if (memory.calls.some((c) => c.body?.properties?.Status)) fail('Status written during schema repair');
  else pass('schema repair does not write Status');
} finally {
  rmSync(fx.dir, { recursive: true, force: true });
}

try {
  await packFiles({
    huntPageId: HUNT,
    rows: [{ name: 'Hub', kind: 'hub', ready: true, summary: 'x', file: '', uploadName: '' }],
  }, {
    dryRun: false,
    client: {
      async api(path, method) {
        if (method === 'GET' && String(path).startsWith('blocks/')) return { results: [], has_more: false };
        if (method === 'POST' && path === 'databases') return { id: 'db', data_sources: [{ id: 'ds' }] };
        throw new Error(`unexpected ${method} ${path}`);
      },
      async sendUpload() { throw new Error('upload'); },
    },
  });
  fail('parentless database response should throw');
} catch (err) {
  if (/parent/i.test(err.message)) pass('refuses a Files database response with no hunt-page parent');
  else fail(`parentless error: ${err.message}`);
}

const self = await runFilesPackSelftest();
if (self.ok) pass('selftest (mocked fetch, second run is idempotent)');
else fail(`selftest: ${self.errors.join('; ')}`);

const cliDir = fixtureDir();
try {
  const pdf1 = join(cliDir.dir, 'tailored.pdf');
  const pdf2 = join(cliDir.dir, 'master.pdf');
  writeFileSync(pdf1, '%PDF-1.1\n');
  writeFileSync(pdf2, '%PDF-1.1\n');
  const out = execFileSync(NODE, [
    join(ROOT, 'plugins.mjs'),
    'run', 'notion', 'files-pack',
    '--dry-run',
    '--hunt-page-id', HUNT,
    '--report', cliDir.report,
    '--jd', cliDir.jd,
    '--pdf', pdf1,
    '--pdf', pdf2,
  ], { cwd: ROOT, env: offlineEnv(), encoding: 'utf8' });
  const line = out.split('\n').find((l) => l.startsWith('FILES_PACK_PLAN '));
  const parsed = JSON.parse(line.slice('FILES_PACK_PLAN '.length));
  const pdfs = parsed.rows.filter((r) => r.kind === KIND_PDF);
  if (
    parsed.dryRun === true
    && parsed.notion === false
    && parsed.parent === HUNT
    && pdfs.length === 2
    && pdfs[0].name === 'Tailored PDF'
    && pdfs[1].name === 'Master CV'
    && out.includes('notion: no')
    && !/api\.notion\.com/.test(out)
  ) pass('CLI dry-run prints planned rows with the token unset');
  else fail(`CLI dry-run: ${out}`);

  const selfOut = execFileSync(NODE, [
    join(ROOT, 'plugins.mjs'), 'run', 'notion', 'files-pack', '--selftest',
  ], { cwd: ROOT, env: offlineEnv(), encoding: 'utf8' });
  if (selfOut.includes('files-pack selftest: ok') && selfOut.includes('liveNotion: false')) {
    pass('CLI selftest stays offline');
  } else fail(`selftest output: ${selfOut}`);
} catch (err) {
  fail(`CLI spawn: ${err.stderr || err.message}`);
} finally {
  rmSync(cliDir.dir, { recursive: true, force: true });
}

if (results().failed > 0) process.exitCode = 1;
