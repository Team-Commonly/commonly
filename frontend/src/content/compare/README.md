# Compare pages: one file per competitor

Each `<id>.json` here becomes `https://commonly.me/compare/<id>/`. `compareMarkdown` in
`frontend/scripts/generate-seo-pages.mjs` is the one template that lays every page out, and you add
a competitor by adding a file. No code change is needed.

## The build refuses a page when

- A source has no `https://` URL, or no `read` date (`YYYY-MM-DD`, the day someone opened that page and read it).
- A cell in the competitor column of the table cites no source (`[n]`).
- Any `[n]` on the page points past the end of `sources`.
- `datePublished` or `dateModified` isn't `YYYY-MM-DD`, or `dateModified` is earlier than `datePublished`.
- A source's `n` isn't its place in the list (1, 2, 3 …). Insert a source and you renumber it and every `[n]` after it, on purpose.
- `path` isn't `/compare/<id>/`, or `listOrder` isn't a whole number.
- The file isn't valid JSON (the error names the file).
- There's an open bracketed marker such as `[HOLD: …]`.

Prose (the short answer, the "When to pick" lists and the FAQ) may cite. It isn't forced to, so
put every competitor fact that matters into the table.

## Fields

`path`, `listOrder` (where the page sits in footer links and llms.txt), `datePublished`,
`dateModified` (the sitemap lastmod and the structured data; change it with the text), `title`,
`description`, `name`, `updated` (the italic line under the heading), `shortAnswer`, optional `notes`
(paragraphs after the short answer), `table.them` and `table.rows[{label, them, us}]`, optional
`afterTable` (paragraphs after the table), `pickThem{name, items}`, `pickUs`, `faq[{q, a}]`,
`sourcesIntro`, `sources[{n, label, url, note?, read}]` (`[1]` cites the source with `n: 1`),
`closing`.

## Editing a live page

A page Google sees change restarts its clock, so batch every edit to one page into a single pass
(D295), and move `dateModified` and the `updated` line with it.
