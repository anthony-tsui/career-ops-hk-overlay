#!/usr/bin/env node
/**
 * cv-tailor-gate.mjs — HK CV rewrite gate. Exit 0 only when a full CV rewrite
 * is allowed for this role. Does not write a CV (lib/cv-tailor-local.mjs does).
 *
 *   node cv-tailor-gate.mjs --application <tracker#> [--go | --force --note "..."] [--json]
 *   node cv-tailor-gate.mjs --report <report#> --go [--json]
 *
 * CAREER_OPS_CV_TAILOR=0 hard-off. CAREER_OPS_CV_TAILOR=1 counts as --go.
 */

import { assertCvRewriteAllowed, HUMAN_DELTA_SOP } from './lib/cv-tailor-gate.mjs';
import { flagValue, hasFlag } from './lib/cli-flags.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

function printHelp() {
  console.log(`career-ops HK — CV rewrite gate (Slice F)

Usage:
  node cv-tailor-gate.mjs --application <tracker#> [--go | --force --note "..."] [--json]
  node cv-tailor-gate.mjs --report <report#> --go [--json]

Exit 0 only when that role is Approved AND a GO flag is set.
CAREER_OPS_CV_TAILOR=0 blocks even then. Unset or CAREER_OPS_CV_TAILOR=1
allows a local tailored CV once Approved + GO (1 counts as --go).

This command does not write the file. The assist commands do, offline:
  node openrouter-runner.mjs apply <report#> --tailor --go
A 3–5 bullet note is an optional human delta, not a substitute.
See docs/HK_OVERLAY.md.
`);
}

export function gateFromArgv(argv, rootDir = getCareerOpsRoot()) {
  const report = flagValue(argv, '--report');
  return assertCvRewriteAllowed({
    applicationNum: flagValue(argv, '--application'),
    reportNums: report ? [report] : [],
    go: hasFlag(argv, '--go'),
    force: hasFlag(argv, '--force'),
    note: flagValue(argv, '--note') ?? null,
    rootDir,
  });
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || hasFlag(argv, '--help') || hasFlag(argv, '-h')) {
    printHelp();
    process.exit(0);
  }
  const result = gateFromArgv(argv);
  if (hasFlag(argv, '--json')) {
    console.log(JSON.stringify({ ...result, sop: HUMAN_DELTA_SOP }));
  } else if (result.ok) {
    console.log(result.message);
    console.log(HUMAN_DELTA_SOP);
  } else {
    console.error(result.message);
  }
  process.exit(result.ok ? 0 : 1);
}

if (isMainModule(import.meta.url)) {
  main();
}
