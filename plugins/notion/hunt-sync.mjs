// @ts-check
/**
 * hunt-sync.mjs — Upsert scored tracker rows to Notion Hunt DS; pull status back.
 *
 * Hunt lane SoT is Notion. Push never patches Status on existing pages.
 * Pull updates disk tracker status (Notion wins).
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { createNotionClient, rich, plain } from './_notion.mjs';
import {
  HUNT_JOBS_DATA_SOURCE_ID,
  assertCreateStatusFromTracker,
  mergeNotionStatusMarker,
  notionRowToTrackerStatus,
  trackerStatusToNotionPush,
} from './hunt-status.mjs';
import { resolveColumns, parseTrackerRow } from '../../tracker-parse.mjs';
import { resolveTrackerPath } from '../../path-resolver.mjs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NODE = process.execPath;

const URL_IN_TEXT_RE = /https?:\/\/[^\s|)\]>]+/i;

/**
 * @param {string} notes
 * @returns {string}
 */
export function extractJobUrl(notes) {
  const m = String(notes ?? '').match(URL_IN_TEXT_RE);
  return m ? m[0].replace(/[),.;]+$/, '') : '';
}

/**
 * @param {string} rootDir
 * @returns {Array<{ num: number, company: string, role: string, score: string, status: string, notes: string, url: string }>}
 */
export function readTrackerRowsForHunt(rootDir) {
  const trackerPath = resolveTrackerPath(rootDir);
  if (!existsSync(trackerPath)) return [];
  const lines = readFileSync(trackerPath, 'utf-8').split('\n');
  const colmap = resolveColumns(lines);
  if (!colmap) return [];
  const rows = [];
  for (const line of lines) {
    const row = parseTrackerRow(line, colmap);
    if (!row) continue;
    const company = String(row.company ?? '').trim();
    const role = String(row.role ?? '').trim();
    if (!company || !role) continue;
    const notes = String(row.notes ?? '').trim();
    rows.push({
      num: row.num,
      company,
      role,
      score: String(row.score ?? '').trim(),
      status: String(row.status ?? '').trim(),
      notes,
      url: extractJobUrl(notes),
    });
  }
  return rows;
}

/**
 * @param {{ token: string, dataSourceId?: string, fetch?: Function }} cfg
 */
export function createHuntNotionClient(cfg) {
  const fromEnv = String(process.env.NOTION_HUNT_DATA_SOURCE_ID ?? '').trim();
  const dataSourceId = String(cfg.dataSourceId || fromEnv || HUNT_JOBS_DATA_SOURCE_ID || '').trim();
  if (!dataSourceId) {
    throw new Error(
      'No Hunt data source id. Set NOTION_HUNT_DATA_SOURCE_ID or pass dataSourceId. See config/hunt.example.yml.',
    );
  }
  const base = createNotionClient({
    token: cfg.token,
    parent: cfg.parent || 'unused-hunt-direct-ds',
    fetch: cfg.fetch,
  });
  return {
    dataSourceId,
    api: base.api,
    createPage: base.createPage,
    queryDB: (id) => base.queryDB(id || dataSourceId),
    findRecords: (match) => base.findRecords(dataSourceId, match),
    summarize: (r) => ({
      id: r.id,
      company: plain(r.properties.Company),
      role: plain(r.properties.Role),
      status: r.properties.Status?.select?.name || '',
      score: readHuntScore(r.properties.Score),
      jobUrl: r.properties.URL?.url || '',
      notes: plain(r.properties.Notes || r.properties.Note || {}),
      url: r.url,
    }),
  };
}

/**
 * Live Hunt Score is rich_text. Older pages may still store a number.
 * @param {object | undefined} prop
 * @returns {string | number | null}
 */
export function readHuntScore(prop) {
  const text = plain({ rich_text: prop?.rich_text }).trim();
  if (text) return text;
  if (prop && prop.number != null) return prop.number;
  return null;
}

/**
 * Title for the live Hunt Name property: "Company — Role", or company alone.
 * @param {{ company?: string, role?: string }} row
 * @returns {string}
 */
function huntPageTitle(row) {
  const company = String(row.company ?? '').trim();
  const role = String(row.role ?? '').trim();
  if (company && role) return `${company} — ${role}`;
  return company || role;
}

/**
 * Build Notion property payload (no Status when updating existing row).
 * Live Hunt DS: Name=title, Role=rich_text, Score=rich_text, URL=url.
 * @param {object} row
 * @param {{ includeStatus: boolean }} opts
 */
export function buildHuntProperties(row, { includeStatus }) {
  const props = {
    Name: { title: rich(huntPageTitle(row)) },
    Role: { rich_text: rich(row.role) },
    Company: { rich_text: rich(row.company) },
  };
  const scoreText = String(row.score ?? '').trim();
  if (scoreText) props.Score = { rich_text: rich(scoreText) };
  if (row.url) props.URL = { url: row.url };

  const notesWithMarker = (() => {
    const { workflowNote } = trackerStatusToNotionPush(row.status);
    return mergeNotionStatusMarker(row.notes, workflowNote);
  })();
  if (notesWithMarker) props.Notes = { rich_text: rich(notesWithMarker) };

  if (includeStatus) {
    const created = assertCreateStatusFromTracker(row.status);
    const select = created.ok ? created.notionSelect : 'Evaluated';
    const workflow = created.ok ? created.workflowNote : trackerStatusToNotionPush(row.status).workflowNote;
    props.Status = { select: { name: select } };
    if (workflow) {
      props.Notes = { rich_text: rich(mergeNotionStatusMarker(row.notes, workflow)) };
    }
  }
  return props;
}

