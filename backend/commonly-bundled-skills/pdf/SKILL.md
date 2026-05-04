---
name: pdf
description: Manipulate PDF files — extract text, count pages, render thumbnails, merge or split documents. Use for PDF-specific operations that don't fit `markdown-converter` (general read) or `pandic-office` (write from markdown).
---

# pdf — PDF manipulation toolkit

The gateway image ships:
- `pdftotext`, `pdftoppm`, `pdfinfo` from `poppler-utils` (apt)
- `pypdf` (Python) for programmatic merge / split / metadata edits

## Common operations

### Extract text from a PDF

```bash
pdftotext /workspace/$(basename "$PWD")/input.pdf /workspace/$(basename "$PWD")/input.txt
# Or stream to stdout:
pdftotext /workspace/$(basename "$PWD")/input.pdf -
```

For LLM-friendly output, prefer the `markdown-converter` skill (which uses
markitdown and handles tables better). Use `pdftotext` only when you need
raw text quickly.

### Count pages

```bash
pdfinfo /workspace/$(basename "$PWD")/input.pdf | grep Pages
```

### Render a page to PNG (preview / OCR input)

```bash
# All pages → PNG at 150dpi
pdftoppm -png -r 150 /workspace/$(basename "$PWD")/input.pdf /workspace/$(basename "$PWD")/page

# Just page 1
pdftoppm -png -r 150 -f 1 -l 1 /workspace/$(basename "$PWD")/input.pdf /workspace/$(basename "$PWD")/cover
```

### Merge multiple PDFs

```python
python3 - <<'PY'
from pypdf import PdfWriter
w = PdfWriter()
for f in ["a.pdf", "b.pdf", "c.pdf"]:
    w.append(f)
w.write("/workspace/$(basename "$PWD")/merged.pdf")
PY
```

### Split a PDF into per-page files

```python
python3 - <<'PY'
from pypdf import PdfReader, PdfWriter
r = PdfReader("/workspace/$(basename "$PWD")/input.pdf")
for i, page in enumerate(r.pages):
    w = PdfWriter()
    w.add_page(page)
    w.write(f"/workspace/$(basename "$PWD")/page_{i+1}.pdf")
PY
```

### Edit PDF metadata

```python
python3 - <<'PY'
from pypdf import PdfReader, PdfWriter
r = PdfReader("/workspace/$(basename "$PWD")/input.pdf")
w = PdfWriter(clone_from=r)
w.add_metadata({"/Title": "New Title", "/Author": "Theo"})
w.write("/workspace/$(basename "$PWD")/output.pdf")
PY
```

## When NOT to use this skill

- To *read* a PDF for context — use `markdown-converter` (cleaner output).
- To *create* a PDF from markdown — use `pandic-office` (pandoc).
- To create or edit Office docs (DOCX/XLSX/PPTX) — use `officecli`.
