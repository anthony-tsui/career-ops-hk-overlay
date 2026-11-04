# Hong Kong sources (example)

How jobs can enter a career-ops checkout that uses this overlay. Replace the salary placeholders with your own numbers. Nothing here is a personal compensation claim.

Upstream project: [career-ops](https://github.com/career-ops-hq/career-ops) (MIT). See `NOTICE`.

## Compensation filter

In `templates/portals.hk.example.yml`:

| Field | Placeholder | Meaning |
|-------|-------------|---------|
| `salary_filter.min` | `YOUR_FLOOR_HKD_YEAR` | Your annual floor, in HKD |
| `salary_filter.target` | `YOUR_TARGET_HKD_YEAR` | Your annual target, used only to rank |

Do not print those numbers on a CV. The filter is for matching.

## Role policy you can keep or edit

- Permanent full-time is the preferred class. Contract and temp rows are tagged and suggested as **Review**. They are not deleted.
- In-house employers can stay preferred.
- Agency and Big Four boards can stay enabled. `agency_filter` demotes them to **Review** unless the title or description shows a clear AI, transformation, or solutions signal.

## Approve before apply

This tool scores, drafts, and tracks. It does not:

- Click Apply, Submit, or Send
- Bypass a WAF, cookie wall, or geo block

You review every CV, letter, and form answer. You submit in your browser.

Form fill stays off unless `apply.autofill: true`, `CAREER_OPS_APPLY` is not `0`, and the tracker row is **Approved** (operator GO).

## Where listings come from

```text
Company career pages  →  scan (public pages)
JobsDB (SEEK API)     →  keyword boards in the example seed
LinkedIn              →  paste a job URL
eCareer HK            →  paste a job URL (no scraper in this overlay)
eFinancialCareers     →  paste only
        ↓
   Score
        ↓
   You approve → you apply by hand
```

### Company career pages

The example seed names public boards (banks, insurers, Big Four, and recruiter listing pages). Some sites return empty HTML to robots. Open those in your browser and paste the job URL. Do not log into a personal session inside this tool.

### JobsDB Hong Kong

The example uses the public SEEK API (`siteKey: HK-Main`). Links look like `https://hk.jobsdb.com/job/{id}`.

### LinkedIn and eCareer HK

Paste the URL. There is no LinkedIn login scraper and no automated government-site fetch in this overlay.

eCareer HK (Government Vacancies Enquiry System):

https://csboa.csb.gov.hk/csboa/joa/JVE_001_search.action

### eFinancialCareers

Paste the URL. It is not a primary channel in the example seed.

## Paste a URL

```bash
node agent-inbox.mjs add "evaluate https://hk.jobsdb.com/job/123"
```

Then score it. You apply by hand.

## Files you create locally

These are yours. They are not in this overlay:

- `cv.md`
- `config/profile.yml` (start from `config/profile.example.yml`)
- `portals.yml` (start from `templates/portals.hk.example.yml`)

Keep them out of any public copy.
