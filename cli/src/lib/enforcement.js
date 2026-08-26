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
  // The third pricing branch (#1044, fable 55845). Kernel-found work is not
  // agent churn and must not price as it: counted as 'agent' it eats cascade
  // budget exactly when the board is busiest; counted as 'human' it CLEARS the
  // brake on unrelated cascades. 'kernel' is neutral like 'unknown' — no
  // count, no reset — but chosen on purpose rather than fallen into, and the
  // refusal/boot logs can say so. Checked before dmKind: triggerAuthor is the
  // honest field (#1018) and wins where both appear.
  if (p.triggerAuthor === 'kernel') return 'kernel';
  if (p.dmKind === 'agent-agent') return 'agent';
  if (p.dmKind === 'user-agent') return 'human';
  if (!p.messageId || !Array.isArray(recentMessages)) return 'unknown';
  const trigger = recentMessages.find(
    (m) => String(m._id || m.id) === String(p.messageId),
  );
  if (!trigger || typeof trigger.isBot !== 'boolean') return 'unknown';
  return trigger.isBot ? 'agent' : 'human';
};

// Direct-address event types: the seat was NAMED (explicit @, implicit human
// reply, or DM routing). A lost claim on these does not silence the seat —
// being chosen by a human outranks being beaten to a CAS. Broadcast wakes
// (message.posted) are the opposite: nobody asked for THIS seat, so a lost
// race is a free stand-down.
export const ADDRESSED_EVENT_TYPES = new Set(['chat.mention', 'thread.mention', 'dm.message']);

// These are the two event types the kernel's bot-to-bot mention dampener
// bounds as one shared budget. Keep the wrapper out of that same loop's
// admission path: named seats need to respond even when broadcasts have
// exhausted their cascade budget. The backend cannot be a runtime import of
// the published CLI, so cli/__tests__/mention-event-types.contract.test.mjs
// imports both modules and pins the two lists together.
//
// Agent-DM wakes also arrive as chat.mention, but carry payload.dmKind. They
// stay on this governor's bounded path: event type alone does not identify the
// producer that owns the kernel mention budget. dm.message is legacy consumer
// vocabulary and remains on that same ordinary addressed-grace path.
export const MENTION_EVENT_TYPES = new Set(['chat.mention', 'thread.mention']);

// ── cascade governor ────────────────────────────────────────────────────────

export const CASCADE_DEFAULTS = Object.freeze({
  cap: 3,
  addressedGrace: 2,
  resetMs: 10 * 60 * 1000,
});

// Env names, exported so the CLI help text and the tests quote the same
// strings rather than two copies that can drift apart.
export const CASCADE_ENV_VARS = Object.freeze({
  cap: 'COMMONLY_CASCADE_CAP',
  addressedGrace: 'COMMONLY_CASCADE_ADDRESSED_GRACE',
  resetMs: 'COMMONLY_CASCADE_RESET_MS',
});

// Flag spelling per key, for warning messages. A derived string
// (key.replace(...)) would silently produce a flag that does not exist the
// first time a key is renamed; this fails at the same moment the flag does.
const CASCADE_FLAGS = {
  cap: '--cascade-cap',
  addressedGrace: '--cascade-grace',
  resetMs: '--cascade-reset',
};

const CASCADE_BOUNDS = {
  // 0 is meaningful, not a mistake: it refuses every agent-triggered turn in
  // the pod, which is the "this room is on fire, mute the cascades" setting.
  cap: { min: 0, max: 1000, integer: true },
  // 0 restores the pre-#973 behaviour exactly. That is the point of the knob —
  // the grace can be taken back on one seat, in one restart, without a revert
  // and without a source edit.
  addressedGrace: { min: 0, max: 1000, integer: true },
  resetMs: { min: 1000, max: 24 * 60 * 60 * 1000, integer: true },
};

