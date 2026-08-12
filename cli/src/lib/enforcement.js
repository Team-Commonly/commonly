/**
 * Wrapper-side enforcement (ADR-018 D3, "our drivers" row).
 *
 * The 2026-08-11 pilot proved that advisory guidance loses to task gravity:
 * the tone contract was in every seat's tool descriptions and the review
 * median still came out at 3,614 characters, with zero claims taken and a
 * mention cascade that needed a manual wrapper kill. This module is the
 * deterministic half — the wrapper enforces what the contract can only ask:
 *
 *   - claim-before-act + stand-down (createClaimKeeper)
 *   - per-seat cascade damping     (createCascadeGovernor, classifyTrigger)
 *   - post-time length gate        (splitForChat, deliverChatReply)
 *
 * One rule overrides everything here: enforcement must never convert an
 * infrastructure failure into agent silence (#887 class). Every network or
 * server error fails OPEN — the turn proceeds unguarded and says so in the
 * log. Only an explicit "someone else holds it" or "cascade cap reached"
 * stands the agent down, and both are logged with the reason.
 */

// Event types whose payload.messageId identifies a claimable trigger message.
// first_contact is deliberately absent: the welcome wake targets exactly one
// agent, so there is nothing to contend for. Heartbeats have no message at
// all, and agent.ask routes privately.
export const CLAIMABLE_EVENT_TYPES = new Set([
  'chat.mention',
  'message.posted',
  'dm.message',
]);

// ── trigger classification ──────────────────────────────────────────────────

/**
 * Who authored the message that woke us — 'agent', 'human', or 'unknown'?
 *
 * Two signals, in order of reliability:
 *   1. payload.dmKind — the kernel stamps DM wakes 'agent-agent'/'user-agent'.
 *   2. The trigger message's isBot flag, looked up by payload.messageId in the
 *      pre-spawn snapshot the run loop already fetches for echo suppression.
 *
 * 'unknown' is the fail-open verdict: it neither counts toward the cascade
 * cap nor resets it. In a live cascade the trigger message is seconds old and
 * always inside the snapshot window, so cascades classify reliably; a message
 * that has already scrolled out of the window is not cascade tempo.
 */
export const classifyTrigger = (event, recentMessages) => {
  const p = event?.payload || {};
  if (p.dmKind === 'agent-agent') return 'agent';
  if (p.dmKind === 'user-agent') return 'human';
  if (!p.messageId || !Array.isArray(recentMessages)) return 'unknown';
  const trigger = recentMessages.find(
    (m) => String(m._id || m.id) === String(p.messageId),
  );
  if (!trigger || typeof trigger.isBot !== 'boolean') return 'unknown';
  return trigger.isBot ? 'agent' : 'human';
};

// ── cascade governor ────────────────────────────────────────────────────────

/**
 * Per-pod damping of agent→agent retrigger chains.
 *
 * The pilot's failure shape: an agent's own posts kept waking it (via another
 * agent's replies) until the operator killed the wrapper at round 3. The
 * governor counts CONSECUTIVE agent-triggered turns per pod; at `cap` it
 * refuses further agent-triggered turns until a human-triggered turn resets
 * the streak or `resetMs` passes with no agent-triggered turn (so a damped
 * pod recovers on its own — a legitimate a2a handoff an hour later must not
 * inherit a stale cap).
 *
 * Split into admit/record so a spawn that fails (and will be redelivered)
 * never double-counts: admit() only reads, record() runs after a turn
 * actually completed. Human-triggered turns are always admitted.
 */
export const createCascadeGovernor = ({
  cap = 3,
  resetMs = 10 * 60 * 1000,
  now = Date.now,
} = {}) => {
  const pods = new Map(); // podId -> { streak, lastAgentTurnAt }

  const stateFor = (podId) => {
    const s = pods.get(podId) || { streak: 0, lastAgentTurnAt: 0 };
    if (s.streak > 0 && now() - s.lastAgentTurnAt > resetMs) {
      return { streak: 0, lastAgentTurnAt: 0 };
    }
    return s;
  };

  return {
    admit(podId, trigger) {
      if (trigger !== 'agent') return { allowed: true, streak: 0 };
      const s = stateFor(podId);
      return { allowed: s.streak < cap, streak: s.streak };
    },
    record(podId, trigger) {
      if (trigger === 'human') {
        pods.set(podId, { streak: 0, lastAgentTurnAt: 0 });
      } else if (trigger === 'agent') {
        const s = stateFor(podId);
        pods.set(podId, { streak: s.streak + 1, lastAgentTurnAt: now() });
      }
      // 'unknown' is neutral: no count, no reset.
    },
  };
};

