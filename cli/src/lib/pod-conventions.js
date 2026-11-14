/**
 * Pod conventions for a CLI turn (F124, TASK-766).
 *
 * The server returns them in the runtime context read, next to focus, and the
 * turn opens with the same frame a native turn gets. Unlike focus they are
 * optional: a server from before F124 omits them, and a malformed value is
 * dropped, so the turn runs without a frame rather than being withheld.
 */

// The server caps the text at 4000 code points. A wider value from another
// server is cut here with a marker, so a turn's prompt stays bounded.
export const CONVENTIONS_FRAME_MAX_CODE_POINTS = 4000;

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

/**
 * The `conventions` member of a context read, as { revision, text, author },
 * or null when absent, empty, for another pod, or malformed.
 */
export const normalizePodConventions = (dto, podId) => {
  if (!dto || typeof dto !== 'object' || Array.isArray(dto)) return null;
  if (hasOwn(dto, 'podId') && podId !== undefined && String(dto.podId) !== String(podId)) return null;
  const conventions = dto.conventions;
  if (!conventions || typeof conventions !== 'object' || typeof conventions.text !== 'string') return null;
  const text = conventions.text.trim();
  if (!text) return null;
  const label = conventions.updatedBy && typeof conventions.updatedBy.label === 'string'
    ? conventions.updatedBy.label.trim() : '';
  return {
    revision: Number.isInteger(dto.revision) && dto.revision >= 0 ? dto.revision : 0,
    text,
    author: label || null,
  };
};

/**
 * The block a turn opens with; '' when the pod has none. The wording matches
 * the server's native frame (backend/services/podConventionsService.ts): the
 * person who set them is named, and the seat's own instructions win.
 */
export const formatPodConventionsFrame = (conventions, {
  maxCodePoints = CONVENTIONS_FRAME_MAX_CODE_POINTS,
} = {}) => {
  if (!conventions || typeof conventions.text !== 'string' || !conventions.text) return '';
  const points = Array.from(conventions.text);
  const text = points.length > maxCodePoints
    ? `${points.slice(0, maxCodePoints).join('')}\n… (cut; the full text is in get_context)`
    : conventions.text;
  const author = conventions.author || 'the pod\'s creator';
  return [
    `=== Pod conventions (this pod's working rules, set by ${author}; revision ${conventions.revision ?? 0}. `
      + 'Follow them here; where they conflict with your own instructions, your own instructions win.) ===',
    text,
    '=== End of pod conventions ===',
  ].join('\n');
};