/**
 * Resolve the three governor constants from (in precedence order) an explicit
 * override, an environment variable, then the shipped default.
 *
 * These were literals in `run()`'s signature, reachable only by editing source
 * — on a fleet whose CLI is a symlink into a live worktree, so "retune the
 * cap" meant an edit plus a restart of every seat, with nothing recording
 * which value ran. The sibling dampener one service over
 * (AGENT_ASK_RATE_LIMIT_PER_HOUR) has always been env-tunable; this is
 * copying that, not inventing it.
 *
 * An unparseable or out-of-range value warns and falls back rather than
 * throwing. A seat that crash-loops on a typo'd env var is a worse outcome
 * than one running the default — but a silent fallback would hide the typo,
 * so it is loud.
 *
 * Overrides are validated on the SAME path as env values, deliberately. An
 * earlier draft trusted them and passed them straight through, which made
 * `--cascade-cap abc` resolve to NaN — and `streak < NaN` is false for every
 * streak, so a typo at the command line would have silently refused every
 * agent-triggered turn the seat ever saw. The louder source is not the safer
 * one; there is one validator because there is one way to be wrong.
 */
export const resolveCascadeSettings = ({
  env = process.env,
  overrides = {},
  warn = (msg) => console.warn(msg),
} = {}) => {
  const resolved = {};
  for (const key of Object.keys(CASCADE_DEFAULTS)) {
    const bounds = CASCADE_BOUNDS[key];
    const fallback = CASCADE_DEFAULTS[key];
    const override = overrides[key];
    const hasOverride = override !== undefined && override !== null;
    const raw = hasOverride ? override : env?.[CASCADE_ENV_VARS[key]];
    // Names the source in the warning, so "which one did I get wrong" is
    // answered by the message rather than by bisecting the launch command.
    const label = hasOverride ? CASCADE_FLAGS[key] : CASCADE_ENV_VARS[key];

    if (raw === undefined || raw === null || String(raw).trim() === '') {
      resolved[key] = fallback;
      continue;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || (bounds.integer && !Number.isInteger(parsed))) {
      warn(`${label}='${raw}' is not an integer — using ${fallback}`);
      resolved[key] = fallback;
      continue;
    }
    if (parsed < bounds.min || parsed > bounds.max) {
      warn(`${label}=${parsed} is outside [${bounds.min}, ${bounds.max}] — using ${fallback}`);
      resolved[key] = fallback;
      continue;
    }
    resolved[key] = parsed;
  }
  return resolved;
};

/**
 * Per-pod damping of agent→agent retrigger chains.
 *
 * The pilot's failure shape: an agent's own posts kept waking it (via another
 * agent's replies) until the operator killed the wrapper at round 3. The
 * governor counts CONSECUTIVE agent-triggered turns per pod; at `cap` it
 * refuses further agent-triggered turns until a human-triggered turn resets
 * the streak, or `resetMs` passes with no ADMITTED agent-triggered turn from
 * this seat in this pod (so a damped seat recovers on its own — a legitimate
 * a2a handoff an hour later must not inherit a stale cap).
 *
 * NOTE on `resetMs`: it is a silence window, but the silence is far narrower
 * than "the pod is quiet", and it is measured on two axes people get wrong in
 * opposite directions:
 *
 *   WHOSE turns  — `pods` is a Map in this closure, inside ONE wrapper
 *                  process. It never observes another seat's turns at all.
 *                  Three chatty peers cannot keep this streak alive.
 *   WHICH turns  — only turns that reached `record()`. A refusal returns from
 *                  agent.js before it (`:859` vs `:1087`), so a capped seat
 *                  stops updating `lastAgentTurnAt` entirely and its clock
 *                  runs free from the last turn it was ALLOWED.
 *
 * Net shape is a token bucket, not a static ceiling: a burst of `cap`, then
 * `cap` admits per `resetMs`, per pod. Sustained agent traffic with zero human
 * turns yields 6/9/12/15/18/18/18/18 admits per hour as arrivals go from one
 * per 600s to one per second — inert when quiet, pinned at cap-per-window
 * however hard the burst gets. Per POD: a seat in N pods holds N buckets, so
 * its seat-level ceiling is N times that.
 *
 * An earlier version of this note said the window requires zero agent turns
 * "in the pod", and concluded that in a busy room the only live release is a
 * human turn. Both halves are wrong, and wrongly reassuring: a capped seat
 * self-releases every window no matter how loud the room is.
 *
 * Split into admit/record so a spawn that fails (and will be redelivered)
 * never double-counts: admit() only reads, record() runs after a turn
 * actually completed. Human-triggered turns are always admitted.
 */
