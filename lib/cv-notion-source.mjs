/**
 * Which files may become a Notion CV.
 *
 * Notion Tailored PDF is HTML from build-cv-html.mjs, printed by generate-pdf.mjs.
 * The Word twin is that same HTML through cv-html-to-docx.mjs.
 * openai-tailor.mjs --local writes draft markdown only. That file is not a
 * Notion PDF and not a Notion docx.
 */

import { extname } from 'path';

export const LOCAL_DRAFT_REFUSAL =
  'Refusing openai-tailor --local markdown as a Notion CV source. --local is draft markdown only. Notion Tailored PDF is build-cv-html.mjs then generate-pdf.mjs. The Word twin is cv-html-to-docx.mjs on that HTML.';

export const MARKDOWN_REFUSAL =
  'Refusing markdown as a PDF source. generate-pdf.mjs prints HTML from build-cv-html.mjs. --local markdown is a draft only and is not a Notion PDF or docx.';

const LOCAL_DRAFT = /#\s*Tailored CV \(local\)[\s\S]{0,800}Draft only\. Copied from cv\.md/;

/**
 * @param {string} filePath
 * @param {string} [text]
 * @returns {{ notionSource: boolean, kind: 'local-draft' | 'markdown' | 'html', reason: string }}
 */
export function classifyCvArtifact(filePath, text) {
  const body = String(text ?? '');
  const ext = extname(String(filePath || '')).toLowerCase();
  if (LOCAL_DRAFT.test(body)) {
    return { notionSource: false, kind: 'local-draft', reason: LOCAL_DRAFT_REFUSAL };
  }
  if (ext === '.md' || ext === '.markdown') {
    return { notionSource: false, kind: 'markdown', reason: MARKDOWN_REFUSAL };
  }
  return { notionSource: true, kind: 'html', reason: '' };
}
