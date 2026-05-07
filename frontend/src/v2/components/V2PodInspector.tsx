import React, { useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import Papa from 'papaparse';
import { useNavigate } from 'react-router-dom';
import V2Avatar from './V2Avatar';
import { UseV2PodDetailResult, V2Agent } from '../hooks/useV2PodDetail';
import { UseV2PodsResult } from '../hooks/useV2Pods';
import { useV2Api } from '../hooks/useV2Api';
import { useAuth } from '../../context/AuthContext';
import { getSignedAttachmentUrl } from '../../utils/signedAttachmentUrl';
import getApiBaseUrl from '../../utils/apiBaseUrl';
import type { InspectorView } from './V2Layout';

interface V2PodInspectorProps {
  detail: UseV2PodDetailResult;
  podsState?: UseV2PodsResult;
  view: InspectorView;
  // V2Layout decides whether to mount this at all; collapsed-state used to
  // be rendered as a thin chevron column, but the entry is now the chat
  // header avatar group + clicks on author bylines (see V2PodChat /
  // V2MessageBubble). onClose dismisses; onBack pops to overview.
  onClose?: () => void;
  onOpenMember: (agentKey: string) => void;
  onOpenArtifact: (artifactId: string) => void;
  onBack: () => void;
  // Opens the shared invite modal (rendered by V2Layout). When provided,
  // the members-section "+ Invite" button delegates here instead of
  // owning local modal state — same modal instance is reused by the chat
  // header invite icon, so the invite link survives switching between
  // the two trigger surfaces.
  onOpenInvite?: () => void;
  // Click-on-file-pill flow. V2Layout sets this when a chat file pill is
  // clicked; the inspector watches for the value to change, resolves it
  // against its loaded podFiles list (matching either ObjectStore key OR
  // originalName), opens the matching artifact sub-page, and clears the
  // pending value via onPendingOpenFileNameConsumed. Falls back to a no-op
  // if the file isn't in the pod's files index (avoid silent re-routes if
  // the file name resolves nowhere).
  pendingOpenFileName?: string | null;
  onPendingOpenFileNameConsumed?: () => void;
}

// Any agent with a real chat runtime can hold a DM session. The Tier 1
// internal services (commonly-bot summarizer, pod-summarizer) don't have a
// runtime that responds to chat — they're cron / event-driven only.
//
// Previously this was hardcoded to `agent.name === 'openclaw'`, which
// silently excluded every other runtime — Claude Code wrappers, Codex
// wrappers, stub adapters, webhook bots, native runtime agents. Anyone
// installing an agent via `commonly agent attach <claude|codex|...>`
// got an agent that worked end-to-end EXCEPT that the inspector's
// "Talk to" button never appeared.
//
// Gate now reads from the resolved runtime: any non-internal runtime
// is dmable. Falls back to `false` for unknown payload shapes.
const isAgentDmable = (agent: { runtime?: { runtimeType?: string } | null }): boolean => {
  const t = agent?.runtime?.runtimeType;
  if (!t) return false;
  // Tier 1 native services — no chat runtime, no DM target.
  if (t === 'internal') return false;
  return true;
};

interface AgentTaskMap {
  [agentName: string]: { taskId: string; title: string; status: string } | null;
}

interface TaskApiResponse {
  tasks: Array<{ taskId: string; title: string; status: string; assignee?: string; updatedAt?: string }>;
}

interface AnnouncementItem {
  _id: string;
  title?: string;
  content?: string;
  createdAt?: string;
}

interface ExternalLinkItem {
  _id: string;
  name?: string;
  type?: string;
  url?: string;
}

interface PodFileItem {
  _id: string;
  fileName: string;
  originalName: string;
  contentType?: string;
  size?: number;
  createdAt?: string;
}

// Per-type label for the Artifacts row icon (1-2 char glyph) and the
// human-readable kind shown under the title. Keep aligned with the enum in
// `backend/models/ExternalLink.ts`. Unknown kinds fall back to "L" / "Link".
const ARTIFACT_KIND_META: Record<string, { icon: string; label: string }> = {
  Announcement: { icon: 'AN', label: 'Announcement' },
  notion: { icon: 'N', label: 'Notion' },
  google_doc: { icon: 'GD', label: 'Google Doc' },
  google_sheet: { icon: 'GS', label: 'Google Sheet' },
  google_slides: { icon: 'GP', label: 'Google Slides' },
  google_drive: { icon: 'DR', label: 'Google Drive' },
  figma: { icon: 'F', label: 'Figma' },
  zoom: { icon: 'Z', label: 'Zoom' },
  gmail: { icon: 'GM', label: 'Gmail' },
  github_pr: { icon: 'PR', label: 'GitHub PR' },
  github_issue: { icon: 'IS', label: 'GitHub Issue' },
  github_repo: { icon: 'GH', label: 'GitHub Repo' },
  youtube: { icon: 'YT', label: 'YouTube' },
  loom: { icon: 'LM', label: 'Loom' },
  discord: { icon: 'DC', label: 'Discord' },
  telegram: { icon: 'TG', label: 'Telegram' },
  wechat: { icon: 'WX', label: 'WeChat' },
  groupme: { icon: 'GR', label: 'GroupMe' },
  other: { icon: 'L', label: 'Link' },
  other_link: { icon: 'L', label: 'Link' },
  // Uploaded-file kinds — derived from extension by `fileKind()` below. Same
  // visual treatment as URL artifacts so the inspector list stays uniform.
  pdf: { icon: 'PDF', label: 'PDF' },
  md: { icon: 'MD', label: 'Markdown' },
  txt: { icon: 'TXT', label: 'Text' },
  csv: { icon: 'CSV', label: 'CSV' },
  json: { icon: 'JS', label: 'JSON' },
  doc: { icon: 'DOC', label: 'Word' },
  docx: { icon: 'DOC', label: 'Word' },
  xls: { icon: 'XLS', label: 'Excel' },
  xlsx: { icon: 'XLS', label: 'Excel' },
  ppt: { icon: 'PPT', label: 'PowerPoint' },
  pptx: { icon: 'PPT', label: 'PowerPoint' },
  odt: { icon: 'ODT', label: 'OpenDocument' },
  ods: { icon: 'ODS', label: 'OpenDocument Sheet' },
  odp: { icon: 'ODP', label: 'OpenDocument Slides' },
  zip: { icon: 'ZIP', label: 'Archive' },
  image: { icon: 'IMG', label: 'Image' },
  file: { icon: 'F', label: 'File' },
};

const FILE_EXTENSION_KINDS = new Set([
  'pdf', 'md', 'txt', 'csv', 'json',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'odt', 'ods', 'odp', 'zip',
]);

// Map a file's extension to one of the keys in ARTIFACT_KIND_META so the
// uploaded-file rows pick up the right icon/label without re-deriving in JSX.
const fileKind = (originalName: string, contentType?: string): string => {
  const dot = originalName.lastIndexOf('.');
  const ext = dot >= 0 ? originalName.slice(dot + 1).toLowerCase() : '';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(ext)) return 'image';
  if (FILE_EXTENSION_KINDS.has(ext)) return ext;
  if (contentType?.startsWith('image/')) return 'image';
  return 'file';
};

const artifactMeta = (kind: string): { icon: string; label: string } =>
  ARTIFACT_KIND_META[kind] || { icon: kind.slice(0, 2).toUpperCase() || 'L', label: 'Link' };

// Defense-in-depth at render time: never put a `javascript:` / `data:` /
// `file:` URL into an <a href>. The POST endpoint enforces this server-side
// (routes/pods.ts isSafeHttpUrl), but pre-existing rows from the v1 ChatRoom
// flow are not guaranteed to be safe.
const safeHref = (raw?: string): string | undefined => {
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    return (u.protocol === 'http:' || u.protocol === 'https:') ? raw : undefined;
  } catch {
    return undefined;
  }
};

