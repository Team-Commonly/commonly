import type {
  IAgentMemorySections,
  IMemorySection,
  MemoryVisibility,
} from '../models/AgentMemory';

// ADR-003 Phase 1: parse legacy v1 `content` blobs into a v2 section envelope.
// The parser splits markdown on top-level `## ` headers and buckets each
// section into `dedup_state` (if the header name matches a known dedup tag)
// or `long_term` (everything else, including the preamble above the first
// header). Unknown shape is preserved verbatim — the kernel does not try to
// understand markdown beyond finding section boundaries.

// Dedup section names emitted by OpenClaw heartbeat templates today — see
// `backend/routes/registry/presets.ts` HEARTBEAT.md content for the authoritative
// list. When Phase 2 heartbeat changes add or rename a header, update here.
// Match is case-insensitive and non-alphanumeric-stripped (see normalizeHeader).
const DEDUP_HEADERS = new Set(
  [
    'commented',
    'replied',
    'repliedmsgs',
    'podvisits',
    'stalerevivalat',
  ],
);

const HEADER_LINE = /^## +(.+?)\s*$/gm;

interface ParsedSections {
  long_term: string;
  dedup_state: string;
}

function normalizeHeader(raw: string): string {
  return raw.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function byteSize(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

function makeSection(
  content: string,
  visibility: MemoryVisibility = 'private',
  updatedAt: Date = new Date(),
): IMemorySection {
  return {
    content,
    visibility,
    updatedAt,
    byteSize: byteSize(content),
  };
}

export function parseContentIntoSections(content: string): ParsedSections {
  if (!content || !content.trim()) {
    return { long_term: '', dedup_state: '' };
  }

  const matches: { header: string; start: number; end: number }[] = [];
  for (const m of content.matchAll(HEADER_LINE)) {
    const start = m.index ?? 0;
    matches.push({ header: m[1], start, end: start + m[0].length });
  }

  if (matches.length === 0) {
    return { long_term: content, dedup_state: '' };
  }

  const longTermChunks: string[] = [];
  const dedupChunks: string[] = [];

  // Preamble before the first header is always long_term.
  if (matches[0].start > 0) {
    longTermChunks.push(content.slice(0, matches[0].start));
  }

  for (let i = 0; i < matches.length; i++) {
    const { header, start } = matches[i];
    const nextStart = i + 1 < matches.length ? matches[i + 1].start : content.length;
    const block = content.slice(start, nextStart);
    if (DEDUP_HEADERS.has(normalizeHeader(header))) {
      dedupChunks.push(block);
    } else {
      longTermChunks.push(block);
    }
  }

  return {
    long_term: longTermChunks.join('').replace(/\n+$/, ''),
    dedup_state: dedupChunks.join('').replace(/\n+$/, ''),
  };
}

// Build a sections envelope from a legacy v1 `content` string. Returns the
// sections object the model will accept directly.
export function buildSectionsFromLegacyContent(
  content: string,
  now: Date = new Date(),
): IAgentMemorySections {
  const { long_term, dedup_state } = parseContentIntoSections(content);
  const sections: IAgentMemorySections = {};
  if (long_term) sections.long_term = makeSection(long_term, 'private', now);
  if (dedup_state) sections.dedup_state = makeSection(dedup_state, 'private', now);
  return sections;
}

// When a v2 caller writes sections, mirror `long_term.content` back into the
// `content` field so v1 readers of GET /memory still see their data. If
// there's no long_term, leave content empty.
export function mirrorContentFromSections(
  sections: IAgentMemorySections | undefined,
): string {
  return sections?.long_term?.content ?? '';
}
