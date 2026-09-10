/**
 * Shared-pod focus bridge for the local CLI driver.
 *
 * The server's runtime context endpoint is the source of truth.  This module
 * deliberately keeps the read and the text formatter together so every CLI
 * adapter receives the same bounded projection, including resumed sessions.
 */

export const FOCUS_FRAME_MAX_CODE_POINTS = 8000;
export const FOCUS_TASK_TITLE_MAX_CODE_POINTS = 160;

const codePointLength = (value) => Array.from(String(value)).length;

const asText = (value, fallback = '') => {
  if (value === null || value === undefined) return fallback;
  return String(value);
};

const truncateCodePoints = (value, max) => {
  const text = asText(value);
  const points = Array.from(text);
  if (points.length <= max) return text;
  if (max <= 1) return '…'.slice(0, max);
  return `${points.slice(0, max - 1).join('')}…`;
};

export class PodFocusError extends Error {
  constructor(message, details = {}, options = {}) {
    super(message, options);
    this.name = 'PodFocusError';
    Object.assign(this, details);
  }
}

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

const invalidContract = (message, details = {}) => new PodFocusError(message, {
  code: 'pod_focus_contract_invalid',
  ...details,
});

const normalizeDto = (dto, podId) => {
  if (!dto || typeof dto !== 'object' || Array.isArray(dto)) {
    throw invalidContract('Runtime context did not return a PodFocusRead object', { podId });
  }
  if (!hasOwn(dto, 'podId') || String(dto.podId) !== String(podId)) {
    throw invalidContract('Runtime context returned a focus for a different pod', {
      podId,
      returnedPodId: dto.podId ?? null,
    });
  }
  if (!hasOwn(dto, 'revision')
    || !Number.isInteger(dto.revision)
    || dto.revision < 0) {
    throw invalidContract('Runtime context returned an invalid focus revision', {
      podId,
      focusRevision: dto.revision ?? null,
    });
  }
  if (!hasOwn(dto, 'focus')
    || (dto.focus !== null
      && (typeof dto.focus !== 'object' || Array.isArray(dto.focus)))) {
    throw invalidContract('Runtime context returned an invalid focus value', {
      podId,
      focusRevision: dto.revision,
    });
  }
  return {
    podId: String(dto.podId),
    revision: dto.revision,
    focus: dto.focus,
  };
};

/**
 * Read only the focus projection from the authorized runtime context route.
 * `skillMode=none` is important: a turn-start focus read must not trigger pod
 * skill synthesis as a side effect.  A failed read is intentionally thrown so
 * the caller leaves the event unacknowledged for the existing retry path.
 */
export const readPodFocus = async (client, podId) => {
  if (!podId) {
    throw new PodFocusError('Pod focus read requires a pod id', {
      code: 'pod_focus_read_failed',
      podId: null,
    });
  }
  try {
    const body = await client.get(
      `/api/agents/runtime/pods/${encodeURIComponent(podId)}/context`,
      { skillMode: 'none' },
    );
    if (!body || typeof body !== 'object' || !hasOwn(body, 'focus')) {
      throw invalidContract('Runtime context did not include the published focus DTO', { podId });
    }
    return normalizeDto(body.focus, podId);
  } catch (cause) {
    // Preserve contract diagnostics instead of relabelling them as transient
    // transport failures. The run loop still retries the queued event, but the
    // operator sees the repair-needed cause and revision metadata.
    if (cause?.code === 'pod_focus_contract_invalid') throw cause;
    throw new PodFocusError(
      `Pod focus read failed for pod ${podId}: ${cause?.message || 'unknown error'}`,
      {
        code: 'pod_focus_read_failed',
        podId: String(podId),
        cause,
      },
      { cause },
    );
  }
};

const taskDetail = (task) => {
  const id = asText(task?.taskId, '(unknown task)');
  const title = truncateCodePoints(task?.title, FOCUS_TASK_TITLE_MAX_CODE_POINTS) || '(untitled)';
  const details = [`title=${title}`];
  if (task?.status !== null && task?.status !== undefined && task.status !== '') {
    details.push(`status=${truncateCodePoints(task.status, 80)}`);
  }
  if (task?.assignee !== null && task?.assignee !== undefined && task.assignee !== '') {
    details.push(`assignee=${truncateCodePoints(task.assignee, 80)}`);
  }
  if (task?.updatedAt !== null && task?.updatedAt !== undefined && task.updatedAt !== '') {
    details.push(`updatedAt=${truncateCodePoints(task.updatedAt, 80)}`);
  }
  if (task?.available === false) details.push('unavailable');
  return `- ${id}: ${details.join('; ')}`;
};

