// @ts-check
/**
 * files-pack.mjs — inline Files database under one Hunt job page.
 *
 *   node plugins.mjs run notion files-pack --hunt-page-id <uuid> --report <md> --jd <md> [--pdf <file> ...] [--ah <md>] [--hub <md>] [--tracker <file>] [--dry-run]
 *
 * Shape (Name title, Kind select, Ready checkbox, Summary text):
 *   hub | A–H | report | JD | PDF | tracker
 * PDF may appear twice (tailored + master). Rows are idempotent by Kind + Name.
 *
 * Dry-run reads local files and prints the plan. It does not load .env and
 * does not call Notion. Live writes are parented: the database under the hunt
 * page, each row under that database. This command never writes Status.
 */

import { existsSync, readFileSync, statSync, mkdtempSync, writeFileSync, rmSync } from 'fs';
import { basename, extname, join } from 'path';
import { tmpdir } from 'os';
import { createNotionClient, plain, rich } from './_notion.mjs';
import { loadDotenvOnce } from '../_engine.mjs';
import { isMainModule } from '../../lib/is-main-module.mjs';

const NOTION_VERSION = '2025-09-03';
const SINGLE_PART_MAX = 20 * 1024 * 1024;

/** Kind select values. A–H uses an en dash (U+2013), matching the Files shape. */
export const KIND_HUB = 'hub';
export const KIND_AH = 'A\u2013H';
export const KIND_REPORT = 'report';
export const KIND_JD = 'JD';
export const KIND_PDF = 'PDF';
export const KIND_TRACKER = 'tracker';

export const FILES_DB_TITLE = 'Files';
export const FILES_KIND_OPTIONS = [KIND_HUB, KIND_REPORT, KIND_JD, KIND_PDF, KIND_AH, KIND_TRACKER];

const NAME_HUB = 'Hub';
const NAME_AH = KIND_AH;
const NAME_REPORT = 'Report';
const NAME_JD = 'JD capture';
const NAME_TAILORED = 'Tailored PDF';
const NAME_MASTER = 'Master CV';
const NAME_TRACKER = 'Tracker';

export const USAGE = `Usage: node plugins.mjs run notion files-pack --hunt-page-id <uuid> --report <path> --jd <path> [options]

Create or update an inline Files database under one Hunt job page, then attach
the report, JD, and any CV files you pass. Repeat --pdf for a tailored CV and
a master CV. Dry-run prints the rows and does not call Notion.

Options:
  --pdf <path>       CV file (repeatable). Kind is PDF.
  --ah <path>        A–H markdown to attach
  --hub <path>       Hub markdown to attach
  --tracker <path>   Optional tracker extract
  --dry-run          Print planned rows. No token and no Notion calls.
  --selftest         Offline mock checks. No token and no Notion calls.
  --help             Show this help
`;

/**
 * @param {string} id
 * @returns {string}
 */
export function normalizeNotionId(id) {
  return String(id || '').replace(/-/g, '').toLowerCase();
}

/**
 * @param {string} hex 32 hex chars
 * @returns {string}
 */
