#!/usr/bin/env node
/**
 * cv-html-to-docx.mjs — one-column Word twin of a tailored CV HTML file.
 *
 *   node cv-html-to-docx.mjs <input.html> <output.docx>
 *   node cv-html-to-docx.mjs --selftest
 *
 * Input is HTML from build-cv-html.mjs (the same file generate-pdf.mjs prints).
 * openai-tailor.mjs --local markdown is refused. This command does not call
 * Notion, does not submit an application, and does not change tracker status.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'path';
import { isMainModule } from './lib/is-main-module.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import {
  assertDocxHtmlInput,
  htmlToDocxBuffer,
  runDocxSelftest,
  sectionHeadings,
  extractCvDocument,
} from './lib/cv-html-docx.mjs';

export const USAGE = `Usage: node cv-html-to-docx.mjs <input.html> <output.docx>
       node cv-html-to-docx.mjs --selftest

Write a one-column ATS .docx from tailored CV HTML (build-cv-html.mjs).
Section order matches the one-column reading order. --local markdown is refused.
--selftest is offline and writes nothing under the repo.
`;

/**
 * @param {string} pathValue
 * @param {string} rootDir
 * @returns {boolean}
 */
export function isInsideRoot(pathValue, rootDir) {
  const rel = relative(resolve(rootDir), resolve(pathValue));
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * @param {string[]} argv
 * @param {{ rootDir?: string, log?: (s: string) => void }} [deps]
 * @returns {number}
 */
export function mainCvDocx(argv, deps = {}) {
  const log = deps.log || ((s) => console.log(s));
  const rootDir = deps.rootDir || getCareerOpsRoot();
  if (argv.includes('--help') || argv.includes('-h')) {
    log(USAGE.trim());
    return 0;
  }
  if (argv.includes('--selftest')) {
    const result = runDocxSelftest();
    if (!result.ok) {
      console.error(`cv-html-to-docx selftest: failed\n${result.errors.join('\n')}`);
      return 1;
    }
    log('cv-html-to-docx selftest: ok');
    log('liveNotion: false');
    log('columns: 1');
    return 0;
  }
  const positional = argv.filter((arg) => !arg.startsWith('--'));
  if (positional.length !== 2) {
    console.error(USAGE.trim());
    return 1;
  }
  const inputPath = resolve(positional[0]);
  const outputPath = resolve(positional[1]);
  if (extname(outputPath).toLowerCase() !== '.docx') {
    console.error(`output must be a .docx file: ${outputPath}`);
    return 1;
  }
  if (!isInsideRoot(outputPath, rootDir)) {
    console.error(`Refusing to write the docx outside the career-ops root: ${outputPath}`);
    return 1;
  }
  let html;
  try {
    html = readFileSync(inputPath, 'utf8');
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  try {
    assertDocxHtmlInput(inputPath, html);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  const doc = extractCvDocument(html);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, htmlToDocxBuffer(html));
  log(`docx: ${outputPath}`);
  log(`sections: ${sectionHeadings(doc).join(' | ')}`);
  log('columns: 1');
  log('liveNotion: false');
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exit(mainCvDocx(process.argv.slice(2)));
}