/**
 * @param {Array<object>} rows
 * @param {ReturnType<typeof createHuntNotionClient>} client
 * @param {{ dryRun?: boolean, log?: (s: string) => void }} [ctx]
 */
export async function huntPushRows(rows, client, ctx = {}) {
  const log = ctx.log || (() => {});
  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const row of rows) {
    const dupes = (await client.findRecords(`${row.company} / ${row.role}`))
      .filter(
        (h) =>
          h.company.toLowerCase() === row.company.toLowerCase()
          && h.role.toLowerCase() === row.role.toLowerCase(),
      );

    if (dupes.length) {
      const props = buildHuntProperties(row, { includeStatus: false });
      if (ctx.dryRun) {
        log(`would update (status preserved): ${row.company} — ${row.role}`);
        updated++;
        continue;
      }
      await client.api(`pages/${dupes[0].id}`, 'PATCH', { properties: props });
      updated++;
      continue;
    }

    const props = buildHuntProperties(row, { includeStatus: true });
    if (ctx.dryRun) {
      log(`would create: ${row.company} — ${row.role}`);
      created++;
      continue;
    }
    await client.createPage(client.dataSourceId, props);
    created++;
  }

  return { created, updated, skipped, pushed: created + updated };
}

/**
 * @param {ReturnType<typeof createHuntNotionClient>} client
 */
export async function huntPullStatuses(client) {
  const raw = await client.queryDB(client.dataSourceId);
  return raw.map((r) => client.summarize(r));
}

/**
 * Match Notion row to tracker # by company+role (case-insensitive).
 * @param {Array<object>} trackerRows
 * @param {object} notionRow
 * @returns {object | null}
 */
export function matchTrackerRow(trackerRows, notionRow) {
  const c = notionRow.company.toLowerCase();
  const r = notionRow.role.toLowerCase();
  const hits = trackerRows.filter(
    (t) => t.company.toLowerCase() === c && t.role.toLowerCase() === r,
  );
  if (hits.length === 1) return hits[0];
  return null;
}

/**
 * Plan pull updates (pure).
 * @param {Array<object>} trackerRows
 * @param {Array<object>} notionRows
 */
export function planHuntPullUpdates(trackerRows, notionRows) {
  const updates = [];
  for (const n of notionRows) {
    const target = notionRowToTrackerStatus(n.status, n.notes);
    if (!target) continue;
    const row = matchTrackerRow(trackerRows, n);
    if (!row) continue;
    if (String(row.status).replace(/\*\*/g, '').trim() === target) continue;
    updates.push({ num: row.num, company: row.company, role: row.role, from: row.status, to: target });
  }
  return updates;
}

/**
 * Apply pull via set-status (Notion wins — bypasses Applied gate via --source).
 * @param {Array<{ num: number, to: string, company: string, role: string }>} updates
 * @param {string} rootDir
 * @param {{ dryRun?: boolean }} [opts]
 */
export function applyHuntPullUpdates(updates, dataRoot, opts = {}) {
  const results = [];
  const setStatus = join(REPO_ROOT, 'set-status.mjs');
  for (const u of updates) {
    const args = [
      setStatus,
      '--row',
      String(u.num),
      u.to,
      '--source',
      'notion-hunt-pull',
      '--note',
      'notion-hunt-pull sync',
    ];
    if (opts.dryRun) args.push('--dry-run');
    const env = {
      ...process.env,
      CAREER_OPS_ROOT: dataRoot,
      CAREER_OPS_TRACKER: resolveTrackerPath(dataRoot),
    };
    if (opts.trackerLock) env.CAREER_OPS_TRACKER_LOCK = opts.trackerLock;
    try {
      execFileSync(NODE, args, {
        cwd: REPO_ROOT,
        encoding: 'utf-8',
        env,
      });
      results.push({ ...u, ok: true });
    } catch (err) {
      results.push({ ...u, ok: false, error: err.stderr || err.message });
    }
  }
  return results;
}

/**
 * @param {{ token: string, rootDir?: string, dryRun?: boolean, fetch?: Function, dataSourceId?: string }} opts
 */
export async function runHuntPush(opts) {
  const rootDir = opts.rootDir || REPO_ROOT;
  const rows = readTrackerRowsForHunt(rootDir);
  const client = createHuntNotionClient({
    token: opts.token,
    fetch: opts.fetch,
    dataSourceId: opts.dataSourceId,
  });
  return huntPushRows(rows, client, { dryRun: opts.dryRun });
}

/**
 * @param {{ token: string, rootDir?: string, dryRun?: boolean, fetch?: Function, dataSourceId?: string }} opts
 */
export async function runHuntPull(opts) {
  const rootDir = opts.rootDir || REPO_ROOT;
  const trackerRows = readTrackerRowsForHunt(rootDir);
  const client = createHuntNotionClient({
    token: opts.token,
    fetch: opts.fetch,
    dataSourceId: opts.dataSourceId,
  });
  const notionRows = await huntPullStatuses(client);
  const updates = planHuntPullUpdates(trackerRows, notionRows);
  const applied = applyHuntPullUpdates(updates, rootDir, { dryRun: opts.dryRun });
  return { updates: updates.length, results: applied };
}
