/**
 * apply-gate.mjs — HK approve-then-apply kill-switch + fill/Applied gates (#Slice A).
 *
 * Config: config/profile.yml `apply.autofill` (default false for this fork).
 * Env override: CAREER_OPS_APPLY=0|false|off disables; 1|true|on enables autofill
 * (Approved tracker status is still required for fill / Applied).
 */

import { readFileSync, existsSync } from 'fs';
import { getCareerOpsRoot, getProfilePath, hasProfileOverride, resolveTrackerPath } from '../path-resolver.mjs';
import { loadYaml } from './yaml-document.mjs';
import { resolveColumns, parseTrackerRow } from '../tracker-parse.mjs';

const APPROVED_STATUS = 'Approved';

/** @returns {boolean | undefined} undefined = no env override */
export function parseApplyEnvOverride() {
  const raw = process.env.CAREER_OPS_APPLY?.trim();
  if (!raw) return undefined;
  const v = raw.toLowerCase();
  if (['0', 'false', 'off', 'no', 'disabled'].includes(v)) return false;
  if (['1', 'true', 'on', 'yes', 'enabled'].includes(v)) return true;
  return undefined;
}

/**
 * @param {string} [rootDir]
 * @returns {boolean}
 */
export function readApplyAutofillFromProfile(rootDir) {
  // An explicit root is the sandbox a caller named. A profile override still
  // wins, matching every other reader: getProfilePath() honors it, and
  // getProfilePath(root) does not.
  const profilePath = hasProfileOverride() || !rootDir ? getProfilePath() : getProfilePath(rootDir);
  if (!existsSync(profilePath)) return false;
  try {
    const doc = loadYaml(readFileSync(profilePath, 'utf-8'));
    if (doc?.apply?.autofill === true) return true;
    if (doc?.apply?.autofill === false) return false;
    return false;
  } catch {
    return false;
  }
}

/** @returns {boolean} */
export function isApplyAutofillEnabled(rootDir) {
  const env = parseApplyEnvOverride();
  if (env !== undefined) return env;
  return readApplyAutofillFromProfile(rootDir);
}

/**
 * @param {string} [applicationNum] tracker # column
 * @param {string} [rootDir]
 * @returns {string | null} canonical Status cell or null if row missing
 */
export function trackerStatusForApplication(applicationNum, rootDir = getCareerOpsRoot()) {
  const n = String(applicationNum ?? '').trim();
  if (!/^\d+$/.test(n)) return null;
  const trackerPath = resolveTrackerPath(rootDir);
  if (!existsSync(trackerPath)) return null;
  const lines = readFileSync(trackerPath, 'utf-8').split('\n');
  const colmap = resolveColumns(lines);
  if (!colmap) return null;
  for (let i = 0; i < lines.length; i++) {
    const row = parseTrackerRow(lines[i], colmap);
    if (!row || String(row.num) !== n) continue;
    return String(row.status ?? '').trim() || null;
  }
  return null;
}

/**
 * @param {{ applicationNum?: string, rootDir?: string }} [opts]
 * @returns {{ ok: true } | { ok: false, code: string, message: string }}
 */
export function assertApplyFillAllowed(opts = {}) {
  const rootDir = opts.rootDir ?? getCareerOpsRoot();
  if (!isApplyAutofillEnabled(rootDir)) {
    return {
      ok: false,
      code: 'apply-autofill-disabled',
      message:
        'Apply autofill is disabled (apply.autofill false or CAREER_OPS_APPLY=0). '
        + 'Enable only after an explicit operator GO and tracker status Approved.',
    };
  }
  const app = opts.applicationNum?.trim();
  if (!app) {
    return {
      ok: false,
      code: 'apply-not-approved',
      message:
        'Apply fill requires a tracker row # with status Approved. '
        + 'Pass --application <#> (CLI) or open apply from an Approved offer.',
    };
  }
  const status = trackerStatusForApplication(app, rootDir);
  if (!status) {
    return {
      ok: false,
      code: 'apply-not-approved',
      message: `No tracker row #${app} — cannot verify Approved status.`,
    };
  }
  if (status !== APPROVED_STATUS) {
    return {
      ok: false,
      code: 'apply-not-approved',
      message:
        `Apply fill blocked: tracker #${app} is "${status}", not Approved. `
        + 'operator GO and Approved status are required before any form fill.',
    };
  }
  return { ok: true };
}

/** @returns {boolean} */
export function isAppliedGateEnabled() {
  const v = process.env.CAREER_OPS_SKIP_APPLIED_GATE?.trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes') return false;
  return true;
}

// Statuses that already left the pre-apply decision. Marking them Applied is a
// tracker correction, a note update, or a terminal reopen — not a new submit.
// Evaluated, Shortlisted, Review, and SKIP stay blocked until Approved.
const ALREADY_APPLIED_OR_LATER = new Set([
  'Applied', 'Responded', 'Assessment', 'Interview', 'Offer',
  'Rejected', 'Discarded', 'Hired',
]);

/**
 * @param {{ oldStatus: string, force?: boolean, note?: string | null }} opts
 * @returns {{ ok: true } | { ok: false, code: string, message: string }}
 */
export function assertAppliedTransitionAllowed({ oldStatus, force = false, note = null }) {
  if (!isAppliedGateEnabled()) return { ok: true };
  const prior = String(oldStatus ?? '').trim();
  if (prior === APPROVED_STATUS || ALREADY_APPLIED_OR_LATER.has(prior)) return { ok: true };
  if (!force) {
    return {
      ok: false,
      code: 'applied-gate',
      message:
        `Cannot mark Applied from "${prior}" — current status must be Approved. `
        + 'Use --force with --note "..." only after an explicit operator GO (audit trail).',
    };
  }
  const audit = note != null ? String(note).trim() : '';
  if (!audit) {
    return {
      ok: false,
      code: 'applied-gate',
      message:
        'Applied gate bypass requires --force and --note (audit trail in tracker row / status-log).',
    };
  }
  return { ok: true };
}