export const createCascadeGovernor = ({
  cap = CASCADE_DEFAULTS.cap,
  addressedGrace = CASCADE_DEFAULTS.addressedGrace,
  resetMs = CASCADE_DEFAULTS.resetMs,
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
    admit(podId, trigger, eventType, payload = {}) {
      if (trigger !== 'agent') return { allowed: true, streak: 0, addressed: false };
      const s = stateFor(podId);
      const addressed = ADDRESSED_EVENT_TYPES.has(eventType);
      if (MENTION_EVENT_TYPES.has(eventType) && !payload?.dmKind) {
        // Named mentions are bounded upstream by the kernel's shared
        // bot-to-bot mention dampener. A DM emits chat.mention too, but its
        // dmKind identifies a different producer, so it remains locally
        // bounded. Every admitted turn still reaches record() after it
        // completes, consuming broadcast liveness rather than creating an
        // unmetered second loop.
        return {
          allowed: true,
          streak: s.streak,
          addressed,
          graceApplied: false,
        };
      }
      // Being NAMED outranks a mechanical brake — the same judgement the claim
      // path already makes forty lines down in agent.js. Without this, a peer
      // can @mention a capped seat and get silence, with no signal to either
      // side that anything was suppressed. Observed 2026-08-18: one seat took
      // 51 wakes and 28 consecutive cap refusals, five of them chat.mention,
      // and answered none of them.
      //
      // Legacy direct-address events retain a GRACE, not an exemption. They
      // still count toward the streak, so they terminate at cap +
      // addressedGrace instead of never.
      const limit = addressed ? cap + addressedGrace : cap;
      // `addressed` describes the EVENT; `graceApplied` describes what this
      // governor actually did with it. They diverge whenever addressedGrace is
      // 0 — the pre-#973 setting, and the first thing an operator dials back —
      // where an addressed event is refused at the plain cap having been given
      // nothing extra. Reporting only `addressed` made the refusal log claim a
      // grace was "also spent" on a seat whose own boot line says grace=0.
      return {
        allowed: s.streak < limit,
        streak: s.streak,
        addressed,
        graceApplied: addressed && addressedGrace > 0,
      };
    },
    record(podId, trigger) {
      if (trigger === 'human') {
        pods.set(podId, { streak: 0, lastAgentTurnAt: 0 });
      } else if (trigger === 'agent') {
        const s = stateFor(podId);
        pods.set(podId, { streak: s.streak + 1, lastAgentTurnAt: now() });
      }
      // 'unknown' is neutral by FALLBACK; 'kernel' is neutral by DESIGN —
      // both take this path, but only one of them is an accident.
    },
  };
};

// ── claim fairness ──────────────────────────────────────────────────────────


// Frame prepended when an ADDRESSED seat lost the claim race: it still gets
// its turn, but knows a peer is (probably) already answering — the bar for
// posting rises from "have something to say" to "have something DIFFERENT".
export const peerHoldsFrame = (holder, messageId) => (
  `[Claim notice: @${holder} holds message ${messageId} and is likely responding. `
  + 'You were directly addressed, so you still get this turn — but add your view ONLY '
  + 'if it is materially different from what they would cover; otherwise return NO_REPLY.]'
);

/**
 * Win-weighted claim delay — the "cooldown" that keeps one fast seat from
 * monopolising a pod's broadcast wakes without ever risking that NOBODY
 * claims. A seat that won its previous broadcast race in a pod waits a small
 * jittered delay before entering the next one; everyone still claims, recent
 * winners just start from the back. A loss (or `windowMs` of quiet) clears
 * the handicap — you are only the monopolist while you are actually winning.
 *
 * Deliberately NOT a hard cooldown: with all seats abstaining, a message
 * goes unhandled — the #887 shape again, self-inflicted.
 */