// ---- Artifact preview helpers ---------------------------------------------
// Embedabble URLs for the URL-artifact kinds whose vendor allows iframe.
// Notion/Drive/Docs return X-Frame-Options=DENY for unauth viewers, so they
// stay click-through-only. YouTube/Loom/Figma have first-class embed flows.
const embedUrlFor = (kind: string, raw?: string): string | undefined => {
  const url = safeHref(raw);
  if (!url) return undefined;
  try {
    const u = new URL(url);
    if (kind === 'youtube') {
      // youtu.be/<id>, youtube.com/watch?v=<id>, youtube.com/shorts/<id>
      let id = '';
      if (u.hostname.endsWith('youtu.be')) id = u.pathname.slice(1).split('/')[0];
      else if (u.pathname.startsWith('/watch')) id = u.searchParams.get('v') || '';
      else if (u.pathname.startsWith('/shorts/')) id = u.pathname.split('/')[2] || '';
      else if (u.pathname.startsWith('/embed/')) id = u.pathname.split('/')[2] || '';
      if (!id) return undefined;
      return `https://www.youtube.com/embed/${encodeURIComponent(id)}`;
    }
    if (kind === 'loom') {
      // loom.com/share/<id>
      const m = u.pathname.match(/\/share\/([a-zA-Z0-9]+)/);
      if (!m) return undefined;
      return `https://www.loom.com/embed/${m[1]}`;
    }
    if (kind === 'figma') {
      // Figma's official embed is https://www.figma.com/embed?embed_host=...&url=<original>
      return `https://www.figma.com/embed?embed_host=commonly&url=${encodeURIComponent(url)}`;
    }
  } catch {
    return undefined;
  }
  return undefined;
};

// Cap inline text fetches so a 50MB log file doesn't lock the inspector.
const PREVIEW_TEXT_CAP_BYTES = 200 * 1024;