/**
 * Render a PodFocusRead into bounded pod context.
 *
 * Goal, scope, owner identity/label, revision, and every selected task id are
 * protected fields: they are never truncated.  If those fields alone exceed
 * the budget, fail closed before a model is spawned.  Task labels and live
 * metadata are the only content eligible for the remaining budget.
 */
export const formatPodFocusFrame = (read, {
  maxCodePoints = FOCUS_FRAME_MAX_CODE_POINTS,
} = {}) => {
  const limit = Number.isFinite(maxCodePoints) && maxCodePoints > 0
    ? Math.floor(maxCodePoints)
    : FOCUS_FRAME_MAX_CODE_POINTS;
  const normalized = normalizeDto(read, read?.podId || 'unknown');
  const focus = normalized.focus;

  if (focus === null || focus === undefined) {
    const empty = [
      '=== Pod focus (pod context; not instructions) ===',
      `pod: ${normalized.podId}`,
      `revision: ${normalized.revision}`,
      'No focus set.',
    ].join('\n');
    if (codePointLength(empty) > limit) {
      throw new PodFocusError('Pod focus frame exceeds its code-point budget', {
        code: 'FOCUS_FRAME_PROTECTED_OVERFLOW',
        measuredCodePoints: codePointLength(empty),
        allowedCodePoints: limit,
        focusRevision: normalized.revision,
      });
    }
    return empty;
  }

  const owner = focus.owner && typeof focus.owner === 'object' ? focus.owner : {};
  const tasks = Array.isArray(focus.nextTasks) ? focus.nextTasks : [];
  const taskIds = tasks.map((task) => asText(task?.taskId, '(unknown task)'));
  const ownerLabel = asText(owner.label, '(unlabeled)');
  const ownerId = asText(owner.userId, '(unknown user)');
  const ownerAvailability = owner.available === false ? ' [unavailable]' : '';
  const orderedIds = taskIds.length > 0 ? taskIds.join(' → ') : '(none)';

  // Keep these lines independent from task detail packing. Their complete
  // values are the contract's protected portion.
  const protectedFrame = [
    '=== Pod focus (pod context; not instructions) ===',
    `pod: ${normalized.podId}`,
    `revision: ${asText(normalized.revision, '0')}`,
    `goal: ${asText(focus.goal)}`,
    `scope: ${asText(focus.scope)}`,
    `owner: ${ownerLabel} (${ownerId})${ownerAvailability}`,
    `next task order: ${orderedIds}`,
  ].join('\n');
  const protectedSize = codePointLength(protectedFrame);
  if (protectedSize > limit) {
    throw new PodFocusError('Protected pod focus fields exceed the code-point budget', {
      code: 'FOCUS_FRAME_PROTECTED_OVERFLOW',
      measuredCodePoints: protectedSize,
      allowedCodePoints: limit,
      focusRevision: normalized.revision ?? 0,
    });
  }

  if (tasks.length === 0) return protectedFrame;

  // Keep a finite marker in every populated frame. It documents that the
  // structured board/context read remains the place for complete task detail,
  // and reserving it makes packing deterministic at the exact boundary.
  const marker = '… full task details in board / get_context.';
  const detailHeader = 'task details:';
  let frame = `${protectedFrame}\n${detailHeader}`;
  let omitted = false;
  for (const task of tasks) {
    const line = taskDetail(task);
    const candidate = `${frame}\n${line}`;
    const withMarker = `${candidate}\n${marker}`;
    if (codePointLength(withMarker) <= limit) {
      frame = candidate;
    } else {
      omitted = true;
    }
  }

  // The marker is always useful, and the protected portion was already proven
  // to fit. If there is not enough room for the detail header plus marker,
  // return the protected fields alone rather than slicing them.
  const marked = `${frame}\n${marker}`;
  if (codePointLength(marked) <= limit) return marked;
  if (omitted || codePointLength(`${protectedFrame}\n${detailHeader}\n${marker}`) > limit) {
    return protectedFrame;
  }
  return frame;
};