// ── claim keeper ────────────────────────────────────────────────────────────

/**
 * One claim lifecycle for one event: acquire → renew while the CLI turn runs
 * → release (or discover mid-turn loss and stand down at post time).
 *
 * Acquire outcomes:
 *   { claimed: true }                  — we hold the lease; start renewal.
 *   { claimed: false, holder }         — someone else holds it; STAND DOWN.
 *   { claimed: false, failOpen: true } — claim route unavailable (older
 *     server, network, 403 on a stale install); proceed UNGUARDED. The
 *     alternative turns a kernel deploy gap into a silent agent.
 *
 * Renewal reuses the same POST (a holder wins against itself — that IS
 * renewal, per messageClaimService). A renewal that comes back claimed:false
 * means our lease lapsed (laptop slept, turn ran long) and a peer re-won:
 * mark lost so the run loop suppresses the wrapper post. Transient renewal
 * errors are ignored — the current lease may still be live, and the next
 * tick retries.
 */
export const createClaimKeeper = (client, {
  messageId,
  podId,
  leaseSeconds = 90,
  log = () => {},
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
}) => {
  const path = `/api/agents/runtime/messages/${encodeURIComponent(messageId)}/claim`;
  let acquired = false;
  let lost = false;
  let holder = null;
  let timer = null;

  const holderLabel = (res) => {
    if (!res?.claimedBy) return 'another agent';
    const instance = res.instanceId && res.instanceId !== 'default' ? `:${res.instanceId}` : '';
    return `${res.claimedBy}${instance}`;
  };

  const stopRenewal = () => {
    if (timer) {
      clearIntervalImpl(timer);
      timer = null;
    }
  };

  return {
    async acquire() {
      try {
        const res = await client.post(path, { podId, leaseSeconds });
        if (res?.claimed) {
          acquired = true;
          return { claimed: true, expiresAt: res.expiresAt };
        }
        holder = holderLabel(res);
        return { claimed: false, holder };
      } catch (err) {
        return { claimed: false, failOpen: true, error: err };
      }
    },

    startRenewal() {
      if (!acquired || timer) return;
      timer = setIntervalImpl(async () => {
        try {
          const res = await client.post(path, { podId, leaseSeconds });
          if (!res?.claimed) {
            lost = true;
            holder = holderLabel(res);
            stopRenewal();
            log(`claim on message ${messageId} lost mid-turn to ${holder} — standing down at post time`);
          }
        } catch {
          // Transient renewal failure — the held lease may still be live;
          // retry on the next tick rather than standing down on a blip.
        }
      }, Math.max(5000, (leaseSeconds * 1000) / 2));
      if (timer && typeof timer.unref === 'function') timer.unref();
    },

    async release() {
      stopRenewal();
      if (!acquired || lost) return;
      try {
        await client.del(path);
      } catch {
        // Best-effort: a miss just means the lease already expired.
      }
    },

    isLost: () => lost,
    getHolder: () => holder,
  };
};

// ── post-time length gate ───────────────────────────────────────────────────

/**
 * Split chat text into tone-contract-sized messages without ever cutting
 * content. Boundaries in preference order: fenced code blocks stay whole
 * (atomic — an oversized fence becomes one oversized message rather than a
 * broken pair), then paragraphs, then sentences, then words. Greedy packing
 * rejoins small pieces so two short paragraphs share one message.
 */
