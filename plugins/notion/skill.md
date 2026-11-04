---
name: career-ops-plugin-notion
description: How to mirror the career-ops tracker to a Notion database and read records back as job leads.
license: MIT
---

# notion plugin

Mirrors your application tracker to a Notion database (export) and reads records
back into the pipeline (search). `data/applications.md` stays the source of
truth — Notion is an additive mirror.

## Hunt sync (optional)

Scored rows can upsert to a Hunt data source you set with
`NOTION_HUNT_DATA_SOURCE_ID` (see `config/hunt.example.yml`). This overlay
ships no Notion id. Commands:

```bash
node hunt-notion-sync.mjs push [--dry-run]
node hunt-notion-sync.mjs pull [--dry-run]
```

Push never overwrites **Status** on existing Hunt pages; pull updates the disk
tracker with `--source notion-hunt-pull` (Notion wins). See `docs/HK_OVERLAY.md`.

The **Applications** mirror below is optional and not the HK Hunt SoT.

## Files under a Hunt job page

Pack the report, the JD, and CV files onto an inline **Files** database that
lives under one Hunt job page. The page id you pass is the parent. The command
does not create a page on its own, and it does not change **Status**.

```bash
node plugins.mjs run notion files-pack \
  --hunt-page-id <uuid> \
  --report reports/001-role.md \
  --jd jds/001-jd.md \
  --pdf output/tailored.pdf \
  --pdf output/master.pdf \
  --ah output/ah.md \
  --hub output/hub.md \
  --dry-run
```

`--dry-run` prints the rows and does not call Notion. It does not need
`NOTION_ACCESS_TOKEN`. Repeat `--pdf` when there is a tailored CV and a master
CV (both Kind `PDF`, different Name). Each `--pdf` path must end in `.pdf`
(any letter case). A `.docx`, `.md`, or other file is refused. `--tracker` is
optional. `--selftest` runs the offline mock checks.

### Tailored CV files (HK)

Pack a black-and-white PDF of about two A4 pages. The only PDF path is
`build-cv-html.mjs` then `generate-pdf.mjs`. `openai-tailor.mjs --local` writes
draft markdown and is not a PDF or docx source.

For a bank or Taleo upload, write the one-column Word twin from that same HTML:

```bash
node cv-html-to-docx.mjs output/cv-<candidate>-<report>-<company>.html output/cv-<candidate>-<report>-<company>.docx
```

`node cv-html-to-docx.mjs --selftest` checks the one-column section order offline.
See `docs/HK_OVERLAY.md`.

Properties: Name (title), Kind (`hub`, `A–H`, `report`, `JD`, `PDF`, `tracker`),
Ready (checkbox), Summary (text). A second run updates the same Kind + Name
instead of adding another row.

## Commands

- `node plugins.mjs run notion export` — push each tracker row (company / role /
  status / score) to the "Applications" database under your Career Ops page.
  Add `--dry-run` to preview without writing.
- `node plugins.mjs run notion search "<query>"` — return Notion records that
  carry a job URL, matching the query, and append them to the pipeline.

## Setup

A "Career Ops" parent page in Notion containing an "Applications" database with
Company / Role / Status / Score / URL properties, shared with your internal
integration. Put `NOTION_ACCESS_TOKEN` + `NOTION_PARENT_PAGE_ID` in `.env`.

## Data it produces

`search` returns `Job[]` ({ title, url, company, location }) for records that
have a job URL; the engine writes them to the pipeline. `export` returns
{ pushed: N } — it never writes local files.
