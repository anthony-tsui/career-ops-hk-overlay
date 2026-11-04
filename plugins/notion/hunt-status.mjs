// @ts-check
/**
 * hunt-status.mjs — Hunt status map (Notion data source ↔ disk tracker).
 *
 * Notion Status (select): Pending|Evaluated|Applied|Responded|Interview|Offer|
 *   Hired|Rejected|Discarded|SKIP|DEAD
 * Tracker may also use Shortlisted|Approved|Review until the Notion select
 * has those options. Until then, workflow states are stored in Notes as
 * notion-status=<Label>. Do not invent Notion select options via the API.
 *
 * This overlay ships no Notion id. Set NOTION_HUNT_DATA_SOURCE_ID
 * (see config/hunt.example.yml). The constants below stay null.
 */

/** Null in this tree. Callers read NOTION_HUNT_DATA_SOURCE_ID. */
export const HUNT_JOBS_DATA_SOURCE_ID = null;

/** Null in this tree. Optional: NOTION_HUNT_BOARD_PAGE_URL. */
export const HUNT_BOARD_PAGE_URL = null;

/** Null in this tree. Optional: NOTION_HUNT_STATUS_MAP_URL. */
export const HUNT_STATUS_MAP_DOC_URL = null;

/** @type {ReadonlySet<string>} */
export const NOTION_HUNT_STATUS_ENUM = new Set([
  'Pending',
  'Evaluated',
  'Applied',
  'Responded',
  'Interview',
  'Offer',
  'Hired',
  'Rejected',
  'Discarded',
  'SKIP',
  'DEAD',
]);

/** Tracker-only workflow states mirrored in Notes until Notion select expands. */
export const TRACKER_WORKFLOW_STATES = new Set(['Shortlisted', 'Approved', 'Review']);

const NOTION_STATUS_MARKER_RE = /\bnotion-status=([A-Za-z]+)\b/;

/**
 * @param {string} notes
 * @returns {string | null}
 */
export function parseNotionStatusMarker(notes) {
  const m = String(notes ?? '').match(NOTION_STATUS_MARKER_RE);
  if (!m) return null;
  const label = m[1];
  if (TRACKER_WORKFLOW_STATES.has(label)) return label;
  return null;
}

/**
 * Merge or replace notion-status= marker in Notes (idempotent).
 * @param {string} notes
 * @param {string | null} workflowLabel Shortlisted|Approved|Review or null to strip marker
 * @returns {string}
 */
export function mergeNotionStatusMarker(notes, workflowLabel) {
  let base = String(notes ?? '').replace(NOTION_STATUS_MARKER_RE, '').trim();
  base = base.replace(/;\s*;/g, ';').replace(/^;\s*/, '').replace(/\s*;\s*$/, '').trim();
  if (!workflowLabel) return base;
  const marker = `notion-status=${workflowLabel}`;
  if (!base) return marker;
  if (base.includes(marker)) return base;
  return `${base}; ${marker}`;
}

/**
 * Map a tracker status cell to Notion Status select + optional workflow note.
 * @param {string} trackerStatus
 * @returns {{ notionSelect: string, workflowNote: string | null }}
 */
export function trackerStatusToNotionPush(trackerStatus) {
  const s = String(trackerStatus ?? '').replace(/\*\*/g, '').trim();
  if (!s) return { notionSelect: 'Evaluated', workflowNote: null };
  if (TRACKER_WORKFLOW_STATES.has(s)) {
    return { notionSelect: 'Evaluated', workflowNote: s };
  }
  if (s === 'Discarded') return { notionSelect: 'Discarded', workflowNote: null };
  if (s === 'SKIP') return { notionSelect: 'SKIP', workflowNote: null };
  if (NOTION_HUNT_STATUS_ENUM.has(s)) return { notionSelect: s, workflowNote: null };
  // Fall back to Evaluated for unknown labels rather than inventing Notion options.
  return { notionSelect: 'Evaluated', workflowNote: null };
}

/**
 * Resolve effective tracker status from a Notion row (pull wins).
 * @param {string} notionSelect
 * @param {string} notesPlain
 * @returns {string | null} null = Pending (no disk row expected)
 */
export function notionRowToTrackerStatus(notionSelect, notesPlain) {
  const workflow = parseNotionStatusMarker(notesPlain);
  if (workflow) return workflow;
  const n = String(notionSelect ?? '').trim();
  if (!n || n === 'Pending') return null;
  if (n === 'DEAD') return 'Discarded';
  if (NOTION_HUNT_STATUS_ENUM.has(n) && n !== 'DEAD') {
    if (n === 'Pending') return null;
    return n;
  }
  return 'Evaluated';
}

/**
 * Status payload for a new Notion page from tracker (create only).
 * Existing pages never get Status patched — Notion wins on pull.
 * @param {string} trackerStatus
 * @returns {{ ok: true, notionSelect: string, workflowNote: string | null }}
 */
export function assertCreateStatusFromTracker(trackerStatus) {
  const { notionSelect, workflowNote } = trackerStatusToNotionPush(trackerStatus);
  return { ok: true, notionSelect, workflowNote };
}
