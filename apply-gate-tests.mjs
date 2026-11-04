#!/usr/bin/env node

/**
 * apply-gate-tests.mjs — kill-switch + Approved fill/Applied gates (HK Slice A).
 */

import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import {
  isApplyAutofillEnabled,
  assertApplyFillAllowed,
  assertAppliedTransitionAllowed,
  parseApplyEnvOverride,
} from './lib/apply-gate.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;

let passed = 0;
let failed = 0;
function pass(m) { console.log(`PASS ${m}`); passed++; }
function fail(m) { console.error(`FAIL ${m}`); failed++; }

function makeSandbox(rows) {
  const dir = mkdtempSync(join(tmpdir(), 'co-apply-gate-'));
  const tracker = join(dir, 'applications.md');
  const profileDir = join(dir, 'config');
  mkdirSync(profileDir, { recursive: true });
  const profileLeaf = 'profile' + '.yml';
  writeFileSync(join(profileDir, profileLeaf), 'apply:\n  autofill: true\n');
  writeFileSync(tracker, rows);
  const lock = join(dir, 'career-ops-apply-gate-test.lock');
  return { dir, tracker, lock, root: dir };
}

function runSetStatus(args, sandbox, extraEnv = {}) {
  const env = {
    ...process.env,
    CAREER_OPS_ROOT: sandbox.root,
    CAREER_OPS_TRACKER: sandbox.tracker,
    CAREER_OPS_TRACKER_LOCK: sandbox.lock,
    CAREER_OPS_PROFILE: join(sandbox.root, 'config', 'profile' + '.yml'),
    ...extraEnv,
  };
  try {
    const stdout = execFileSync(NODE, [join(ROOT, 'set-status.mjs'), ...args], {
      cwd: ROOT, env, encoding: 'utf-8', timeout: 30000, windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

const TRACKER = `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes |
|---|------|---------|------|-------|--------|-----|--------|-------|
| 1 | 2026-06-01 | Acme | Engineer | 4.2/5 | Evaluated | ✅ | [1](../reports/001.md) | — |
| 2 | 2026-06-02 | Beta | Engineer | 4.0/5 | Approved | ✅ | [2](../reports/002.md) | operator GO |
`;

// ── unit: env + profile ──
if (parseApplyEnvOverride() === undefined) pass('parseApplyEnvOverride: unset by default in test env');
else fail('parseApplyEnvOverride: expected unset');

process.env.CAREER_OPS_APPLY = '0';
if (isApplyAutofillEnabled() === false) pass('CAREER_OPS_APPLY=0 disables autofill');
else fail('CAREER_OPS_APPLY=0 should disable autofill');
delete process.env.CAREER_OPS_APPLY;

const deny = assertApplyFillAllowed({ applicationNum: '2' });
if (!deny.ok && deny.code === 'apply-autofill-disabled') pass('fill blocked when autofill disabled');
else fail(`fill should be blocked when autofill off: ${JSON.stringify(deny)}`);

const appliedDeny = assertAppliedTransitionAllowed({ oldStatus: 'Evaluated', force: false });
if (!appliedDeny.ok && appliedDeny.code === 'applied-gate') pass('Applied transition blocked from Evaluated');
else fail('Applied from Evaluated should fail');

const appliedForceNoNote = assertAppliedTransitionAllowed({ oldStatus: 'Evaluated', force: true, note: null });
if (!appliedForceNoNote.ok) pass('Applied --force without note rejected');
else fail('Applied force needs note');

const appliedOk = assertAppliedTransitionAllowed({ oldStatus: 'Approved', force: false });
if (appliedOk.ok) pass('Applied allowed from Approved');
else fail('Applied from Approved should pass');

// ── integration: set-status Applied gate ──
const sb = makeSandbox(TRACKER);
try {
  const enabled = assertApplyFillAllowed({ applicationNum: '2', rootDir: sb.root });
  if (enabled.ok) pass('fill allowed for Approved row when autofill on');
  else fail(`fill should pass for Approved #2: ${JSON.stringify(enabled)}`);

  const fillBlock = assertApplyFillAllowed({ applicationNum: '1', rootDir: sb.root });
  if (!fillBlock.ok && fillBlock.code === 'apply-not-approved') pass('fill blocked for non-Approved row');
  else fail('fill should block for Evaluated row');

  const r1 = runSetStatus(['1', 'Applied', '--json'], sb, { CAREER_OPS_APPLY: '1' });
  if (r1.code !== 0 && r1.stdout.includes('applied-gate')) pass('set-status Applied blocked from Evaluated');
  else fail(`set-status should block Applied from Evaluated: code=${r1.code} out=${r1.stdout.slice(0, 200)}`);

  const r2 = runSetStatus(['2', 'Applied', '--json'], sb, { CAREER_OPS_APPLY: '1' });
  if (r2.code === 0 && r2.stdout.includes('"newStatus": "Applied"')) pass('set-status Applied allowed from Approved');
  else fail(`set-status should allow Applied from Approved: ${r2.stdout.slice(0, 200)}`);

  const r3 = runSetStatus(['1', 'Applied', '--force', '--note', 'audit: operator GO relayed', '--json'], sb, { CAREER_OPS_APPLY: '1' });
  if (r3.code === 0 && r3.stdout.includes('"newStatus": "Applied"')) pass('set-status Applied with --force + --note');
  else fail(`set-status force Applied failed: ${r3.stdout}`);
} finally {
  rmSync(sb.dir, { recursive: true, force: true });
}

// ── prepare-application refuses when autofill off ──
try {
  execFileSync(NODE, [join(ROOT, 'prepare-application.mjs'), '--url', 'https://boards.greenhouse.io/example/jobs/1', '--pdf', 'output/x.pdf'], {
    cwd: ROOT,
    env: { ...process.env, CAREER_OPS_APPLY: '0' },
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  fail('prepare-application should exit non-zero when autofill disabled');
} catch (e) {
  const err = `${e.stderr || ''}${e.stdout || ''}`;
  if (err.includes('apply-autofill-disabled') || err.includes('autofill is disabled')) pass('prepare-application blocked when autofill off');
  else fail(`prepare-application unexpected error: ${err.slice(0, 300)}`);
}

console.log(`\napply-gate-tests: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
