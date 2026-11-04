# career-ops HK overlay

A small add-on that helps other people run [career-ops](https://github.com/career-ops-hq/career-ops) for Hong Kong and nearby APAC job boards.

This is **not** a dump of anyone's private job search. It has no CV, no application reports, and no personal salary. It is also **not** an official career-ops product.

## Credit

Forked / derived from [career-ops-hq/career-ops](https://github.com/career-ops-hq/career-ops).

career-ops is MIT-licensed. Copyright (c) 2026 Santiago Fernández de Valderrama. This overlay keeps that license. Read [LICENSE](LICENSE) and [NOTICE](NOTICE).

## What it adds

You copy these files onto a career-ops checkout. career-ops still scores jobs. This overlay adds:

- Hong Kong scan and eval filters (permanent role vs contract, agency and Big Four demotion unless the posting shows a clear AI or transformation signal).
- `board-eval.mjs`, which copies a career-ops score and refuses a hand-typed replacement score.
- An approve-then-apply gate. Form fill stays off until you enable it, and the tracker row must be **Approved** (operator GO).
- A CV tailor gate, plus a black-and-white, one-column PDF / Word path for ATS forms.
- Optional Notion sync. **No database id is included.** You set your own.

The tool never clicks Apply, Submit, or Send. You do that yourself.

## How to use it

1. Clone [career-ops](https://github.com/career-ops-hq/career-ops).
2. Copy this tree's files into that checkout. They sit on top of career-ops. They do not replace your CV.
3. Copy `config/profile.example.yml` to `config/profile.yml` and write your own details. Do not commit `config/profile.yml`. The example person in that file is fictional.
4. Copy `templates/portals.hk.example.yml` to `portals.yml`. Replace `YOUR_FLOOR_HKD_YEAR` and `YOUR_TARGET_HKD_YEAR` with your own annual figures.
5. For Notion, copy `.env.example` to `.env` and follow `config/hunt.example.yml`. Put the token only in `.env`.

Then read [docs/HK_OVERLAY.md](docs/HK_OVERLAY.md) and [docs/HK_SOURCES.example.md](docs/HK_SOURCES.example.md).

## What is left out on purpose

CVs, reports, a real profile, tracker rows, Notion page ids, live tokens, and fleet notes. Those stay private.
