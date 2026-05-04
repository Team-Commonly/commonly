---
name: markdown-converter
description: Convert binary documents (PDF, DOCX, XLSX, PPTX, HTML, EPUB, images) to clean LLM-friendly Markdown using Microsoft's `markitdown` Python tool. Use when a user attaches a binary file and you need to read its contents.
---

# markdown-converter — binary doc → markdown for agent input

`markitdown` is installed via `pip3 install markitdown` and is on PATH. It
extracts text content from a wide range of binary formats and emits clean
markdown that's efficient for LLM context.

## Supported input formats

PDF, DOCX, XLSX, PPTX, HTML, EPUB, images (with OCR), CSV, JSON, audio
transcripts, ZIP archives.

## Basic usage

```bash
# Convert a single file to markdown on stdout
markitdown /workspace/$(basename "$PWD")/input.pdf

# Save to a markdown file
markitdown /workspace/$(basename "$PWD")/input.docx > /workspace/$(basename "$PWD")/input.md

# Convert and pipe directly into another tool
markitdown /workspace/$(basename "$PWD")/spec.xlsx | head -200
```

## Reading a user-attached file

Files attached by users are downloaded to the agent workspace by the gateway.
Once you have a workspace path:

```bash
# 1. Convert the binary to markdown
markitdown /workspace/$(basename "$PWD")/uploads/report.pdf > /tmp/report.md

# 2. Read the markdown into your context
cat /tmp/report.md
```

Then summarize, answer questions about it, or feed sections back to the user.

## Useful flags

| Flag | Effect |
|------|--------|
| `--use-docintel <ENDPOINT>` | Use Azure Doc Intelligence (requires API key) for OCR-heavy PDFs |
| `-o <file>` | Write to file instead of stdout |

## When NOT to use markdown-converter

- For *producing* documents (md → DOCX/PDF/XLSX) → use `officecli` or
  `pandic-office` instead.
- For PDF manipulation (extract specific pages, merge files) → use the `pdf`
  skill.

## Troubleshooting

- **OCR-heavy scanned PDF returns garbage** — markitdown uses basic text
  extraction. If the PDF is image-only, the result will be empty or unhelpful.
  Mention this limitation to the user.
- **XLSX with charts** — markitdown extracts cell data but ignores embedded
  charts. For chart inspection, render the workbook to HTML first via
  `officecli view <file> html`.
