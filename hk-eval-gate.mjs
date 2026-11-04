#!/usr/bin/env node
/**
 * hk-eval-gate.mjs — HK Slice D eval-path status suggestion (mock/offline safe).
 *
 *   node hk-eval-gate.mjs --title "..." --company "..." [--work-type "Full time"] [--description-file path] [--json]
 *
 * Reads portals.yml when present. Never writes tracker rows.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { loadYaml } from './lib/yaml-document.mjs';
import {
  applyHkEvalStatusFromRow,
  classifyEmployment,
  decorateHkScanJob,
  evaluateAgencyGate,
} from './lib/hk-scan-filters.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : '';
}

function loadPortals(root) {
  const p = join(root, 'portals.yml');
  if (!existsSync(p)) return {};
  try {
    const doc = loadYaml(readFileSync(p, 'utf-8'));
    return doc && typeof doc === 'object' ? doc : {};
  } catch {
    return {};
  }
}

export function suggestEvalStatus(input, portalsConfig = {}) {
  /** @type {Record<string, unknown>} */
  const job = {
    title: input.title || '',
    company: input.company || '',
    description: input.description || '',
    teaser: input.teaser || '',
  };
  if (input.workType) {
    job.workType = Array.isArray(input.workType) ? input.workType : [input.workType];
  }
  decorateHkScanJob(job, portalsConfig);
  const employment = classifyEmployment(job, portalsConfig.employment_filter || {});
  const agency = evaluateAgencyGate(job, portalsConfig.agency_filter || {});
  const notes = typeof job.note === 'string' ? job.note : '';
  const baseStatus = input.status || 'Evaluated';
  const applied = applyHkEvalStatusFromRow(
    { status: baseStatus, notes, company: job.company, role: job.title },
    portalsConfig,
  );
  return {
    suggestedStatus: applied.status,
    notes: applied.notes,
    adjusted: applied.adjusted,
    employmentClass: employment.class,
    agency,
    hkSuggestedStatus: job.hkSuggestedStatus || null,
  };
}

const USAGE = `Usage: node hk-eval-gate.mjs [options]

Options:
  --title <text>            Role title
  --company <text>          Company name
  --work-type <text>        Employment type, when the posting has one
  --description <text>      Posting text
  --description-file <path> Read the posting text from a file
  --status <text>           Starting status (default Evaluated)
  --json                    Print the suggestion as JSON
  --help                    Show this help
`;

function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(USAGE);
    return;
  }
  const root = getCareerOpsRoot();
  const portals = loadPortals(root);
  const descFile = argValue('--description-file');
  let description = argValue('--description');
  if (descFile && existsSync(descFile)) {
    description = readFileSync(descFile, 'utf-8');
  }
  const result = suggestEvalStatus(
    {
      title: argValue('--title'),
      company: argValue('--company'),
      workType: argValue('--work-type'),
      description,
      status: argValue('--status') || 'Evaluated',
    },
    portals,
  );
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result));
    return;
  }
  console.log(`Suggested status: ${result.suggestedStatus}`);
  if (result.notes) console.log(`Notes: ${result.notes}`);
}

if (isMainModule(import.meta.url)) {
  main();
}