function dashedId(hex) {
  const h = hex.toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Accept a dashed UUID, 32 hex chars, or a Notion URL that contains one.
 * @param {string} raw
 * @returns {string}
 */
export function parseHuntPageId(raw) {
  const s = String(raw || '').trim();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return s.toLowerCase();
  if (/^[0-9a-f]{32}$/i.test(s)) return dashedId(s);
  if (/notion\.(so|com)/i.test(s)) {
    const m = s.replace(/-/g, '').match(/([0-9a-f]{32})/i);
    if (m) return dashedId(m[1]);
  }
  throw new Error('--hunt-page-id must be a Notion page id (the hunt job page).');
}

/**
 * @param {string[]} argv
 */
export function parseFilesPackArgs(argv) {
  const out = {
    help: false,
    selftest: false,
    dryRun: false,
    huntPageId: '',
    report: '',
    jd: '',
    pdfs: /** @type {string[]} */ ([]),
    ah: '',
    hub: '',
    tracker: '',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const take = (name) => {
      if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) throw new Error(`${name} needs a value`);
      i += 1;
      return v;
    };
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--selftest') out.selftest = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--hunt-page-id' || a.startsWith('--hunt-page-id=')) out.huntPageId = take('--hunt-page-id');
    else if (a === '--report' || a.startsWith('--report=')) out.report = take('--report');
    else if (a === '--jd' || a.startsWith('--jd=')) out.jd = take('--jd');
    else if (a === '--pdf' || a.startsWith('--pdf=')) out.pdfs.push(take('--pdf'));
    else if (a === '--ah' || a.startsWith('--ah=')) out.ah = take('--ah');
    else if (a === '--hub' || a.startsWith('--hub=')) out.hub = take('--hub');
    else if (a === '--tracker' || a.startsWith('--tracker=')) out.tracker = take('--tracker');
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

/**
 * @param {string} text
 * @returns {string}
 */
function firstScore(text) {
  const m = String(text || '').match(/\*\*Score:\*\*\s*([0-9]+(?:\.[0-9]+)?\/5)/)
    || String(text || '').match(/\bScore:\s*([0-9]+(?:\.[0-9]+)?\/5)/);
  return m ? m[1] : '';
}

/**
 * @param {string} text
 * @returns {string}
 */
export function summarizeHub(text) {
  const score = firstScore(text);
  return score ? `score ${score}` : 'status+score hub line';
}

/**
 * @param {string} text
 * @returns {string}
 */
export function summarizeAh(text) {
  const hits = [];
  for (const letter of 'ABCDEFGH') {
    const re = new RegExp(`(?:^|\\n)#{1,3}\\s*(?:Block\\s+)?${letter}\\b`, 'i');
    if (re.test(String(text || ''))) hits.push(letter);
  }
  if (hits.length) return `A\u2013H evaluation \u00b7 blocks ${hits.join('')}`;
  return 'A\u2013H evaluation summary';
}

/**
 * @param {string} text
 * @returns {string}
 */
export function summarizeReport(text) {
  const score = firstScore(text);
  return score ? `full report \u00b7 ${score}` : 'full report';
}

function oneLine(s) {
  return String(s || '').replace(/[\t\r\n]+/g, ' ').trim();
}

/**
 * @param {string} label
 * @param {string} filePath
 */
/**
 * --pdf is a real PDF. .docx, .md, and .html are refused, in any letter case.
 * @param {string} filePath
 */
export function assertPdfExtension(filePath) {
  const ext = extname(String(filePath || ''));
  if (ext.toLowerCase() !== '.pdf') {
    const shown = ext || '(no extension)';
    throw new Error(`--pdf must be a .pdf file (${shown}): ${filePath}`);
  }
}

function assertReadableFile(label, filePath) {
  if (!filePath) throw new Error(`${label} path is required`);
  if (!existsSync(filePath)) throw new Error(`${label} file not found: ${filePath}`);
  const st = statSync(filePath);
  if (!st.isFile()) throw new Error(`${label} is not a file: ${filePath}`);
  if (st.size > SINGLE_PART_MAX) throw new Error(`${label} is over 20MB (single-part upload only): ${filePath}`);
}

/**
 * @param {string} filePath
 * @param {number} index
 * @param {number} total
 */
function guessPdfName(filePath, index, total) {
  const lower = basename(filePath).toLowerCase();
  if (lower.includes('master')) return NAME_MASTER;
  if (lower.includes('tailor')) return NAME_TAILORED;
  if (total === 1 || index === 0) return NAME_TAILORED;
  if (index === 1) return NAME_MASTER;
  return `PDF ${index + 1}`;
}

/**
 * @param {string[]} paths
 * @returns {Array<{ path: string, name: string }>}
 */
export function namePdfRows(paths) {
  const prelim = paths.map((p, i) => ({ path: p, name: guessPdfName(p, i, paths.length) }));
  const counts = new Map();
  for (const row of prelim) counts.set(row.name, (counts.get(row.name) || 0) + 1);
  const seen = new Map();
  return prelim.map((row) => {
    if ((counts.get(row.name) || 0) < 2) return row;
    const n = (seen.get(row.name) || 0) + 1;
    seen.set(row.name, n);
    if (n === 1) return row;
    return { ...row, name: `${row.name} (${basename(row.path)})` };
  });
}

/**
 * @param {string} filePath
 * @param {Set<string>} used
 */
function claimUploadName(filePath, used) {
  const base = basename(filePath);
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  const ext = extname(base);
  const stem = basename(base, ext);
  let n = 2;
  let candidate = `${stem}-${n}${ext}`;
  while (used.has(candidate)) {
    n += 1;
    candidate = `${stem}-${n}${ext}`;
  }
  used.add(candidate);
  return candidate;
}

/**
 * @param {string} filename
 */
export function contentTypeFor(filename) {
  const ext = extname(filename).toLowerCase();
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.md' || ext === '.markdown') return 'text/markdown';
  if (ext === '.txt') return 'text/plain';
  if (ext === '.docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  return 'application/octet-stream';
}

/**
 * @param {{ huntPageId: string, report: string, jd: string, pdfs?: string[], ah?: string, hub?: string, tracker?: string }} input
 */
export function planFilesPack(input) {
  const huntPageId = parseHuntPageId(input.huntPageId);
  assertReadableFile('report', input.report);
  assertReadableFile('JD', input.jd);
  const optional = [
    ['A–H', input.ah || ''],
    ['hub', input.hub || ''],
    ['tracker', input.tracker || ''],
  ];
  for (const [label, p] of optional) {
    if (p) assertReadableFile(label, p);
  }
  const pdfs = input.pdfs || [];
  for (const p of pdfs) {
    assertPdfExtension(p);
    assertReadableFile('PDF', p);
  }

  const reportText = readFileSync(input.report, 'utf8');
  const usedNames = new Set();
  /** @type {Array<{ name: string, kind: string, ready: boolean, summary: string, file: string, uploadName: string }>} */
  const rows = [];
  const push = (name, kind, summary, file) => {
    rows.push({
      name,
      kind,
      ready: true,
      summary: oneLine(summary),
      file: file || '',
      uploadName: file ? claimUploadName(file, usedNames) : '',
    });
  };

  push(NAME_HUB, KIND_HUB, summarizeHub(reportText), input.hub || '');
  push(NAME_AH, KIND_AH, summarizeAh(reportText), input.ah || '');
  push(NAME_REPORT, KIND_REPORT, summarizeReport(reportText), input.report);
  push(NAME_JD, KIND_JD, 'JD capture', input.jd);
  for (const pdf of namePdfRows(pdfs)) {
    const summary = pdf.name === NAME_MASTER || pdf.name.startsWith(`${NAME_MASTER} `)
      ? 'master CV ref'
      : 'tailored CV PDF';
    push(pdf.name, KIND_PDF, summary, pdf.path);
  }
  if (input.tracker) push(NAME_TRACKER, KIND_TRACKER, 'tracker', input.tracker);

  return { huntPageId, rows };
}

/**
 * @param {object} body
 * @param {'page_id' | 'data_source_id'} type
 */
function assertHasParent(body, type) {
  const p = body?.parent;
  if (!p || typeof p.type !== 'string' || p.type === 'workspace') {
    throw new Error('refusing a Notion write with no parent');
  }
  if (p.type !== type) throw new Error(`refusing Notion parent type ${p.type}`);
  if (type === 'page_id' && !p.page_id) throw new Error('refusing a Notion write with no parent');
  if (type === 'data_source_id' && !p.data_source_id) throw new Error('refusing a Notion write with no parent');
}

/**
 * @param {object | undefined} properties
 */
function assertNoStatus(properties) {
  if (properties && Object.prototype.hasOwnProperty.call(properties, 'Status')) {
    throw new Error('files-pack must not write Status');
  }
}

/**
 * @param {string} huntPageId
 */
export function filesDatabaseCreateBody(huntPageId) {
  const body = {
    parent: { type: 'page_id', page_id: huntPageId },
    title: [{ type: 'text', text: { content: FILES_DB_TITLE } }],
    is_inline: true,
    initial_data_source: {
      properties: {
        Name: { title: {} },
        Kind: { select: { options: FILES_KIND_OPTIONS.map((name) => ({ name })) } },
        Ready: { checkbox: {} },
        Summary: { rich_text: {} },
      },
    },
  };
  assertHasParent(body, 'page_id');
  return body;
}

/**
 * @param {object} block
 * @returns {string}
 */
export function childDatabaseTitle(block) {
  const t = block?.child_database?.title;
  if (typeof t === 'string') return t.trim();
  if (Array.isArray(t)) return t.map((x) => x.plain_text || x.text?.content || '').join('').trim();
  return '';
}

/**
 * @param {object} block
 * @returns {string}
 */
export function fileBlockName(block) {
  if (block?.type !== 'file') return '';
  const f = block.file;
  if (f && typeof f.name === 'string') return f.name;
  return '';
}

/**
 * @param {{ api: Function }} client
 * @param {string} blockId
 */
async function listChildren(client, blockId) {
  const out = [];
  let cursor = '';
  do {
    const q = cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : '';
    const j = await client.api(`blocks/${blockId}/children?page_size=100${q}`, 'GET');
    out.push(...(j.results || []));
    cursor = j.has_more && j.next_cursor ? j.next_cursor : '';
  } while (cursor);
  return out;
}

/**
 * @param {object | undefined} props
 */
function schemaPatch(props) {
  const have = props || {};
  /** @type {Record<string, object>} */
  const patch = {};
  const expect = { Name: 'title', Kind: 'select', Ready: 'checkbox', Summary: 'rich_text' };
  for (const [name, type] of Object.entries(expect)) {
    const cur = have[name];
    if (!cur) {
      if (name === 'Name') throw new Error('Files database has no Name title property');
      if (name === 'Kind') patch.Kind = { select: { options: FILES_KIND_OPTIONS.map((n) => ({ name: n })) } };
      else if (name === 'Ready') patch.Ready = { checkbox: {} };
      else patch.Summary = { rich_text: {} };
      continue;
    }
    if (cur.type !== type) throw new Error(`Files property ${name} is ${cur.type}, expected ${type}`);
  }
  if (have.Kind?.type === 'select') {
    const options = have.Kind.select?.options || [];
    const names = new Set(options.map((o) => o.name));
    const missing = FILES_KIND_OPTIONS.filter((n) => !names.has(n));
    if (missing.length) {
      patch.Kind = {
        select: {
          options: [
            ...options.map((o) => ({ name: o.name, ...(o.id ? { id: o.id } : {}), ...(o.color ? { color: o.color } : {}) })),
            ...missing.map((name) => ({ name })),
          ],
        },
      };
    }
  }
  return patch;
}

/**
 * @param {{ api: Function }} client
 * @param {string} dataSourceId
 */
async function ensureSchema(client, dataSourceId) {
  const ds = await client.api(`data_sources/${dataSourceId}`, 'GET');
  const patch = schemaPatch(ds.properties);
  if (Object.keys(patch).length) await client.api(`data_sources/${dataSourceId}`, 'PATCH', { properties: patch });
}

/**
 * @param {{ api: Function }} client
 * @param {string} huntPageId
 */
async function ensureFilesDatabase(client, huntPageId) {
  const children = await listChildren(client, huntPageId);
  const found = children.filter((b) => b.type === 'child_database' && childDatabaseTitle(b) === FILES_DB_TITLE);
  if (found.length) {
    const db = await client.api(`databases/${found[0].id}`, 'GET');
    const parentId = db?.parent?.page_id;
    if (!parentId || normalizeNotionId(parentId) !== normalizeNotionId(huntPageId)) {
      throw new Error('refusing a Files database whose parent is not the hunt page');
    }
    const dsId = db.data_sources?.[0]?.id;
    if (!dsId) throw new Error('Files database has no data source');
    await ensureSchema(client, dsId);
    return { id: found[0].id, dataSourceId: dsId, created: false };
  }
  const body = filesDatabaseCreateBody(huntPageId);
  const created = await client.api('databases', 'POST', body);
  const parentId = created?.parent?.page_id;
  if (!parentId || normalizeNotionId(parentId) !== normalizeNotionId(huntPageId) || created.parent?.type !== 'page_id') {
    throw new Error('refusing a Files database whose parent is not the hunt page');
  }
  const dsId = created.data_sources?.[0]?.id;
  if (!dsId) throw new Error('created Files database returned no data source');
  await ensureSchema(client, dsId);
  return { id: created.id, dataSourceId: dsId, created: true };
}

/**
 * @param {{ api: Function }} client
 * @param {string} dataSourceId
 */
async function listRows(client, dataSourceId) {
  const all = [];
  let cursor = '';
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const j = await client.api(`data_sources/${dataSourceId}/query`, 'POST', body);
    all.push(...(j.results || []));
    cursor = j.has_more && j.next_cursor ? j.next_cursor : '';
  } while (cursor);
  return all;
}

/**
 * Notion reads return plain_text. A write payload only has text.content.
 * Match on either so a repeat pack finds the row it just created.
 * @param {object | undefined} prop
 * @returns {string}
 */
function readPropText(prop) {
  const direct = plain(prop).trim();
  if (direct) return direct;
  const items = prop?.title || prop?.rich_text || [];
  return items.map((t) => t.plain_text || t.text?.content || '').join('').trim();
}

/**
 * @param {object} row
 */
function rowProperties(row) {
  const properties = {
    Name: { title: rich(row.name) },
    Kind: { select: { name: row.kind } },
    Ready: { checkbox: row.ready === true },
    Summary: { rich_text: rich(row.summary) },
  };
  assertNoStatus(properties);
  return properties;
}

/**
 * @param {{ api: Function, sendUpload: Function }} client
 * @param {string} pageId
 * @param {{ file: string, uploadName: string }} row
 */
async function attachFile(client, pageId, row) {
  if (!row.file) return 'no';
  const filename = row.uploadName || basename(row.file);
  const kids = await listChildren(client, pageId);
  if (kids.some((b) => fileBlockName(b) === filename)) return 'skip';
  const bytes = readFileSync(row.file);
  if (bytes.length > SINGLE_PART_MAX) throw new Error(`${filename} is over 20MB (single-part upload only)`);
  const contentType = contentTypeFor(filename);
  const upload = await client.api('file_uploads', 'POST', {
    mode: 'single_part',
    filename,
    content_type: contentType,
  });
  if (!upload?.id) throw new Error(`file upload for ${filename} returned no id`);
  const sent = await client.sendUpload(upload.id, filename, bytes, contentType);
  if (sent?.status && sent.status !== 'uploaded') throw new Error(`file upload ${filename} status ${sent.status}`);
  const childrenBody = {
    children: [{
      type: 'file',
      file: {
        type: 'file_upload',
        file_upload: { id: upload.id },
        name: filename,
      },
    }],
  };
  await client.api(`blocks/${pageId}/children`, 'PATCH', childrenBody);
  return 'upload';
}

/**
 * @param {{ huntPageId: string, rows: Array<object> }} plan
 * @param {{ dryRun: boolean, client?: { api: Function, sendUpload?: Function } }} opts
 */
export async function packFiles(plan, opts) {
  const planned = plan.rows.map((row) => ({
    name: row.name,
    kind: row.kind,
    ready: row.ready === true,
    summary: row.summary,
    file: row.file || '',
    uploadName: row.uploadName || '',
    action: 'plan',
    attached: row.file ? 'would-upload' : 'no',
  }));
  if (opts.dryRun) {
    return { dryRun: true, parent: plan.huntPageId, notion: false, database: { created: false, ensured: true }, rows: planned };
  }
  if (!opts.client) throw new Error('live files-pack needs a Notion client');
  const db = await ensureFilesDatabase(opts.client, plan.huntPageId);
  const existing = await listRows(opts.client, db.dataSourceId);
  const rows = [];
  for (const row of plan.rows) {
    const properties = rowProperties(row);
    const match = existing.find((page) => {
      const kind = page.properties?.Kind?.select?.name || '';
      const name = readPropText(page.properties?.Name);
      return kind === row.kind && name === row.name;
    });
    let pageId;
    let action;
    if (match) {
      assertNoStatus(properties);
      await opts.client.api(`pages/${match.id}`, 'PATCH', { properties });
      pageId = match.id;
      action = 'update';
    } else {
      const body = { parent: { type: 'data_source_id', data_source_id: db.dataSourceId }, properties };
      assertHasParent(body, 'data_source_id');
      const created = await opts.client.api('pages', 'POST', body);
      if (created?.parent && created.parent.type !== 'data_source_id') {
        throw new Error('Notion created a Files row without a data source parent');
      }
      pageId = created.id;
      action = 'create';
      existing.push({ id: pageId, properties });
    }
    const attached = await attachFile(opts.client, pageId, row);
    rows.push({
      name: row.name,
      kind: row.kind,
      ready: row.ready === true,
      summary: row.summary,
      file: row.file || '',
      uploadName: row.uploadName || '',
      action,
      attached,
    });
  }
  return {
    dryRun: false,
    parent: plan.huntPageId,
    notion: true,
    database: { created: db.created, id: db.id, dataSourceId: db.dataSourceId, ensured: true },
    rows,
  };
}

/**
 * @param {{ token: string, fetch?: Function, sleepMs?: number }} cfg
 */
export function createFilesPackClient(cfg) {
  if (!cfg.token) throw new Error('NOTION_ACCESS_TOKEN is not set. Add --dry-run to preview without it.');
  const sleepMs = cfg.sleepMs ?? 360;
  const fetchFn = cfg.fetch || globalThis.fetch;
  const notion = createNotionClient({
    token: cfg.token,
    parent: 'files-pack-parent-is-the-hunt-page',
    fetch: fetchFn,
    sleepMs,
  });
  return {
    api: notion.api,
    async sendUpload(uploadId, filename, bytes, contentType) {
      if (sleepMs > 0) await new Promise((r) => setTimeout(r, sleepMs));
      const form = new FormData();
      form.append('file', new Blob([bytes], { type: contentType }), filename);
      const res = await fetchFn(`https://api.notion.com/v1/file_uploads/${encodeURIComponent(uploadId)}/send`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.token}`,
          'Notion-Version': NOTION_VERSION,
        },
        body: form,
      });
      const j = await res.json();
      if (!res.ok) throw new Error(`Notion POST file_uploads/${uploadId}/send -> ${j.code}: ${j.message}`);
      return j;
    },
  };
}

/**
 * @param {object} result
 */
export function formatFilesPackResult(result) {
  const lines = [
    result.dryRun ? 'files-pack dry-run' : 'files-pack',
    `parent: ${result.parent}`,
    `database: ${result.dryRun ? 'ensure inline Files' : (result.database?.created ? 'created' : 'existing')}`,
    `notion: ${result.notion ? 'yes' : 'no'}`,
  ];
  for (const row of result.rows) {
    lines.push([
      'row',
      `name=${row.name}`,
      `kind=${row.kind}`,
      `ready=${row.ready ? 'true' : 'false'}`,
      `summary=${row.summary}`,
      `file=${row.file || ''}`,
      `action=${row.action}`,
      `attached=${row.attached}`,
    ].join('\t'));
  }
  const slim = {
    dryRun: result.dryRun,
    parent: result.parent,
    notion: result.notion,
    database: result.database?.created === true ? 'created' : (result.dryRun ? 'ensure' : 'existing'),
    rows: result.rows.map((row) => ({
      name: row.name,
      kind: row.kind,
      ready: row.ready,
      summary: row.summary,
      file: row.file || '',
      action: row.action,
      attached: row.attached,
    })),
  };
  lines.push(`FILES_PACK_PLAN ${JSON.stringify(slim)}`);
  return lines.join('\n');
}

/**
 * In-memory Notion for tests. Records every call. Never uses the network.
 * @param {{ huntPageId: string, seedDb?: boolean, properties?: object }} seed
 */
export function createMemoryNotionFetch(seed) {
  /** @type {Array<{ url: string, method: string, body: any, headers: object, isForm: boolean }>} */
  const calls = [];
  let db = null;
  let seq = 1;
  const pages = [];
  const uploads = new Map();
  if (seed.seedDb) {
    db = {
      id: 'db-seed',
      parent: { type: 'page_id', page_id: seed.huntPageId },
      is_inline: true,
      dataSourceId: 'ds-seed',
      properties: seed.properties || {},
    };
  }

  function materialize(props) {
    const out = {};
    for (const [name, def] of Object.entries(props || {})) {
      if (def.title || def.type === 'title') out[name] = { type: 'title', title: {} };
      else if (def.select || def.type === 'select') out[name] = { type: 'select', select: def.select || { options: [] } };
      else if (def.checkbox || def.type === 'checkbox') out[name] = { type: 'checkbox', checkbox: {} };
      else if (def.rich_text || def.type === 'rich_text') out[name] = { type: 'rich_text', rich_text: {} };
      else out[name] = def;
    }
    return out;
  }

  function readShape(props) {
    const out = {};
    for (const [name, def] of Object.entries(props || {})) {
      const copy = { ...def };
      for (const key of ['title', 'rich_text']) {
        if (Array.isArray(copy[key])) {
          copy[key] = copy[key].map((t) => ({
            ...t,
            plain_text: t.plain_text ?? t.text?.content ?? '',
          }));
        }
      }
      out[name] = copy;
    }
    return out;
  }

  function jsonResponse(obj, ok = true) {
    return {
      ok,
      status: ok ? 200 : 400,
      json: async () => obj,
      text: async () => JSON.stringify(obj),
    };
  }

  const fetchFn = async (url, opts = {}) => {
    const method = opts.method || 'GET';
    let body = null;
    const isForm = Boolean(opts.body) && typeof opts.body !== 'string';
    if (typeof opts.body === 'string') body = JSON.parse(opts.body);
    calls.push({ url, method, body, headers: opts.headers || {}, isForm });
    const path = decodeURIComponent(new URL(url).pathname.replace(/^\/v1\//, ''));

    const child = path.match(/^blocks\/([^/]+)\/children/);
    if (child && method === 'GET') {
      const id = child[1];
      if (db && normalizeNotionId(id) === normalizeNotionId(seed.huntPageId)) {
        return jsonResponse({
          results: [{ id: db.id, type: 'child_database', child_database: { title: FILES_DB_TITLE } }],
          has_more: false,
        });
      }
      const page = pages.find((p) => normalizeNotionId(p.id) === normalizeNotionId(id));
      const results = (page?.files || []).map((f) => ({
        type: 'file',
        file: { name: f.name, type: 'file', file: { url: 'https://example.invalid/file' } },
      }));
      return jsonResponse({ results, has_more: false });
    }
    if (child && method === 'PATCH') {
      const page = pages.find((p) => normalizeNotionId(p.id) === normalizeNotionId(child[1]));
      if (!page) return jsonResponse({ code: 'object_not_found', message: 'missing block' }, false);
      for (const c of body?.children || []) {
        if (c.type === 'file') page.files.push({ name: c.file?.name || 'file' });
      }
      return jsonResponse({ results: [] });
    }
    if (path === 'databases' && method === 'POST') {
      if (!body?.parent?.page_id) return jsonResponse({ code: 'validation_error', message: 'parent required' }, false);
      const dsId = `ds-${seq}`;
      db = {
        id: `db-${seq}`,
        parent: body.parent,
        is_inline: body.is_inline === true,
        dataSourceId: dsId,
        properties: body.initial_data_source?.properties || {},
      };
      seq += 1;
      return jsonResponse({
        id: db.id,
        is_inline: db.is_inline,
        parent: db.parent,
        data_sources: [{ id: dsId, name: FILES_DB_TITLE }],
      });
    }
    const dbGet = path.match(/^databases\/([^/]+)$/);
    if (dbGet && method === 'GET') {
      if (!db || normalizeNotionId(db.id) !== normalizeNotionId(dbGet[1])) {
        return jsonResponse({ code: 'object_not_found', message: 'missing db' }, false);
      }
      return jsonResponse({
        id: db.id,
        parent: db.parent,
        is_inline: db.is_inline,
        data_sources: [{ id: db.dataSourceId }],
      });
    }
    const ds = path.match(/^data_sources\/([^/]+)$/);
    if (ds && method === 'GET') {
      if (!db) return jsonResponse({ code: 'object_not_found', message: 'missing data source' }, false);
      return jsonResponse({ id: db.dataSourceId, properties: materialize(db.properties) });
    }
    if (ds && method === 'PATCH') {
      db.properties = { ...db.properties, ...(body?.properties || {}) };
      return jsonResponse({ id: db.dataSourceId, properties: materialize(db.properties) });
    }
    const query = path.match(/^data_sources\/([^/]+)\/query$/);
    if (query && method === 'POST') {
      const results = pages
        .filter((p) => normalizeNotionId(p.dataSourceId) === normalizeNotionId(query[1]))
        .map((p) => ({
          id: p.id,
          properties: readShape(p.properties),
          parent: { type: 'data_source_id', data_source_id: p.dataSourceId },
        }));
      return jsonResponse({ results, has_more: false });
    }
    if (path === 'pages' && method === 'POST') {
      if (!body?.parent?.data_source_id) return jsonResponse({ code: 'validation_error', message: 'parent required' }, false);
      const id = `page-${seq}`;
      seq += 1;
      pages.push({ id, dataSourceId: body.parent.data_source_id, properties: body.properties, files: [] });
      return jsonResponse({ id, parent: body.parent });
    }
    const pagePatch = path.match(/^pages\/([^/]+)$/);
    if (pagePatch && method === 'PATCH') {
      const page = pages.find((p) => normalizeNotionId(p.id) === normalizeNotionId(pagePatch[1]));
      if (!page) return jsonResponse({ code: 'object_not_found', message: 'missing page' }, false);
      page.properties = { ...page.properties, ...(body?.properties || {}) };
      return jsonResponse({ id: page.id });
    }
    if (path === 'file_uploads' && method === 'POST') {
      const id = `up-${seq}`;
      seq += 1;
      uploads.set(id, { filename: body?.filename, status: 'pending' });
      return jsonResponse({ id, status: 'pending', filename: body?.filename });
    }
    const send = path.match(/^file_uploads\/([^/]+)\/send$/);
    if (send && method === 'POST') {
      const up = uploads.get(send[1]);
      if (!up) return jsonResponse({ code: 'object_not_found', message: 'missing upload' }, false);
      up.status = 'uploaded';
      return jsonResponse({ id: send[1], status: 'uploaded' });
    }
    return jsonResponse({ code: 'validation_error', message: `unhandled ${method} ${path}` }, false);
  };

  return { fetch: fetchFn, calls, pages: () => pages, db: () => db };
}

function statusWrites(calls) {
  return calls.filter((c) => c.body?.properties && Object.prototype.hasOwnProperty.call(c.body.properties, 'Status'));
}

/**
 * Offline proof: dry-run never fetches; a mocked live run parents every write,
 * skips Status, and a second run does not duplicate rows or files.
 * @returns {Promise<{ ok: boolean, errors: string[] }>}
 */
export async function runFilesPackSelftest() {
  const errors = [];
  const check = (cond, msg) => { if (!cond) errors.push(msg); };
  const dir = mkdtempSync(join(tmpdir(), 'files-pack-'));
  const hunt = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  try {
    const report = join(dir, 'report.md');
    const jd = join(dir, 'jd.md');
    const ah = join(dir, 'ah.md');
    const hub = join(dir, 'hub.md');
    const tailored = join(dir, 'tailored.pdf');
    const master = join(dir, 'master-cv.pdf');
    writeFileSync(report, '# Report\n\n**Score:** 4.2/5\n\n## Block A\nfit\n## Block B\nproof\n');
    writeFileSync(jd, '# Job description\n\nBuild things.\n');
    writeFileSync(ah, '# A-H\n');
    writeFileSync(hub, '# Hub\n');
    writeFileSync(tailored, '%PDF-1.1\n');
    writeFileSync(master, '%PDF-1.1\n');
    const notPdf = join(dir, 'tailored.DOCX');
    writeFileSync(notPdf, 'PK');
    const upperPdf = join(dir, 'MASTER.PDF');
    writeFileSync(upperPdf, '%PDF-1.1\n');
    let refusedDocx = false;
    try {
      planFilesPack({ huntPageId: hunt, report, jd, pdfs: [notPdf] });
    } catch (err) {
      refusedDocx = err instanceof Error && /must be a \.pdf file/i.test(err.message);
    }
    check(refusedDocx, 'docx was accepted as --pdf');
    const upperPlan = planFilesPack({ huntPageId: hunt, report, jd, pdfs: [upperPdf] });
    check(upperPlan.rows.some((r) => r.kind === KIND_PDF && r.file === upperPdf), '.PDF extension was refused');

    let fetched = false;
    const plan = planFilesPack({
      huntPageId: hunt,
      report,
      jd,
      pdfs: [tailored, master],
      ah,
      hub,
    });
    const dry = await packFiles(plan, {
      dryRun: true,
      client: {
        api() { fetched = true; throw new Error('dry-run called Notion'); },
        sendUpload() { fetched = true; throw new Error('dry-run uploaded'); },
      },
    });
    check(fetched === false, 'dry-run called the client');
    check(dry.notion === false, 'dry-run set notion');
    check(dry.rows.length === 6, `dry-run row count ${dry.rows.length}`);
    check(dry.rows.filter((r) => r.kind === KIND_PDF).length === 2, 'expected two PDF rows');
    check(dry.rows.some((r) => r.kind === KIND_AH && r.name === KIND_AH), 'A–H row missing en dash');
    check(dry.rows.find((r) => r.kind === KIND_HUB)?.summary === 'score 4.2/5', 'hub summary');
    check(!FILES_KIND_OPTIONS.includes('A-H'), 'hyphen kind must not be in the schema');
    check(FILES_KIND_OPTIONS.includes(KIND_AH), 'en-dash kind missing');

    const memory = createMemoryNotionFetch({ huntPageId: hunt });
    const client = createFilesPackClient({ token: 'offline-test-token', fetch: memory.fetch, sleepMs: 0 });
    const live = await packFiles(plan, { dryRun: false, client });
    check(live.database?.created === true, 'first run should create the database');
    check(live.rows.filter((r) => r.action === 'create').length === 6, 'first run should create 6 rows');
    check(live.rows.filter((r) => r.attached === 'upload').length === 6, 'first run should upload 6 files');

    const again = await packFiles(plan, { dryRun: false, client });
    check(again.database?.created === false, 'second run should reuse the database');
    check(again.rows.every((r) => r.action === 'update'), 'second run should update, not create');
    check(again.rows.every((r) => r.attached === 'skip'), 'second run should not upload again');

    const creates = memory.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/v1/databases'));
    check(creates.length === 1, `database creates ${creates.length}`);
    check(creates[0]?.body?.is_inline === true, 'database should be inline');
    check(creates[0]?.body?.parent?.type === 'page_id', 'database parent type');
    check(normalizeNotionId(creates[0]?.body?.parent?.page_id) === normalizeNotionId(hunt), 'database parent id');

    const pageCreates = memory.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/v1/pages'));
    check(pageCreates.length === 6, `page creates ${pageCreates.length}`);
    check(pageCreates.every((c) => c.body?.parent?.type === 'data_source_id' && c.body.parent.data_source_id), 'page parent');
    check(statusWrites(memory.calls).length === 0, 'Status was written');
    check(memory.calls.every((c) => !String(c.url).includes(`/pages/${hunt}`)), 'hunt page was patched');

    const send = memory.calls.find((c) => c.url.includes('/file_uploads/') && c.url.endsWith('/send'));
    check(Boolean(send), 'file send missing');
    check(send?.isForm === true, 'file send should be multipart');
    check(!send?.headers?.['Content-Type'], 'file send must not force application/json');
    check(String(send?.headers?.Authorization || '').startsWith('Bearer '), 'file send auth');
    check(!JSON.stringify(memory.calls).includes('secret'), 'token leaked into recorded bodies');

    const uploadPosts = memory.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/v1/file_uploads'));
    check(uploadPosts.length === 6, `uploads ${uploadPosts.length} (second run must not add more)`);
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return { ok: errors.length === 0, errors };
}

/**
 * @param {string[]} argv
 * @param {{ loadEnv?: boolean, token?: string, fetch?: Function, sleepMs?: number, log?: (s: string) => void }} [deps]
 * @returns {Promise<number>}
 */
export async function mainFilesPack(argv, deps = {}) {
  const log = deps.log || ((s) => console.log(s));
  try {
    const args = parseFilesPackArgs(argv);
    if (args.help) {
      log(USAGE.trim());
      return 0;
    }
    if (args.selftest) {
      const result = await runFilesPackSelftest();
      if (!result.ok) {
        console.error(`files-pack selftest: failed\n${result.errors.join('\n')}`);
        return 1;
      }
      log('files-pack selftest: ok');
      log('liveNotion: false');
      log('statusWrites: 0');
      log('parentless: 0');
      return 0;
    }
    if (!args.huntPageId || !args.report || !args.jd) {
      console.error(USAGE.trim());
      console.error('files-pack needs --hunt-page-id, --report, and --jd.');
      return 1;
    }
    const plan = planFilesPack({
      huntPageId: args.huntPageId,
      report: args.report,
      jd: args.jd,
      pdfs: args.pdfs,
      ah: args.ah,
      hub: args.hub,
      tracker: args.tracker,
    });
    if (args.dryRun) {
      const result = await packFiles(plan, { dryRun: true });
      log(formatFilesPackResult(result));
      return 0;
    }
    if (deps.loadEnv !== false) await loadDotenvOnce();
    const token = deps.token !== undefined ? deps.token : process.env.NOTION_ACCESS_TOKEN?.trim();
    if (!token) {
      console.error('NOTION_ACCESS_TOKEN is not set. Add --dry-run to preview without Notion.');
      return 1;
    }
    const client = createFilesPackClient({ token, fetch: deps.fetch, sleepMs: deps.sleepMs });
    const result = await packFiles(plan, { dryRun: false, client });
    log(formatFilesPackResult(result));
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

if (isMainModule(import.meta.url)) {
  const code = await mainFilesPack(process.argv.slice(2));
  process.exit(code);
}
