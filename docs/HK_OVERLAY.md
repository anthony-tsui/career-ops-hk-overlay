# Hong Kong overlay

This is a generic pipeline for people who run [career-ops](https://github.com/career-ops-hq/career-ops) against Hong Kong boards. It is not a personal hunt log.

career-ops scores the job. This overlay adds filters, a copy-the-score command, and gates so a form is filled or a row is marked Applied only after **operator GO**.

## Flow

```text
score / filter  →  optional Notion mirror  →  operator GO  →  human apply
```

1. **Score.** Run `node board-eval.mjs`. career-ops supplies the five dimension scores and the global score. Do not type those by hand. A level-fit line is a note. It does not change the score.
2. **Optional Notion mirror.** If you use one, set `NOTION_HUNT_DATA_SOURCE_ID` yourself. See `config/hunt.example.yml`. This tree does not contain a database id.
3. **Operator GO.** Mark the tracker row **Approved** only when you want that role to move forward.
4. **Human apply.** You open the portal and submit. career-ops may help fill a form only when `apply.autofill` is true **and** the row is **Approved**. Submit is never automatic.

## Board eval

```bash
node board-eval.mjs \
  --company "Example Co" \
  --role "Engineer" \
  --jd-file ./jd.txt \
  --num 042 \
  --json
```

`--num` comes from `node reserve-report-num.mjs` in career-ops.

With no `--report` and no test `--scorer`, the command exits 2 and writes nothing. It will not invent scores. `--score` is not a flag.

It can write a report and a tracker-addition file. It does not merge the tracker, fill a form, or mark Applied.

```bash
node merge-tracker.mjs
node hunt-notion-sync.mjs push --dry-run
```

`board-eval` does not push to Notion. A live push needs your own token and your own data-source id. `--dry-run` on the sync command prints a plan.

## Gates

| Control | Default | Effect |
|---------|---------|--------|
| `apply.autofill` in `config/profile.yml` | `false` | Blocks form fill |
| `CAREER_OPS_APPLY=0` | off | Disables autofill even if the profile says true |
| `CAREER_OPS_APPLY=1` | — | Allows autofill only when the row is **Approved** |
| `set-status … Applied` | gated | Allowed from **Approved**, or `--force` plus a `--note` audit after operator GO |
| CV tailor | off | Rewrite only when the row is **Approved** and you pass `--go` |
| `CAREER_OPS_CV_TAILOR=0` | hard off | Blocks a rewrite even then |

Check the CV gate with `node cv-tailor-gate.mjs --application <#> --json`. Add `--go` only after operator GO.

`Shortlisted`, `Approved`, and `Review` are tracker labels this overlay expects. Add them to your states file if your checkout does not have them yet.

## Notion sync

| Command | Direction | Rule |
|---------|-----------|------|
| `node hunt-notion-sync.mjs push [--dry-run]` | Tracker → your Hunt database | Upserts company, role, score, URL, and notes. Does **not** overwrite Status on a page that already exists |
| `node hunt-notion-sync.mjs pull [--dry-run]` | Hunt database → tracker | Notion status wins on disk |

Set `NOTION_HUNT_DATA_SOURCE_ID` before a live run. The shipped constant is null.

Notion select values the mapper knows: `Pending`, `Evaluated`, `Applied`, `Responded`, `Interview`, `Offer`, `Hired`, `Rejected`, `Discarded`, `SKIP`, `DEAD`.

`Shortlisted`, `Approved`, and `Review` are stored in Notes as `notion-status=…` and use the Notion select **Evaluated** until you add those options yourself. Do not invent select options through the API.

`Pending` means no tracker row is expected. `DEAD` becomes tracker `Discarded`.

The disk tracker is your working copy. The token stays in `.env` (`NOTION_ACCESS_TOKEN`). Never commit it.

### Files under one job page

```bash
node plugins.mjs run notion files-pack \
  --hunt-page-id <your-page-uuid> \
  --report <report.md> \
  --jd <jd.md> \
  --pdf <tailored.pdf> \
  --dry-run
```

`--dry-run` prints the plan. It does not read the token and it does not call Notion. `--pdf` must be a `.pdf` file.

## Scan filters

Copy `templates/portals.hk.example.yml` to `portals.yml` and put your own salary numbers in place of the placeholders.

| Signal | What happens |
|--------|----------------|
| Contract / temp | Kept, tagged, suggested status **Review**. Not dropped. |
| Agency or Big Four without an AI / transformation signal | Tagged and suggested **Review** |
| Salary vs your `salary_filter.target` | A rank tag only. It does not delete the row. |

```bash
node hk-eval-gate.mjs --title "…" --company "…" --work-type "…" --json
```

## CV files

Default is off. Pasting a job description does not rewrite a CV.

When the gate is open, the tailored file should be:

- Black and white
- One column, in reading order
- About two A4 pages, unless the role needs one more page of real depth
- Built with `build-cv-html.mjs` then `generate-pdf.mjs`
- No photo, colour, icons, skill bars, layout tables, or logos
- No invented metrics or employers

```bash
node build-cv-html.mjs <payload.json> output/cv-<candidate>-<report>-<company>.html
node generate-pdf.mjs output/cv-<candidate>-<report>-<company>.html output/cv-<candidate>-<report>-<company>.pdf --format=a4 --report=<NNN>
node cv-html-to-docx.mjs output/cv-<candidate>-<report>-<company>.html output/cv-<candidate>-<report>-<company>.docx
node cv-html-to-docx.mjs --selftest
```

`--selftest` is offline. It uses a fictional sample CV (`Ada Example`). It does not call Notion.

Draft markdown from a local tailor is not the PDF and not the Word file. Words on the CV must already be true in `cv.md`. This overlay does not include a CV.