export const splitForChat = (text, { limit = 400 } = {}) => {
  const trimmed = String(text || '').trim();
  if (!trimmed) return [];
  if (trimmed.length <= limit) return [trimmed];

  // Pass 1: carve into blocks — fences atomic, prose split by paragraph.
  const blocks = [];
  let prose = [];
  const flushProse = () => {
    const joined = prose.join('\n');
    prose = [];
    for (const para of joined.split(/\n{2,}/)) {
      if (para.trim()) blocks.push({ text: para.trim(), atomic: false });
    }
  };
  const lines = trimmed.split('\n');
  let i = 0;
  while (i < lines.length) {
    const fence = lines[i].match(/^(```|~~~)/)?.[1];
    if (fence) {
      flushProse();
      const fenced = [lines[i]];
      i += 1;
      while (i < lines.length && !lines[i].startsWith(fence)) {
        fenced.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) {
        fenced.push(lines[i]); // closing fence
        i += 1;
      }
      blocks.push({ text: fenced.join('\n'), atomic: true });
    } else {
      prose.push(lines[i]);
      i += 1;
    }
  }
  flushProse();

  // Pass 2: split oversized prose blocks at sentence then word boundaries.
  const units = [];
  for (const block of blocks) {
    if (block.atomic || block.text.length <= limit) {
      units.push(block.text);
      continue;
    }
    let piece = '';
    const flushPiece = () => {
      if (piece.trim()) units.push(piece.trim());
      piece = '';
    };
    for (const sentence of block.text.split(/(?<=[.!?])\s+/)) {
      if (sentence.length > limit) {
        flushPiece();
        let run = '';
        for (const word of sentence.split(/\s+/)) {
          if (run && `${run} ${word}`.length > limit) {
            units.push(run);
            run = word;
          } else {
            run = run ? `${run} ${word}` : word;
          }
        }
        if (run) units.push(run); // a single over-limit word (URL) posts whole
      } else if (piece && `${piece} ${sentence}`.length > limit) {
        flushPiece();
        piece = sentence;
      } else {
        piece = piece ? `${piece} ${sentence}` : sentence;
      }
    }
    flushPiece();
  }

  // Pass 3: greedy packing back up to the limit.
  const chunks = [];
  let acc = '';
  for (const unit of units) {
    const joined = acc ? `${acc}\n\n${unit}` : unit;
    if (joined.length <= limit) {
      acc = joined;
    } else {
      if (acc) chunks.push(acc);
      acc = unit;
    }
  }
  if (acc) chunks.push(acc);
  return chunks;
};

/**
 * Deliver a wrapper-posted reply under the tone contract, deterministically:
 *
 *   fits in one message            → post as-is
 *   splits into ≤ maxChunks        → post the chunks in order ("two short
 *                                    messages beat one wall")
 *   longer than a split answer     → it is a document, not a message: upload
 *                                    the FULL text as a file and post one
 *                                    message — the reply's own opening plus
 *                                    the file card. Nothing is cut; the file
 *                                    holds everything.
 *
 * If the upload fails (older server, network), fall back to posting every
 * chunk: a message flood is a tone violation, silence or truncation is a
 * correctness violation, and the contract itself ranks content above tone
 * ("NEVER hit that by cutting content").
 */
export const deliverChatReply = async ({
  client,
  podId,
  text,
  limit = 400,
  maxChunks = 3,
  uploadName = 'reply.md',
  log = () => {},
}) => {
  const messagesPath = `/api/agents/runtime/pods/${podId}/messages`;
  const chunks = splitForChat(text, { limit });
  if (chunks.length <= 1) {
    await client.post(messagesPath, { content: chunks[0] ?? text });
    return { mode: 'single', messages: 1 };
  }
  if (chunks.length <= maxChunks) {
    for (const chunk of chunks) {
      // eslint-disable-next-line no-await-in-loop
      await client.post(messagesPath, { content: chunk }); // in order, so the reply reads top-down
    }
    return { mode: 'split', messages: chunks.length };
  }
  try {
    const uploaded = await client.upload(`/api/agents/runtime/pods/${podId}/uploads`, {
      fileBuffer: Buffer.from(String(text), 'utf8'),
      fileName: uploadName,
      contentType: 'text/markdown',
      fields: { podId },
    });
    const u = uploaded || {};
    const directive = `[[upload:${u.fileName || uploadName}|${u.originalName || uploadName}|${u.size ?? Buffer.byteLength(String(text))}|${u.kind || 'document'}]]`;
    await client.post(messagesPath, { content: `${chunks[0]}\n\n${directive}` });
    return { mode: 'attach', messages: 1 };
  } catch (err) {
    log(`attach fallback failed (${err.message}) — posting ${chunks.length} split messages instead`);
    for (const chunk of chunks) {
      // eslint-disable-next-line no-await-in-loop
      await client.post(messagesPath, { content: chunk });
    }
    return { mode: 'split-fallback', messages: chunks.length };
  }
};
