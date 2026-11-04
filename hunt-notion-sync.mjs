#!/usr/bin/env node
// @ts-check
/**
 * hunt-notion-sync.mjs — HK Slice C: Notion Hunt jobs DS as SoT.
 *
 *   node hunt-notion-sync.mjs push [--dry-run]
 *   node hunt-notion-sync.mjs pull [--dry-run]
 *
 * Requires NOTION_ACCESS_TOKEN from the environment.
 * Requires NOTION_HUNT_DATA_SOURCE_ID. This file ships no Notion id.
 * See config/hunt.example.yml.
 *
 * Push: scored tracker rows → Hunt DS (never overwrites Status on existing pages).
 * Pull: Notion status → disk tracker via set-status (--source notion-hunt-pull).
 */

import { loadDotenvOnce } from './plugins/_engine.mjs';
import { runHuntPush, runHuntPull } from './plugins/notion/hunt-sync.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const USAGE = `Usage: node hunt-notion-sync.mjs push|pull [options]

Commands:
  push       Send scored tracker rows to the Hunt data source
  pull       Apply Hunt statuses to the local tracker

Options:
  --dry-run  Print the plan and write nothing
  --help     Show this help
`;

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE);
    return;
  }
  const cmd = args[0];
  const dryRun = args.includes('--dry-run');
  if (!cmd || !['push', 'pull'].includes(cmd)) {
    console.error('Usage: node hunt-notion-sync.mjs push|pull [--dry-run]');
    process.exit(1);
  }

  await loadDotenvOnce();
  const token = process.env.NOTION_ACCESS_TOKEN?.trim();
  if (!token) {
    console.error('NOTION_ACCESS_TOKEN is not set (.env) — Hunt sync needs it.');
    process.exit(1);
  }

  const dataSourceId = process.env.NOTION_HUNT_DATA_SOURCE_ID?.trim() || '';
  if (!dataSourceId) {
    console.error('Set NOTION_HUNT_DATA_SOURCE_ID. See config/hunt.example.yml. This overlay ships no Notion id.');
    process.exit(1);
  }
  const opts = { token, dryRun, dataSourceId };

  if (cmd === 'push') {
    const r = await runHuntPush(opts);
    console.log(
      JSON.stringify({
        action: 'push',
        dryRun,
        dataSourceId,
        created: r.created,
        updated: r.updated,
        pushed: r.pushed,
      }),
    );
    return;
  }

  const r = await runHuntPull(opts);
  console.log(
    JSON.stringify({
      action: 'pull',
      dryRun,
      dataSourceId,
      planned: r.updates,
      results: r.results,
    }),
  );
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}