// Hook: load the file's signed URL once per (fileName) and surface as a
// stateful value the preview components can render against.
const useSignedFileUrl = (fileName?: string): { url: string | null; loading: boolean } => {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(!!fileName);
  useEffect(() => {
    if (!fileName) { setUrl(null); setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    void getSignedAttachmentUrl(`/api/uploads/${fileName}`).then((u) => {
      if (cancelled) return;
      setUrl(u || null);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [fileName]);
  return { url, loading };
};

// Hook: fetch the bytes of a signed URL as text, with a size cap so previews
// of huge files don't lock the inspector. Returns `truncated:true` when the
// response exceeded PREVIEW_TEXT_CAP_BYTES.
const useTextPreview = (signedUrl: string | null): {
  text: string | null;
  truncated: boolean;
  error: string | null;
  loading: boolean;
} => {
  const [text, setText] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(!!signedUrl);
  useEffect(() => {
    if (!signedUrl) { setText(null); setLoading(false); return; }
    let cancelled = false;
    setLoading(true); setError(null);
    (async () => {
      try {
        const res = await fetch(signedUrl);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        // Read up to the cap; abort the rest so we don't pull megabytes.
        const reader = res.body?.getReader();
        if (!reader) {
          const t = await res.text();
          if (cancelled) return;
          setTruncated(t.length > PREVIEW_TEXT_CAP_BYTES);
          setText(t.slice(0, PREVIEW_TEXT_CAP_BYTES));
          setLoading(false);
          return;
        }
        const decoder = new TextDecoder('utf-8', { fatal: false });
        let acc = '';
        let exceeded = false;
        // eslint-disable-next-line no-await-in-loop
        for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
          acc += decoder.decode(chunk.value, { stream: true });
          if (acc.length >= PREVIEW_TEXT_CAP_BYTES) { exceeded = true; reader.cancel(); break; }
        }
        if (cancelled) return;
        setTruncated(exceeded);
        setText(acc.slice(0, PREVIEW_TEXT_CAP_BYTES));
        setLoading(false);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Could not load file');
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [signedUrl]);
  return { text, truncated, error, loading };
};

interface PreviewArtifact {
  kind: string;
  fileName?: string;
  url?: string;
  title: string;
}

const PreviewBox: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div
    style={{
      border: '1px solid var(--v2-border)',
      borderRadius: 'var(--v2-radius-sm)',
      background: 'var(--v2-surface)',
      overflow: 'hidden',
    }}
  >
    {children}
  </div>
);

const PreviewMute: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ padding: 12, fontSize: 12, color: 'var(--v2-text-tertiary)' }}>{children}</div>
);

const ImagePreview: React.FC<{ artifact: PreviewArtifact }> = ({ artifact }) => {
  const { url, loading } = useSignedFileUrl(artifact.fileName);
  if (loading) return <PreviewBox><PreviewMute>Loading…</PreviewMute></PreviewBox>;
  if (!url) return null;
  return (
    <PreviewBox>
      <img src={url} alt={artifact.title} style={{ width: '100%', display: 'block', maxHeight: 480, objectFit: 'contain', background: '#fafafa' }} />
    </PreviewBox>
  );
};

const PdfPreview: React.FC<{ artifact: PreviewArtifact }> = ({ artifact }) => {
  const { url, loading } = useSignedFileUrl(artifact.fileName);
  if (loading) return <PreviewBox><PreviewMute>Loading PDF…</PreviewMute></PreviewBox>;
  if (!url) return null;
  return (
    <PreviewBox>
      <iframe
        title={artifact.title}
        src={url}
        style={{ width: '100%', height: 480, border: 'none', display: 'block' }}
      />
    </PreviewBox>
  );
};

const TextPreview: React.FC<{ artifact: PreviewArtifact; markdown?: boolean; pretty?: boolean }> = ({ artifact, markdown, pretty }) => {
  const { url } = useSignedFileUrl(artifact.fileName);
  const { text, truncated, error, loading } = useTextPreview(url);
  if (loading) return <PreviewBox><PreviewMute>Loading…</PreviewMute></PreviewBox>;
  if (error) return <PreviewBox><PreviewMute>Could not load: {error}</PreviewMute></PreviewBox>;
  if (text == null) return null;
  // For JSON, try to pretty-print; on parse failure fall through to raw.
  let body = text;
  if (pretty) {
    try { body = JSON.stringify(JSON.parse(text), null, 2); } catch { /* leave as-is */ }
  }
  return (
    <PreviewBox>
      {markdown ? (
        <div className="v2-msg__content" style={{ padding: '12px 14px', maxHeight: 480, overflow: 'auto' }}>
          <ReactMarkdown>{body}</ReactMarkdown>
        </div>
      ) : (
        <pre style={{
          margin: 0, padding: '12px 14px', maxHeight: 480, overflow: 'auto',
          fontFamily: '"SF Mono", ui-monospace, "Menlo", monospace',
          fontSize: 12, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        }}>{body}</pre>
      )}
      {truncated && <PreviewMute>Preview truncated at 200 KB. Click Open for the full file.</PreviewMute>}
    </PreviewBox>
  );
};

const CsvPreview: React.FC<{ artifact: PreviewArtifact }> = ({ artifact }) => {
  const { url } = useSignedFileUrl(artifact.fileName);
  const { text, truncated, error, loading } = useTextPreview(url);
  if (loading) return <PreviewBox><PreviewMute>Loading CSV…</PreviewMute></PreviewBox>;
  if (error) return <PreviewBox><PreviewMute>Could not load: {error}</PreviewMute></PreviewBox>;
  if (!text) return null;
  // RFC 4180 parsing via papaparse — handles quoted commas, escaped quotes,
  // and multi-line cells. The hand-roll we shipped previously broke on real
  // spreadsheet exports.
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: true });
  const rows = parsed.data;
  if (rows.length === 0) return <PreviewBox><PreviewMute>Empty file</PreviewMute></PreviewBox>;
  const PREVIEW_ROW_CAP = 20;
  const [headerRow, ...allBodyRows] = rows;
  const bodyRows = allBodyRows.slice(0, PREVIEW_ROW_CAP);
  const moreRows = Math.max(0, allBodyRows.length - PREVIEW_ROW_CAP);
  return (
    <PreviewBox>
      <div style={{ maxHeight: 360, overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr>
              {headerRow.map((h, i) => (
                <th key={i} style={{ textAlign: 'left', padding: '6px 10px', borderBottom: '1px solid var(--v2-border)', fontWeight: 600, position: 'sticky', top: 0, background: 'var(--v2-surface)' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {bodyRows.map((row, i) => (
              <tr key={i}>
                {row.map((c, j) => (
                  <td key={j} style={{ padding: '6px 10px', borderBottom: '1px solid var(--v2-border)' }}>{c}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {(truncated || moreRows > 0) && (
        <PreviewMute>
          {truncated
            ? 'Preview truncated at 200 KB. Click Open for the full file.'
            : `${moreRows} more row${moreRows === 1 ? '' : 's'} not shown. Click Open for the full file.`}
        </PreviewMute>
      )}
    </PreviewBox>
  );
};

// Word .docx → HTML via mammoth (~200 KB, fully client-side). Lazy-load so
// inspectors that never see a Word file don't pay the bundle cost. Format
// loss is acceptable for preview — mammoth produces clean semantic HTML
// (headings, lists, tables, bold/italic) and skips rare inline shapes. For
// pixel-faithful render the user clicks Open and uses Word / Office Online.
const DocxPreview: React.FC<{ artifact: PreviewArtifact }> = ({ artifact }) => {
  const { url, loading: urlLoading } = useSignedFileUrl(artifact.fileName);
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    setBusy(true); setError(null); setHtml(null);
    (async () => {
      try {
        const [mod, ab] = await Promise.all([
          import('mammoth/mammoth.browser'),
          fetch(url).then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.arrayBuffer();
          }),
        ]);
        if (cancelled) return;
        // mammoth.browser is a UMD module. Vite's CJS interop wraps it
        // inconsistently — sometimes the API lives at `mod.default`,
        // sometimes at a single-letter chunk-export like `mod.m`. Walk
        // through known shapes until we find one with `convertToHtml`.
        type MammothLib = { convertToHtml: (opts: { arrayBuffer: ArrayBuffer }) => Promise<{ value: string }> };
        const lib = ((): MammothLib => {
          const candidates: unknown[] = [
            (mod as { default?: unknown }).default,
            ...Object.values(mod as Record<string, unknown>),
            mod,
          ];
          for (const c of candidates) {
            if (c && typeof (c as Partial<MammothLib>).convertToHtml === 'function') {
              return c as MammothLib;
            }
          }
          throw new Error('mammoth module shape unrecognized');
        })();
        const result = await lib.convertToHtml({ arrayBuffer: ab });
        if (cancelled) return;
        setHtml(result.value || '');
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Could not load document');
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => { cancelled = true; };
  }, [url]);
  if (urlLoading || busy) return <PreviewBox><PreviewMute>Rendering Word document…</PreviewMute></PreviewBox>;
  if (error) return <PreviewBox><PreviewMute>Could not preview: {error}</PreviewMute></PreviewBox>;
  // mammoth returns "" (not null) when the docx body has no paragraphs/runs,
  // so html=="" is the empty-document signal. Surface a placeholder rather
  // than rendering nothing — matches the XlsxPreview empty-sheet UX.
  if (html === '') return <PreviewBox><PreviewMute>Empty document</PreviewMute></PreviewBox>;
  if (!html) return null;
  return (
    <PreviewBox>
      <div
        className="v2-msg__content"
        style={{ padding: '14px 16px', maxHeight: 480, overflow: 'auto', fontSize: 13, lineHeight: 1.55 }}
        // mammoth output is sanitized HTML produced from a binary docx —
        // not user-controlled markup. Same trust model as the docx itself,
        // which was uploaded by an authenticated pod member or agent.
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </PreviewBox>
  );
};

// Excel .xlsx → HTML via SheetJS (~600KB, lazy-loaded). Renders the first
// sheet by default with a tab strip when the workbook has multiple sheets.
// SheetJS produces a <table> for each sheet; we wrap it in our scroll
// container and add light styling so it doesn't dump unstyled rows.
const XlsxPreview: React.FC<{ artifact: PreviewArtifact }> = ({ artifact }) => {
  const { url, loading: urlLoading } = useSignedFileUrl(artifact.fileName);
  const [sheets, setSheets] = useState<{ name: string; html: string }[] | null>(null);
  const [activeSheet, setActiveSheet] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    setBusy(true); setError(null); setSheets(null); setActiveSheet(0);
    (async () => {
      try {
        const [XLSX, ab] = await Promise.all([
          import('xlsx'),
          fetch(url).then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.arrayBuffer();
          }),
        ]);
        if (cancelled) return;
        const wb = XLSX.read(ab, { type: 'array' });
        const out = wb.SheetNames.map((name) => {
          const ws = wb.Sheets[name];
          // Defend against empty sheets and sheets missing `!ref`. SheetJS's
          // sheet_to_html throws "Cannot read properties of undefined
          // (reading 'indexOf')" when the worksheet's range header isn't
          // populated — common for sheets emitted by tools that produce
          // <sheetData/> with no rows. We synthesize a range from the cell
          // keys so non-empty sheets without an explicit range still render,
          // and fall back to a placeholder for genuinely empty sheets.
          const cellKeys = Object.keys(ws || {}).filter((k) => !k.startsWith('!'));
          if (cellKeys.length === 0) {
            return { name, html: '<p style="color:#888;font-style:italic">Empty sheet</p>' };
          }
          if (!ws['!ref']) {
            try {
              const range = cellKeys.reduce(
                (acc, k) => {
                  const c = XLSX.utils.decode_cell(k);
                  if (c.r < acc.s.r) acc.s.r = c.r;
                  if (c.c < acc.s.c) acc.s.c = c.c;
                  if (c.r > acc.e.r) acc.e.r = c.r;
                  if (c.c > acc.e.c) acc.e.c = c.c;
                  return acc;
                },
                { s: { r: Infinity, c: Infinity }, e: { r: -1, c: -1 } },
              );
              ws['!ref'] = XLSX.utils.encode_range(range);
            } catch { /* fall through; sheet_to_html will throw and we'll catch below */ }
          }
          try {
            return { name, html: XLSX.utils.sheet_to_html(ws, { header: '', footer: '' }) };
          } catch (cellErr) {
            return { name, html: `<p style="color:#888;font-style:italic">Could not render sheet: ${(cellErr as Error).message}</p>` };
          }
        });
        if (cancelled) return;
        setSheets(out);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Could not load workbook');
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => { cancelled = true; };
  }, [url]);
  if (urlLoading || busy) return <PreviewBox><PreviewMute>Rendering Excel workbook…</PreviewMute></PreviewBox>;
  if (error) return <PreviewBox><PreviewMute>Could not preview: {error}</PreviewMute></PreviewBox>;
  if (!sheets || sheets.length === 0) return null;
  const current = sheets[Math.min(activeSheet, sheets.length - 1)];
  return (
    <PreviewBox>
      {sheets.length > 1 && (
        <div style={{
          display: 'flex', gap: 4, padding: '8px 10px',
          borderBottom: '1px solid var(--v2-border)',
          background: 'var(--v2-surface-subtle, #fafafa)',
          overflowX: 'auto',
        }}>
          {sheets.map((s, i) => (
            <button
              key={s.name}
              type="button"
              onClick={() => setActiveSheet(i)}
              style={{
                padding: '4px 10px', fontSize: 12, border: 'none',
                background: i === activeSheet ? 'var(--v2-surface)' : 'transparent',
                borderRadius: 4, cursor: 'pointer',
                fontWeight: i === activeSheet ? 600 : 400,
              }}
            >{s.name}</button>
          ))}
        </div>
      )}
      <div
        style={{ maxHeight: 440, overflow: 'auto', padding: '10px 12px', fontSize: 12 }}
        // SheetJS sheet_to_html produces a sanitized <table>...</table> from a
        // binary xlsx. Same trust model as the docx — uploaded by an
        // authenticated pod member or agent. We add minimal CSS via the
        // wrapper to give cells some breathing room without bloating output.
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{
          __html: current.html.replace(
            '<table',
            '<table style="border-collapse:collapse;width:100%" border="1" cellpadding="6"',
          ),
        }}
      />
    </PreviewBox>
  );
};

// PowerPoint .pptx → HTML via the backend's officecli view html endpoint.
// The HTML is officecli's own renderer output (slides as styled blocks);
// we sandbox it inside an iframe via srcdoc so its scripts (three.js loader)
// can't touch the host page.
const PptxPreview: React.FC<{ artifact: PreviewArtifact }> = ({ artifact }) => {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!artifact.fileName) return;
    let cancelled = false;
    setBusy(true); setError(null); setHtml(null);
    (async () => {
      try {
        const r = await fetch(`${getApiBaseUrl()}/api/uploads/${encodeURIComponent(artifact.fileName!)}/preview-pptx-html`);
        if (cancelled) return;
        if (!r.ok) {
          // Surface a useful error from the JSON body if available
          let detail = '';
          try { detail = (await r.json())?.detail || ''; } catch { /* not JSON */ }
          throw new Error(`HTTP ${r.status}${detail ? ` — ${detail.substring(0, 200)}` : ''}`);
        }
        const text = await r.text();
        if (cancelled) return;
        // Detect zero-slide deck: officecli's renderer wraps the document in
        // <div class="slide">N times. If there are no slide divs, the deck
        // is empty (e.g. <p:sldIdLst/>) — show the parity placeholder rather
        // than rendering the empty canvas with "1 / 0" pagination.
        const slideCount = (text.match(/<div\s+class="slide"/g) || []).length;
        if (slideCount === 0) {
          setHtml('');
        } else {
          setHtml(text);
        }
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Could not render preview');
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => { cancelled = true; };
  }, [artifact.fileName]);
  if (busy) return <PreviewBox><PreviewMute>Rendering PowerPoint deck…</PreviewMute></PreviewBox>;
  if (error) return <PreviewBox><PreviewMute>Could not preview: {error}</PreviewMute></PreviewBox>;
  // Empty string == zero-slide deck (set above); render the same placeholder
  // shape DocxPreview/XlsxPreview use for genuinely-empty deliverables.
  if (html === '') return <PreviewBox><PreviewMute>Empty deck</PreviewMute></PreviewBox>;
  if (!html) return null;
  return (
    <PreviewBox>
      <iframe
        title={artifact.title}
        srcDoc={html}
        sandbox="allow-scripts allow-same-origin"
        style={{ width: '100%', height: 480, border: 'none', display: 'block', background: '#fff' }}
      />
    </PreviewBox>
  );
};

const EmbedPreview: React.FC<{ src: string; title: string; allow?: string }> = ({ src, title, allow }) => (
  <PreviewBox>
    <iframe
      title={title}
      src={src}
      allow={allow}
      allowFullScreen
      style={{ width: '100%', height: 480, border: 'none', display: 'block' }}
    />
  </PreviewBox>
);

const ArtifactPreview: React.FC<{ artifact: PreviewArtifact }> = ({ artifact }) => {
  const { kind } = artifact;
  // File previews — gated on having a fileName (i.e. it came from /api/uploads)
  if (artifact.fileName) {
    if (kind === 'image') return <ImagePreview artifact={artifact} />;
    if (kind === 'pdf') return <PdfPreview artifact={artifact} />;
    if (kind === 'md') return <TextPreview artifact={artifact} markdown />;
    if (kind === 'txt') return <TextPreview artifact={artifact} />;
    if (kind === 'json') return <TextPreview artifact={artifact} pretty />;
    if (kind === 'csv') return <CsvPreview artifact={artifact} />;
    if (kind === 'docx') return <DocxPreview artifact={artifact} />;
    if (kind === 'xlsx') return <XlsxPreview artifact={artifact} />;
    if (kind === 'pptx') return <PptxPreview artifact={artifact} />;
    return null; // doc / xls / ppt / odt / ods / odp / zip — Open only
  }
  // URL artifacts — embed where the vendor allows iframe.
  const embed = embedUrlFor(kind, artifact.url);
  if (embed) {
    const allow = kind === 'youtube' ? 'accelerometer; encrypted-media; gyroscope; picture-in-picture' : undefined;
    return <EmbedPreview src={embed} title={artifact.title} allow={allow} />;
  }
  return null;
};

interface RunStateCounts {
  blocked: number;
  inProgress: number;
  complete: number;
  pending: number;
}

const Icon = ({ d, size = 14 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
);

const agentKeyOf = (agent: V2Agent): string => agent.instanceId || agent.agentName;

// Driver badge for the agent runtime — letterform monogram + label, no emoji.
// `runtimeType` carries identity (codex / claude-code / openclaw / etc.);
// `host` carries location ('cloud' = Commonly-managed, 'byo' = user runs it
// themselves, ADR-005-style — laptop or their own server). The two are
// orthogonal: a codex agent can be cloud-hosted or BYO and the badge shows
// the same identity, with a small "BYO" tag rendered alongside when host=byo.
// Cloud is the implicit default and gets no decoration to keep chrome quiet.
//
// Backwards compat: legacy `local-cli` + `wrappedCli` (pre-2026-05-04 CLI
// attach) is normalized server-side by sanitizeRuntimeConfig — but we still
// branch on it here as defense-in-depth in case the frontend sees an
// unmigrated payload from an older backend.
const resolveRuntimeBadge = (
  agent: V2Agent,
): { mono: string; label: string; isByo: boolean } | null => {
  const type = agent.runtime?.runtimeType;
  const wrappedCli = agent.runtime?.wrappedCli;
  const host = agent.runtime?.host;
  const isByo = host === 'byo';

  // Identity → mono + label.
  let identity: { mono: string; label: string } | null = null;
  if (type === 'moltbot') identity = { mono: 'OC', label: 'OpenClaw' };
  else if (type === 'codex' || (type === 'local-cli' && wrappedCli === 'codex')) identity = { mono: 'CX', label: 'Codex' };
  else if (type === 'claude-code' || (type === 'local-cli' && wrappedCli === 'claude')) identity = { mono: 'CC', label: 'Claude Code' };
  else if (type === 'gemini' || (type === 'local-cli' && wrappedCli === 'gemini')) identity = { mono: 'GE', label: 'Gemini' };
  else if (type === 'webhook') identity = { mono: 'WH', label: 'Webhook' };
  else if (type === 'internal') identity = { mono: 'NA', label: 'Native' };
  else if (type === 'local-cli') identity = { mono: 'LC', label: 'Local CLI' };

  if (!identity) return null;
  return { ...identity, isByo: isByo || type === 'local-cli' };
};

const memberRoleLabel = (
  member: { _id?: string; isBot?: boolean },
  ownerId: string | undefined,
  isAgent: boolean,
): 'Owner' | 'Human' | 'AI Agent' => {
  if (ownerId && member._id === ownerId) return 'Owner';
  if (isAgent || member.isBot) return 'AI Agent';
  return 'Human';
};

const V2PodInspector: React.FC<V2PodInspectorProps> = ({
  detail, podsState, view, onClose, onOpenMember, onOpenArtifact, onBack, onOpenInvite,
  pendingOpenFileName, onPendingOpenFileNameConsumed,
}) => {
  const { pod, members, agents } = detail;
  const api = useV2Api();
  const navigate = useNavigate();
  const { currentUser } = useAuth();
  const [agentTasks, setAgentTasks] = useState<AgentTaskMap>({});
  const [runState, setRunState] = useState<RunStateCounts>({ blocked: 0, inProgress: 0, complete: 0, pending: 0 });
  const [privateError, setPrivateError] = useState<string | null>(null);
  const [announcements, setAnnouncements] = useState<AnnouncementItem[]>([]);
  const [externalLinks, setExternalLinks] = useState<ExternalLinkItem[]>([]);
  const [podFiles, setPodFiles] = useState<PodFileItem[]>([]);
  const [tab, setTab] = useState<'overview' | 'members' | 'tasks' | 'manage'>('overview');
  const [addLinkOpen, setAddLinkOpen] = useState(false);
  const [addLinkUrl, setAddLinkUrl] = useState('');
  const [addLinkBusy, setAddLinkBusy] = useState(false);
  const [addLinkError, setAddLinkError] = useState<string | null>(null);
  // Invite modal lives on V2Layout — see `onOpenInvite` prop. The members
  // section "+ Invite" button delegates upward so the chat header invite
  // icon and the inspector button share one modal instance.

  // Map agent username (`openclaw-nova`) → agent record so we can look up by
  // either instance id or full username when chat clicks come in.
  const agentByKey = useMemo(() => {
    const map = new Map<string, V2Agent>();
    agents.forEach((a) => {
      const id = agentKeyOf(a);
      if (id) map.set(id, a);
      const u = `${a.agentName}-${a.instanceId || 'default'}`;
      map.set(u, a);
    });
    return map;
  }, [agents]);

  // Set of usernames that map to an installed agent — used to filter the
  // members[] list down to actual humans. The backend's `User.isBot` flag
  // isn't reliably set on agent User rows in the wire payload, so we can't
  // trust `member.isBot` alone. Mirrors AgentIdentityService.buildAgentUsername.
  const agentUsernames = useMemo(() => {
    const set = new Set<string>();
    agents.forEach((a) => {
      const rawName = ((a as { name?: string; agentName?: string }).name || a.agentName || '').toLowerCase();
      const inst = (a.instanceId || '').toLowerCase();
      const username = !inst || inst === 'default' || inst === rawName
        ? rawName
        : `${rawName}-${inst}`;
      if (username) set.add(username);
    });
    return set;
  }, [agents]);

  const humanMembers = useMemo(
    () => members.filter((m) => {
      if (m.isBot) return false;
      const u = (m.username || '').toLowerCase();
      return u && !agentUsernames.has(u);
    }),
    [members, agentUsernames],
  );

  useEffect(() => {
    const podId = pod?._id;
    if (!podId) {
      setAgentTasks({});
      setRunState({ blocked: 0, inProgress: 0, complete: 0, pending: 0 });
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const data = await api.get<TaskApiResponse>(`/api/v1/tasks/${podId}`);
        const tasks = data.tasks || [];
        // Per-agent "Working on" — first matching active task.
        const map: AgentTaskMap = {};
        agents.forEach((a) => {
          const key = agentKeyOf(a);
          const match = tasks.find((t) => {
            const assignee = (t.assignee || '').toLowerCase();
            const isActive = t.status === 'pending' || t.status === 'claimed' || t.status === 'in_progress';
            if (!isActive) return false;
            return assignee && (
              assignee === (a.instanceId || '').toLowerCase()
              || assignee === (a.agentName || '').toLowerCase()
              || assignee === (a.displayName || '').toLowerCase()
            );
          });
          map[key] = match ? { taskId: match.taskId, title: match.title, status: match.status } : null;
        });
        // Run-state pill counts.
        const counts: RunStateCounts = { blocked: 0, inProgress: 0, complete: 0, pending: 0 };
        tasks.forEach((t) => {
          switch (t.status) {
            case 'blocked':
              counts.blocked += 1;
              break;
            case 'claimed':
            case 'in_progress':
              counts.inProgress += 1;
              break;
            case 'done':
            case 'completed':
              counts.complete += 1;
              break;
            case 'pending':
              counts.pending += 1;
              break;
            default:
              break;
          }
        });
        if (!cancelled) {
          setAgentTasks(map);
          setRunState(counts);
        }
      } catch {
        if (!cancelled) {
          setAgentTasks({});
          setRunState({ blocked: 0, inProgress: 0, complete: 0, pending: 0 });
        }
      }
    })();
    return () => { cancelled = true; };
  }, [pod?._id, agents, api]);

  useEffect(() => {
    const podId = pod?._id;
    if (!podId) {
      setAnnouncements([]);
      setExternalLinks([]);
      setPodFiles([]);
      return;
    }
    let cancelled = false;
    (async () => {
      const [announcementResult, linksResult, filesResult] = await Promise.allSettled([
        api.get<AnnouncementItem[]>(`/api/pods/${podId}/announcements`),
        api.get<ExternalLinkItem[]>(`/api/pods/${podId}/external-links`),
        api.get<PodFileItem[]>(`/api/pods/${podId}/files`),
      ]);
      if (cancelled) return;
      setAnnouncements(announcementResult.status === 'fulfilled' && Array.isArray(announcementResult.value) ? announcementResult.value : []);
      setExternalLinks(linksResult.status === 'fulfilled' && Array.isArray(linksResult.value) ? linksResult.value : []);
      setPodFiles(filesResult.status === 'fulfilled' && Array.isArray(filesResult.value) ? filesResult.value : []);
    })();
    return () => { cancelled = true; };
  }, [pod?._id, api]);

  // Resolve pending file-name → artifactId once podFiles is loaded. The
  // chat file pill sets pendingOpenFileName via V2Layout; we match on
  // either the ObjectStore key (`fileName`) or the human-facing original
  // filename so static `[[file:foo.md]]` tokens that share an originalName
  // with a real upload still route correctly.
  useEffect(() => {
    if (!pendingOpenFileName) return;
    if (podFiles.length === 0) return;
    const match = podFiles.find((f: { fileName?: string; originalName?: string }) => (
      f.fileName === pendingOpenFileName || f.originalName === pendingOpenFileName
    )) as { _id?: string } | undefined;
    if (match?._id) {
      onOpenArtifact(`file-${match._id}`);
    }
    onPendingOpenFileNameConsumed?.();
  }, [pendingOpenFileName, podFiles, onOpenArtifact, onPendingOpenFileNameConsumed]);

  if (!pod) return <aside className="v2-pane v2-pane--inspector" />;

  const isPrivatePod = pod.type === 'agent-room';
  const humanCount = humanMembers.length;
  const agentCount = agents.length;
  const created = pod.createdAt ? new Date(pod.createdAt).toLocaleDateString([], {
    month: 'short', day: 'numeric',
  }) : 'unknown';
  const ownerId = pod.createdBy?._id;

  const openPrivatePod = async (agent: V2Agent) => {
    setPrivateError(null);
    try {
      const data = await api.post<{ room?: { _id?: string } }>('/api/agents/runtime/room', {
        agentName: agent.agentName,
        instanceId: agent.instanceId || 'default',
        podId: pod._id,
      });
      const roomId = data.room?._id;
      if (roomId) navigate(`/v2/pods/${roomId}`);
      else setPrivateError('Private pod could not be opened for this agent.');
    } catch (err) {
      const e = err as { response?: { data?: { message?: string; error?: string; msg?: string } }; message?: string };
      setPrivateError(e.response?.data?.message || e.response?.data?.error || e.response?.data?.msg || e.message || 'Private pod could not be opened.');
    }
  };

  const handleDeletePod = async () => {
    if (!podsState || !pod) return;
    const confirmed = window.confirm(`Delete "${pod.name}"? This removes the pod and its messages.`);
    if (!confirmed) return;
    const deleted = await podsState.deletePod(pod._id);
    if (deleted) navigate('/v2', { replace: true });
  };

  // ------------------------------------------------------------------
  // NOW — first agent with an active task. Hidden if nothing is in flight.
  // ------------------------------------------------------------------
  const nowAgent = agents.find((a) => {
    const key = agentKeyOf(a);
    return !!agentTasks[key];
  });
  const nowTask = nowAgent ? agentTasks[agentKeyOf(nowAgent)] : null;
  const nowSection = nowAgent && nowTask && (
    <section className="v2-inspector__section">
      <div className="v2-inspector__now">
        <div className="v2-inspector__now-eyebrow">NOW</div>
        <div className="v2-inspector__now-title">
          <span className="v2-inspector__now-pulse" />
          {(nowAgent.profile?.displayName || nowAgent.displayName || nowAgent.agentName)}
          {' · '}
          {nowTask.title}
        </div>
        <div className="v2-inspector__now-meta">
          Status: {nowTask.status.replace('_', ' ')}
        </div>
      </div>
    </section>
  );

  // ------------------------------------------------------------------
  // PROGRESS — overall pod task completion. Hidden when the pod has
  // no tracked tasks (avoids implying progress where there isn't any).
  // ------------------------------------------------------------------
  const totalTasks = runState.complete + runState.inProgress + runState.pending + runState.blocked;
  const progressPct = totalTasks > 0 ? Math.round((runState.complete / totalTasks) * 100) : 0;
  const progressSection = totalTasks > 0 && (
    <section className="v2-inspector__section">
      <div className="v2-inspector__section-title">Progress</div>
      <div className="v2-inspector__progress-row">
        <span className="v2-inspector__progress-stat">
          {runState.complete} of {totalTasks} task{totalTasks === 1 ? '' : 's'} complete
        </span>
        <span className="v2-inspector__progress-pct">{progressPct}%</span>
      </div>
      <div className="v2-inspector__progress-track">
        <div className="v2-inspector__progress-bar" style={{ width: `${progressPct}%` }} />
      </div>
    </section>
  );

  // ------------------------------------------------------------------
  // OVERVIEW — Goal / Artifacts
  // ------------------------------------------------------------------
  const goalSection = (
    <section className="v2-inspector__section">
      <div className="v2-inspector__section-title">Goal</div>
      <div className="v2-inspector__goal-text">
        {pod.description?.trim() || <span className="v2-mute">No goal set yet.</span>}
      </div>
    </section>
  );

  // Files come last so the freshest URL artifact (added via "+ Add") still
  // sits at the top — matches the user's expectation that the row they just
  // pasted is visible without scrolling. Within each source, server returns
  // newest-first.
  const artifactItems: Array<{ id: string; kind: string; title: string; subtitle?: string; url?: string; fileName?: string }> = [
    ...announcements.map((a) => ({
      id: `ann-${a._id}`,
      kind: 'Announcement',
      title: a.title || a.content || 'Untitled announcement',
    })),
    ...externalLinks.map((l) => ({
      id: `link-${l._id}`,
      kind: l.type || 'other_link',
      title: l.name || l.url || 'External link',
      subtitle: l.url,
      url: l.url,
    })),
    ...podFiles.map((f) => ({
      id: `file-${f._id}`,
      kind: fileKind(f.originalName, f.contentType),
      title: f.originalName || f.fileName,
      subtitle: f.contentType,
      // No `url` here — files require a signed-URL mint. The detail view's
      // Open button calls getSignedAttachmentUrl(`/api/uploads/${fileName}`).
      fileName: f.fileName,
    })),
  ];

  const handleAddLinkSubmit = async () => {
    const url = addLinkUrl.trim();
    if (!url || !pod) return;
    setAddLinkBusy(true);
    setAddLinkError(null);
    try {
      const created = await api.post<ExternalLinkItem>('/api/pods/external-link', {
        podId: pod._id,
        type: 'auto',
        url,
      });
      setExternalLinks((prev) => [created, ...prev]);
      setAddLinkUrl('');
      setAddLinkOpen(false);
    } catch (err) {
      const e = err as { response?: { data?: { message?: string } }; message?: string };
      setAddLinkError(e.response?.data?.message || e.message || 'Could not add link.');
    } finally {
      setAddLinkBusy(false);
    }
  };

  const artifactsSection = (
    <section className="v2-inspector__section">
      <div className="v2-inspector__section-head">
        <div className="v2-inspector__section-title">Artifacts</div>
        <button
          type="button"
          className="v2-inspector__link"
          onClick={() => {
            setAddLinkOpen((v) => !v);
            setAddLinkError(null);
          }}
          aria-expanded={addLinkOpen}
        >
          {addLinkOpen ? 'Cancel' : '+ Add'}
        </button>
      </div>
      {addLinkOpen && (
        <div
          style={{
            display: 'flex', flexDirection: 'column', gap: 6,
            padding: '8px 0 12px',
          }}
        >
          <input
            type="url"
            value={addLinkUrl}
            onChange={(e) => setAddLinkUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !addLinkBusy && addLinkUrl.trim()) {
                e.preventDefault();
                void handleAddLinkSubmit();
              }
            }}
            placeholder="Paste a Notion, Google Doc, Figma, GitHub, Zoom URL…"
            autoFocus
            disabled={addLinkBusy}
            style={{
              width: '100%',
              padding: '8px 9px',
              border: '1px solid var(--v2-border)',
              borderRadius: 'var(--v2-radius-sm)',
              background: 'var(--v2-surface)',
              fontSize: 12,
              color: 'var(--v2-text-primary)',
              outline: 'none',
            }}
          />
          {addLinkError && (
            <div style={{ fontSize: 11, color: 'var(--v2-danger)' }}>{addLinkError}</div>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button
              type="button"
              onClick={() => { setAddLinkOpen(false); setAddLinkUrl(''); setAddLinkError(null); }}
              disabled={addLinkBusy}
              style={{
                padding: '6px 9px',
                borderRadius: 'var(--v2-radius-sm)',
                fontSize: 11,
                fontWeight: 700,
                color: 'var(--v2-text-tertiary)',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => { void handleAddLinkSubmit(); }}
              disabled={addLinkBusy || !addLinkUrl.trim()}
              style={{
                padding: '6px 9px',
                borderRadius: 'var(--v2-radius-sm)',
                fontSize: 11,
                fontWeight: 700,
                background: addLinkBusy || !addLinkUrl.trim() ? 'var(--v2-border-strong)' : 'var(--v2-accent)',
                color: '#fff',
                border: 'none',
                cursor: addLinkBusy || !addLinkUrl.trim() ? 'not-allowed' : 'pointer',
              }}
            >
              {addLinkBusy ? 'Adding…' : 'Add'}
            </button>
          </div>
        </div>
      )}
      {artifactItems.length === 0 && !addLinkOpen ? (
        <div className="v2-inspector__empty">No artifacts yet — share Notion, Sheets, or Figma links and they&apos;ll appear here.</div>
      ) : artifactItems.length > 0 && (
        <div className="v2-inspector__artifacts">
          {artifactItems.map((a) => {
            const meta = artifactMeta(a.kind);
            return (
              <button
                key={a.id}
                type="button"
                className="v2-inspector__artifact-row"
                onClick={() => onOpenArtifact(a.id)}
              >
                <span className="v2-inspector__artifact-icon" aria-hidden>{meta.icon}</span>
                <span className="v2-inspector__artifact-meta">
                  <span className="v2-inspector__artifact-title">{a.title}</span>
                  <span className="v2-inspector__artifact-sub">{meta.label}{a.subtitle ? ` · ${a.subtitle.replace(/^https?:\/\//, '').slice(0, 32)}` : ''}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );

  const membersSection = !isPrivatePod && (
    <section className="v2-inspector__section v2-inspector__section--quiet">
      <div className="v2-inspector__members-actions">
        {onOpenInvite && (
          <button
            type="button"
            className="v2-inspector__action v2-inspector__action--primary"
            onClick={onOpenInvite}
            title="Invite people or add an agent to this pod"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M12 5v14M5 12h14" />
            </svg>
            Invite
          </button>
        )}
        <button
          type="button"
          className="v2-inspector__action"
          onClick={() => navigate(`/v2/agents?podId=${pod._id}`)}
          title="Manage agents installed in this pod"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33h0a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51h0a1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82v0a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z" />
          </svg>
          Manage
        </button>
      </div>
      {privateError && <div className="v2-chat__error" style={{ marginBottom: 8 }}>{privateError}</div>}
      {agents.map((agent) => {
        const name = agent.profile?.displayName || agent.displayName || agent.agentName;
        const key = agentKeyOf(agent);
        const isOnline = !!agent.lastHeartbeatAt
          && Date.now() - new Date(agent.lastHeartbeatAt).getTime() < 10 * 60 * 1000;
        const badge = resolveRuntimeBadge(agent);
        return (
          <button
            key={`agent-${key}`}
            type="button"
            className="v2-inspector__member-row"
            onClick={() => onOpenMember(key)}
          >
            <V2Avatar
              name={name}
              src={agent.profile?.avatarUrl || agent.profile?.iconUrl || agent.iconUrl || undefined}
              size="md"
              online={isOnline}
            />
            <span className="v2-inspector__member-meta">
              <span className="v2-inspector__member-name">{name}</span>
              <span className="v2-inspector__member-role">
                {agent.category ? `${agent.category} · AI Agent` : 'AI Agent'}
              </span>
            </span>
            {badge && (
              <span
                className="v2-runtime-row"
                title={`${badge.label}${badge.isByo ? ' · BYO (you run it)' : ''}`}
                aria-label={`${badge.label} runtime${badge.isByo ? ', BYO' : ''}`}
              >
                <span className="v2-runtime-row__label">{badge.label}</span>
                {badge.isByo && <span className="v2-runtime-row__byo" aria-hidden>BYO</span>}
              </span>
            )}
            {isOnline && <span className="v2-online-dot" style={{ background: 'var(--v2-success)' }} />}
          </button>
        );
      })}
      {humanMembers.map((member) => {
        const role = memberRoleLabel(member, ownerId, false);
        return (
          <div key={`human-${member._id}`} className="v2-inspector__member-row v2-inspector__member-row--static">
            <V2Avatar name={member.username || 'Unknown'} src={member.profilePicture || undefined} size="md" />
            <span className="v2-inspector__member-meta">
              <span className="v2-inspector__member-name">{member.username}</span>
              <span className="v2-inspector__member-role">{role}</span>
            </span>
          </div>
        );
      })}
      {agents.length === 0 && humanCount === 0 && (
        <div className="v2-inspector__empty">No members yet.</div>
      )}
    </section>
  );

  const runStateSection = (
    <section className="v2-inspector__section">
      <div className="v2-inspector__section-title">Run state</div>
      <div className="v2-inspector__runstate">
        <div className="v2-inspector__runstate-row">
          <span className="v2-inspector__runstate-label">{runState.blocked} blocked</span>
          <span className="v2-inspector__pill v2-inspector__pill--blocked">Blocked</span>
        </div>
        <div className="v2-inspector__runstate-row">
          <span className="v2-inspector__runstate-label">{runState.inProgress + runState.pending} in progress</span>
          <span className="v2-inspector__pill v2-inspector__pill--progress">In Progress</span>
        </div>
        <div className="v2-inspector__runstate-row">
          <span className="v2-inspector__runstate-label">{runState.complete} complete</span>
          <span className="v2-inspector__pill v2-inspector__pill--complete">Complete</span>
        </div>
      </div>
      <button
        type="button"
        className="v2-inspector__link v2-inspector__link--block"
        onClick={() => navigate(`/v2/pods/${pod.type || 'chat'}/${pod._id}`)}
      >
        View run board
      </button>
    </section>
  );

  // ------------------------------------------------------------------
  // MEMBER DETAIL sub-page
  // ------------------------------------------------------------------
  const renderMemberDetail = (agentKey: string) => {
    const agent = agentByKey.get(agentKey);
    if (!agent) {
      return (
        <div className="v2-inspector__empty">Member not found.</div>
      );
    }
    const name = agent.profile?.displayName || agent.displayName || agent.agentName;
    const isOnline = !!agent.lastHeartbeatAt
      && Date.now() - new Date(agent.lastHeartbeatAt).getTime() < 10 * 60 * 1000;
    const task = agentTasks[agentKeyOf(agent)];
    const purpose = agent.profile?.purpose;
    const specialties = agent.profile?.persona?.specialties || [];
    const dmable = isAgentDmable(agent);
    const badge = resolveRuntimeBadge(agent);
    return (
      <div className="v2-inspector__detail">
        <div className="v2-inspector__detail-head">
          <V2Avatar
            name={name}
            src={agent.profile?.avatarUrl || agent.profile?.iconUrl || agent.iconUrl || undefined}
            size="lg"
            online={isOnline}
          />
          <div className="v2-inspector__detail-name">{name}</div>
          <div className="v2-inspector__detail-sub">
            <span className="v2-online-dot" style={{ background: isOnline ? 'var(--v2-success)' : 'var(--v2-text-muted)' }} />
            {isOnline ? 'Online' : 'Idle'} · {agent.category ? `${agent.category} · AI Agent` : 'AI Agent'}
          </div>
          {badge && (
            <div className="v2-inspector__detail-runtime">
              <span className="v2-runtime-pill" aria-label={`${badge.label} runtime${badge.isByo ? ', BYO' : ''}`}>
                <span className="v2-runtime-pill__mono">{badge.mono}</span>
                <span className="v2-runtime-pill__label">{badge.label}</span>
              </span>
              {badge.isByo && (
                <span className="v2-runtime-host" title="BYO — you run this agent (laptop, server, anywhere)">
                  BYO
                </span>
              )}
            </div>
          )}
        </div>
        <div className="v2-inspector__detail-actions">
          {dmable && (
            <button
              type="button"
              className="v2-inspector__btn v2-inspector__btn--primary"
              onClick={() => openPrivatePod(agent)}
            >
              Talk to {name}
            </button>
          )}
          <button
            type="button"
            className="v2-inspector__btn"
            onClick={() => navigate(`/v2/agents?podId=${pod._id}&agent=${encodeURIComponent(agentKeyOf(agent))}`)}
          >
            Manage
          </button>
        </div>
        {privateError && <div className="v2-chat__error" style={{ marginTop: 8 }}>{privateError}</div>}
        {task && (
          <div className="v2-inspector__detail-card">
            <div className="v2-inspector__detail-kicker">Working on</div>
            <div className="v2-inspector__detail-body">{task.title}</div>
          </div>
        )}
        {purpose && (
          <div className="v2-inspector__detail-card">
            <div className="v2-inspector__detail-kicker">Purpose</div>
            <div className="v2-inspector__detail-body">{purpose}</div>
          </div>
        )}
        {specialties.length > 0 && (
          <div className="v2-inspector__detail-card">
            <div className="v2-inspector__detail-kicker">Specialties</div>
            <div className="v2-inspector__chip-row">
              {specialties.map((s) => <span key={s} className="v2-inspector__chip">{s}</span>)}
            </div>
          </div>
        )}
      </div>
    );
  };

  // ------------------------------------------------------------------
  // ARTIFACT DETAIL sub-page
  // ------------------------------------------------------------------
  // File artifacts open via a signed-URL mint (no plain href to embed). URL
  // artifacts use safeHref. Click handler always preventDefault so we can
  // route both kinds through one button.
  const handleOpenArtifact = async (item: typeof artifactItems[0]) => {
    if (item.fileName) {
      const signed = await getSignedAttachmentUrl(`/api/uploads/${item.fileName}`);
      if (signed) window.open(signed, '_blank', 'noopener,noreferrer');
      return;
    }
    const href = safeHref(item.url);
    if (href) window.open(href, '_blank', 'noopener,noreferrer');
  };

  const renderArtifactDetail = (artifactId: string) => {
    const found = artifactItems.find((a) => a.id === artifactId);
    if (!found) {
      return <div className="v2-inspector__empty">Artifact not found.</div>;
    }
    const meta = artifactMeta(found.kind);
    const openable = !!found.fileName || !!safeHref(found.url);
    return (
      <div className="v2-inspector__detail">
        <div className="v2-inspector__detail-head">
          <span className="v2-inspector__artifact-icon v2-inspector__artifact-icon--lg">
            {meta.icon}
          </span>
          <div className="v2-inspector__detail-name">{found.title}</div>
          <div className="v2-inspector__detail-sub">{meta.label}</div>
        </div>
        <ArtifactPreview
          artifact={{
            kind: found.kind,
            fileName: found.fileName,
            url: found.url,
            title: found.title,
          }}
        />
        {openable && (
          <div className="v2-inspector__detail-actions">
            <button
              type="button"
              className="v2-inspector__btn v2-inspector__btn--primary"
              onClick={() => { void handleOpenArtifact(found); }}
            >
              Open
            </button>
          </div>
        )}
        {found.subtitle && (
          <div className="v2-inspector__detail-card">
            <div className="v2-inspector__detail-kicker">{found.fileName ? 'Type' : 'Source'}</div>
            <div className="v2-inspector__detail-body" style={{ wordBreak: 'break-all' }}>{found.subtitle}</div>
          </div>
        )}
      </div>
    );
  };

  // ------------------------------------------------------------------
  // SHELL
  // ------------------------------------------------------------------
  const isOverview = view.kind === 'overview';
  const heading = isOverview
    ? pod.name
    : view.kind === 'member'
      ? 'Member'
      : 'Artifact';

  return (
    <aside className="v2-pane v2-pane--inspector">
      <div className="v2-inspector">
        <header className="v2-inspector__header">
          {!isOverview && (
            <button
              type="button"
              className="v2-inspector__back"
              onClick={onBack}
              aria-label="Back to overview"
            >
              <Icon d="M15 18l-6-6 6-6" size={16} />
              Back
            </button>
          )}
          {isOverview && (
            <div className="v2-inspector__pod-head">
              <V2Avatar name={pod.name} size="lg" />
              <div className="v2-inspector__pod-block">
                <div className="v2-inspector__pod-name" title={pod.name}>{pod.name}</div>
                <div className="v2-inspector__pod-meta">
                  Created by {pod.createdBy?.username || 'unknown'} · {created}
                </div>
                <div className="v2-inspector__pod-meta">
                  {!isPrivatePod && <>{agentCount} agent{agentCount === 1 ? '' : 's'} · </>}{humanCount} human{humanCount === 1 ? '' : 's'}
                </div>
              </div>
            </div>
          )}
          {!isOverview && (
            <div className="v2-inspector__sub-title">{heading}</div>
          )}
          {onClose && (
            <button
              type="button"
              className="v2-inspector__close"
              onClick={onClose}
              title="Hide pod team"
              aria-label="Hide pod team"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="6" y1="6" x2="18" y2="18" />
                <line x1="18" y1="6" x2="6" y2="18" />
              </svg>
            </button>
          )}
        </header>
        <div className="v2-inspector__body">
          {view.kind === 'overview' && (
            <>
              <div className="v2-inspector__tabs" role="tablist" aria-label="Inspector sections">
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === 'overview'}
                  className={`v2-inspector__tab${tab === 'overview' ? ' v2-inspector__tab--active' : ''}`}
                  onClick={() => setTab('overview')}
                >
                  Overview
                </button>
                {!isPrivatePod && (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={tab === 'members'}
                    className={`v2-inspector__tab${tab === 'members' ? ' v2-inspector__tab--active' : ''}`}
                    onClick={() => setTab('members')}
                  >
                    Members
                    <span className="v2-inspector__tab-count">{agentCount + humanCount}</span>
                  </button>
                )}
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === 'tasks'}
                  className={`v2-inspector__tab${tab === 'tasks' ? ' v2-inspector__tab--active' : ''}`}
                  onClick={() => setTab('tasks')}
                >
                  Tasks
                  {(runState.blocked + runState.inProgress + runState.pending) > 0 && (
                    <span className="v2-inspector__tab-count">
                      {runState.blocked + runState.inProgress + runState.pending}
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === 'manage'}
                  className={`v2-inspector__tab${tab === 'manage' ? ' v2-inspector__tab--active' : ''}`}
                  onClick={() => setTab('manage')}
                >
                  Manage
                </button>
              </div>

              {tab === 'overview' && (
                <>
                  {progressSection}
                  {nowSection}
                  {pod.description && goalSection}
                  {artifactsSection}
                </>
              )}
              {tab === 'members' && (
                <>{membersSection || <div className="v2-inspector__empty">Members are not shown for direct pods.</div>}</>
              )}
              {tab === 'tasks' && runStateSection}
              {tab === 'manage' && (
                <>
                  <section className="v2-inspector__section">
                    <div className="v2-inspector__section-title">Pod settings</div>
                    <div className="v2-inspector__empty">More pod settings will appear here. For now, manage members and integrations from the Agents page.</div>
                  </section>
                  {podsState && (
                    <section className="v2-inspector__section v2-inspector__danger">
                      <div className="v2-inspector__danger-title">Danger zone</div>
                      <div className="v2-inspector__danger-text">
                        Deleting this pod removes all messages, tasks, and artifacts. This cannot be undone.
                      </div>
                      <button
                        type="button"
                        className="v2-inspector__btn v2-inspector__btn--danger"
                        onClick={handleDeletePod}
                      >
                        Delete pod
                      </button>
                    </section>
                  )}
                </>
              )}
              {/* Use currentUser ref so AuthContext stays imported even when not surfaced here */}
              <span style={{ display: 'none' }}>{currentUser?._id || ''}</span>
            </>
          )}
          {view.kind === 'member' && renderMemberDetail(view.agentKey)}
          {view.kind === 'artifact' && renderArtifactDetail(view.artifactId)}
        </div>
      </div>
      {/* Invite modal lives on V2Layout so the chat header invite icon
          and this section's button share one instance. */}
    </aside>
  );
};

export default V2PodInspector;
