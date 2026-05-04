---
name: pandic-office
description: Convert Markdown to PDF (or DOCX/EPUB/HTML) using the `pandoc` CLI. Use when asked to produce a PDF report, brief, summary, or any document where the input is Markdown and the output should be a polished, paginated file.
---

# pandic-office — Markdown → PDF / DOCX / EPUB / HTML via pandoc

Pandoc is installed at `/usr/bin/pandoc`. The XeLaTeX engine (`xelatex`) is
installed for PDF output. Both work non-interactively in the agent workspace.

## Common conversions

```bash
# Markdown → PDF (default LaTeX engine)
pandoc input.md -o output.pdf --pdf-engine=xelatex

# Markdown → DOCX (Word document)
pandoc input.md -o output.docx

# Markdown → EPUB (e-book)
pandoc input.md -o output.epub

# Markdown → standalone HTML
pandoc input.md -o output.html --standalone
```

## Producing a one-page brief

```bash
cat > /workspace/$(basename "$PWD")/brief.md <<'EOF'
# Q1 Engineering Brief

## Highlights
- Shipped feature X
- Closed Y bugs

## Risks
- Z dependency upgrade pending
EOF

pandoc /workspace/$(basename "$PWD")/brief.md \
  -o /workspace/$(basename "$PWD")/brief.pdf \
  --pdf-engine=xelatex \
  -V geometry:margin=1in \
  -V fontsize=11pt
```

## Useful flags

| Flag | Effect |
|------|--------|
| `--toc` | Insert a table of contents |
| `-V geometry:margin=1in` | Set page margins |
| `-V fontsize=11pt` | Set body font size |
| `--number-sections` | Auto-number headings |
| `--metadata title="..."` | Set document title |
| `-o file.pdf` | Output filename + format (inferred from extension) |

## After producing the file

Attach it to chat using the `commonly_attach_file` tool (a kernel verb):

```
commonly_attach_file({
  podId: "<the pod>",
  filePath: "brief.pdf",      // workspace-relative
  message: "Q1 brief attached."
})
```

The file path must stay inside `/workspace/<accountId>/` — `..` and absolute
paths outside the workspace are rejected.

## Troubleshooting

- **"xelatex not found"** — pandoc fell back to a missing TeX engine. Always
  pass `--pdf-engine=xelatex`.
- **"Could not convert image"** — embedded images need to be local file paths
  inside the workspace, not http URLs (unless you pre-fetch them).
- **Tables render badly in PDF** — add `--variable=tables:true` and use simple
  Markdown table syntax (no merged cells).

## When NOT to use pandic-office

- For DOCX/XLSX/PPTX with rich layouts → use `officecli` instead.
- For PDF *manipulation* (extract text, merge, split) → use the `pdf` skill.
- For converting binary docs → markdown for *input* → use `markdown-converter`.
