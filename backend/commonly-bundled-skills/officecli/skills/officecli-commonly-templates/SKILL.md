---
name: officecli-commonly-templates
description: "Use this skill when producing a polished, Commonly-branded deliverable (.docx brief / memo, .xlsx data matrix, .pptx deck) and you do not have specific brand guidance from the user. Trigger on: 'write me a brief', 'one-pager', 'memo', 'data sheet', 'status matrix', 'short deck', 'summary deck', 'closing slide', 'final deliverable'. Routes to `officecli merge` with one of three pre-built starter templates that already carry the Commonly palette, fonts, and structure — so you populate content with one merge call instead of 30 individual `officecli set` commands. DO NOT use for fundraising decks (use `officecli-pitch-deck`), academic papers (use `officecli-academic-paper`), or financial models (use `officecli-financial-model`)."
---

# OfficeCLI Commonly Templates

**A skill that does NOT teach you officecli syntax — it teaches you `officecli merge`.** Three pre-built starter files at `/opt/commonly-bundled-skills/officecli/templates/` carry the Commonly palette, font choices, and basic structure for the three deliverable shapes you most commonly produce. You substitute content via `--data` JSON; the styling is inherited.

## When to use this vs. the base officecli-{docx,xlsx,pptx} skills

| Use this skill | Use base officecli sub-skill |
|---|---|
| Generic brief, memo, status update, executive summary | Custom layout the templates don't cover |
| Data status matrix (≤ ~50 rows, 5 columns) | Multi-sheet workbook, formulas, charts |
| Short summary deck (3 slides) | 10+ slide deck, custom slide masters |
| You don't have specific brand guidance from the user | User specified palette / fonts / layout |
| Speed matters — one merge call vs. 30 `set` calls | You need fine-grained control |

If the user asked for a **fundraising deck** (Series A/B/C, seed round, VC), route to `officecli-pitch-deck`. If they asked for an **academic paper**, `officecli-academic-paper`. If a **financial model**, `officecli-financial-model`. This skill is for everyday Commonly-branded business deliverables.

## The three templates

All under `/opt/commonly-bundled-skills/officecli/templates/`:

### `commonly-brief.docx` — title + 3 sections + footer

Placeholder keys (pass via `--data`):

```
title           — H1, accent-blue, top of page
subtitle        — italic gray, just below title
context         — body paragraph under "Context" heading
finding_1       — bullet under "Findings" heading
finding_2       — bullet
finding_3       — bullet
recommendation  — body paragraph under "Recommendation" heading
footer          — small gray text, right-aligned (e.g. "Lily · 2026-05-06")
```

### `commonly-data.xlsx` — 5-column status matrix with frozen header

Header row is pre-styled (white text on accent-strong blue, frozen). Row 2 has placeholders for one sample row; for additional rows, use `officecli add` after the merge to append.

Placeholder keys for row 2:

```
sample_item, sample_status, sample_owner, sample_notes, sample_updated
```

For multi-row data, use the docx or pptx template instead — XLSX merge only works for fixed cells. If you genuinely need a styled multi-row sheet, this template's value is the **header styling and freeze pane**; produce the data via merge for row 2 then `officecli add` the rest.

### `commonly-deck.pptx` — 3-slide branded deck

Slide 1 (cover): accent bar + big title + subtitle + footer.
Slide 2 (content): thin accent bar + heading + 3 bulleted body paragraphs + page number.
Slide 3 (closing): full-bleed accent panel left + closing heading on it + body + meta-line on right.

Placeholder keys:

```
title, subtitle                                  — slide 1
slide2_heading, slide2_p1, slide2_p2, slide2_p3  — slide 2
closing_heading, closing_body, closing_meta      — slide 3
```

## The flow

```bash
# 1. Pick the template
TEMPLATE="/opt/commonly-bundled-skills/officecli/templates/commonly-deck.pptx"
OUT="/workspace/$(basename "$PWD")/out/q4-strategy-deck.pptx"

# 2. Write the data file
cat > /tmp/data.json <<'EOF'
{
  "title": "Q4 Strategy",
  "subtitle": "Engineering priorities · 2026-Q4",
  "slide2_heading": "What ships this quarter",
  "slide2_p1": "Marketplace frontend reaching demo-quality",
  "slide2_p2": "Theo + Nova heartbeat reliability above 99%",
  "slide2_p3": "Mobile responsive Phase 2 (drawer pods, slide-over inspector)",
  "closing_heading": "Decision needed",
  "closing_body": "Approve the marketplace-frontend resourcing for Nov / Dec.",
  "closing_meta": "Lily · 2026-11-06 · #strategy"
}
EOF

# 3. Merge — produces a fully-styled, fully-populated output
officecli merge "$TEMPLATE" "$OUT" --data /tmp/data.json

# 4. (Optional) view the result before posting
officecli view "$OUT" text | head -30

# 5. Attach to the pod via the runtime tool
# commonly_attach_file({podId, filePath: "out/q4-strategy-deck.pptx"})
```

## Verifying the output

The empty-office-stub guard at the upload route will reject a deliverable with no actual content — but a successful merge always produces non-empty files because every placeholder gets substituted (or stays as `{{key}}` literal text if the data file omits the key, which is itself non-empty content).

For peace of mind:

```bash
# Confirm placeholders are gone — none should remain
officecli view "$OUT" text | grep -E '\{\{[a-z_]+\}\}'
# (no output = clean; any output = caller forgot to supply that key)
```

## Reverse handoff

If the user asks for something the templates don't cover:

- **More than 3 slides** → fall through to base `officecli-pptx`. Use the merge output as your starting point if it speeds you up; otherwise `officecli create + add`.
- **Multi-section docx** with custom heading hierarchy → fall through to `officecli-docx`.
- **Anything fundraising-stage-specific** → `officecli-pitch-deck`.
- **User-supplied palette / brand guide** → fall through to base sub-skill and follow their guide. The Commonly palette is a default, not a constraint.

## Why this exists

Without templates, every deliverable started from `officecli create` (blank canvas) and required the agent to type out 30+ `officecli set` commands to produce styled output. Most attempts came back as plain default-styling files — the model couldn't reliably reproduce the Commonly palette / font / layout from memory each time. These templates encode that judgment once.

Building blocks: `python-docx`, `openpyxl`, and `python-pptx` were used to author the source templates; the `.docx` / `.xlsx` / `.pptx` files in this directory are the build output. To regenerate or rebrand, see `backend/commonly-bundled-skills/officecli/templates/build_templates.py` in the commonly repo.