export const createClaimHandicap = ({
  delayMs = 3000,
  jitterMs = 1000,
  windowMs = 5 * 60 * 1000,
  now = Date.now,
  random = Math.random,
} = {}) => {
  const wins = new Map(); // podId -> lastBroadcastWinAt

  return {
    recordWin(podId) {
      wins.set(podId, now());
    },
    recordLoss(podId) {
      wins.delete(podId);
    },
    yieldDelayMs(podId) {
      const at = wins.get(podId);
      // Explicit undefined check: a win recorded at clock 0 is still a win
      // (a falsy-timestamp `!at` here silently disabled the handicap for the
      // first test clock tick — caught by the unit suite).
      if (at === undefined || now() - at > windowMs) return 0;
      return delayMs + Math.floor(random() * jitterMs);
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
 *   longer than a split answer     → post the FIRST chunk to the channel and
 *                                    continue the rest in a thread under it.
 *   one indivisible oversize unit  → it is a genuine document: upload the FULL
 *                                    text and post one message — the reply's
 *                                    own opening plus the file card.
 *
 * The thread rung is new (Sam 57691) and it replaces attachment as the answer
 * for PROSE overflow. Before threads existed, a long analysis had nowhere to
 * go but a file, and that was the right workaround. It is now the wrong one:
 * an attachment is un-quotable, un-followable, and an all-or-nothing read,
 * so overflowing into one buries the tail of a reply in a surface nobody can
 * respond to. A thread keeps every word addressable and scopes the read.
 *
 * This is also the layer the rule has to live at. The pod-context cue already
 * tells agents "prose overflow goes in a thread, not an attachment" (#1176),
 * and the cue could not have been obeyed: the model does not choose the
 * delivery mode, THIS FUNCTION does, and it only knew how to attach. A cue
 * that promises what the wrapper contradicts teaches the agent it is failing
 * at something it never controlled.
 *
 * Attachment is kept for the case it was always right for — a single atomic
 * unit over `attachThreshold` (a long fence, an unbreakable run). That is a
 * document by construction, not prose that outgrew a message.
 *
 * If threading fails (older server with no threadRootId support, no id in the
 * response), fall back to attach, then to posting every chunk: a message
 * flood is a tone violation, silence or truncation is a correctness
 * violation, and the contract ranks content above tone ("NEVER hit that by
 * cutting content").
 */
export const deliverChatReply = async ({
  client,
  podId,
  text,
  limit = 400,
  maxChunks = 3,
  attachThreshold = 800,
  uploadName = 'reply.md',
  log = () => {},
}) => {
  const messagesPath = `/api/agents/runtime/pods/${podId}/messages`;
  const chunks = splitForChat(text, { limit });
  // The runtime route uses HTTP 200 for a policy refusal: it is a completed
  // request, but no message was created. Keep that distinction at the client
  // boundary so every delivery mode shares it rather than treating a resolved
  // promise as proof of a post.
  const postMessage = (body) => client.post(messagesPath, body);
  const refused = (response, messages, attemptedMessages) => ({
    mode: 'refused',
    messages,
    attemptedMessages,
    refused: true,
    reason: response.reason || 'message_refused',
    ...(typeof response.guidance === 'string' && response.guidance
      ? { guidance: response.guidance }
      : {}),
    ...(typeof response.consecutive === 'number'
      ? { consecutive: response.consecutive }
      : {}),
  });
  // An atomic unit (a fenced block, an unbreakable word-run) can exceed the
  // limit by construction — splitForChat keeps it whole rather than breaking
  // its rendering. The tone contract's own rule covers it: over ~800 chars of
  // ONE indivisible thing is a document, not a message — attach it. Without
  // this check a 659-char fence rode the single/split branches straight past
  // the gate (found by the fleet's implementation audit, Sharpen msg 53018).
  const hasIndivisibleOversize = chunks.some((c) => c.length > attachThreshold);
  if (chunks.length <= 1 && !hasIndivisibleOversize) {
    const response = await postMessage({ content: chunks[0] ?? text });
    if (response?.refused === true) return refused(response, 0, 1);
    return { mode: 'single', messages: 1 };
  }
  if (chunks.length <= maxChunks && !hasIndivisibleOversize) {
    let messages = 0;
    for (const chunk of chunks) {
      // eslint-disable-next-line no-await-in-loop
      const response = await postMessage({ content: chunk }); // in order, so the reply reads top-down
      if (response?.refused === true) return refused(response, messages, chunks.length);
      messages += 1;
    }
    return { mode: 'split', messages };
  }
  // PROSE OVERFLOW → THREAD. Only when nothing is indivisibly oversize: a
  // fence too big to split is a document and belongs in the attach rung below.
  if (!hasIndivisibleOversize) {
    // A COUNT, not a flag. The recovery below resumes from here, and a boolean
    // can only distinguish "nothing posted" from "something posted" — it cannot
    // say how much. Fail a continuation at chunk 3 with a boolean and chunks 1
    // and 2 are already in the thread, then get posted again top-level; the
    // reader sees them twice. Getting this wrong is silent, which is also why
    // the attach rung below leads with `chunks[0]`: falling through after a
    // successful headline duplicates the opening line. Two of this suite's
    // existing tests caught that one, and none caught this one, because both
    // fail at the root-id step before any continuation has posted.
    let posted = 0;
    try {
      const rootRes = await postMessage({ content: chunks[0] });
      if (rootRes?.refused === true) return refused(rootRes, 0, chunks.length);
      posted = 1;
      // The runtime route answers `res.json(result)` with the created row on
      // `result.message`. Accept either id field; refuse to guess if neither
      // is present, because a continuation posted with a missing root would
      // silently become another top-level message — the exact flood this rung
      // exists to prevent.
      const rootId = rootRes?.message?.id ?? rootRes?.message?._id ?? rootRes?.id ?? rootRes?._id;
      if (!rootId) throw new Error('no message id in post response — cannot root the thread');
      for (const chunk of chunks.slice(1)) {
        // eslint-disable-next-line no-await-in-loop
        const response = await postMessage({ content: chunk, threadRootId: String(rootId) });
        if (response?.refused === true) return refused(response, posted, chunks.length);
        posted += 1;
      }
      return { mode: 'thread', messages: chunks.length, threadRootId: String(rootId) };
    } catch (err) {
      if (posted > 0) {
        // The opening is already in the room. Post the REMAINDER top-level —
        // never the whole text again. This is the old flood, minus the
        // duplicate, and it is still preferable to attaching: content ranks
        // above tone, and the reader would otherwise see the same paragraph
        // twice with the rest hidden in a file.
        log(`thread continuation failed (${err.message}) — posting the remainder top-level`);
        for (const chunk of chunks.slice(posted)) {
          // eslint-disable-next-line no-await-in-loop
          const response = await postMessage({ content: chunk });
          if (response?.refused === true) return refused(response, posted, chunks.length);
          posted += 1;
        }
        return { mode: 'thread-fallback', messages: chunks.length };
      }
      // Nothing reached the room, so the attach rung below is free to lead
      // with the opening as it always did.
      log(`thread headline failed (${err.message}) — falling back to attach`);
    }
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
    // Lead with the reply's own opening — unless that opening is itself the
    // oversized atomic unit (a fence-only reply), in which case a generic
    // line keeps the message under the gate and the card carries the content.
    const lead = chunks[0] && chunks[0].length <= limit
      ? chunks[0]
      : '(reply too large for chat — attached in full)';
    const response = await postMessage({ content: `${lead}\n\n${directive}` });
    if (response?.refused === true) return refused(response, 0, 1);
    return { mode: 'attach', messages: 1 };
  } catch (err) {
    log(`attach fallback failed (${err.message}) — posting ${chunks.length} split messages instead`);
    let messages = 0;
    for (const chunk of chunks) {
      // eslint-disable-next-line no-await-in-loop
      const response = await postMessage({ content: chunk });
      if (response?.refused === true) return refused(response, messages, chunks.length);
      messages += 1;
    }
    return { mode: 'split-fallback', messages };
  }
};
