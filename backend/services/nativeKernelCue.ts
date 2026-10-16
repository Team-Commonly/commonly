import {
  KERNEL_FRAME_TAGS, frameTagOf, joinKernelFrames, splitKernelFrames,
} from './kernelFrames';

// The kernel writes its mention frames once, for every runtime (kernelFrames).
// Two of them teach tools no native turn has. The pod frame teaches file
// attach and read, threading fields and a token file; the consultation cue
// sends the agent to a DM tool and a "codex" specialist that a stranger's pod
// does not have. A hosted agent read them, told a person it had
// commonly_read_file and pointed them at commonly_attach_file (QA walk,
// 2026-10-16), and another offered to hand work to "a coding specialist like
// @codex". So a native turn gets a pod frame that names only what it has,
// loses the consultation cue, and its trigger frame names the reader native
// has. Every other frame passes through unchanged. Of the kernel pod frame,
// what native cannot act on goes (file tools, threading fields, the MCP
// decision-card tool) along with "post as yourself", which native enforces
// itself; the tool-agnostic @handle rule is kept.
export const nativePodContextFrame = (podId: string): string => (
  `[${KERNEL_FRAME_TAGS.podContext}: this conversation is in pod \`${podId}\`. Reply with `
  + 'commonly_post_message; it posts as you. You cannot open or attach files here: if a '
  + 'message points to an attached file ([[upload:...]]), say so and ask whoever posted it '
  + 'to paste the content. To ask a person for something, @-mention their handle: a bare name '
  + 'reaches no one.]'
);

// A frame cut just before `marker`, closed again; null when the marker is
// absent, so a reworded kernel frame falls to the guard below instead of
// being cut in the wrong place.
const cutBefore = (frame: string, marker: string): string | null => {
  const at = frame.indexOf(marker);
  return at === -1 ? null : `${frame.slice(0, at).trimEnd()}]`;
};

// Two more frames name a tool native lacks inside guidance it should keep:
// the collaborative-pod cue (keep "execute it yourself" and the stale-claim
// race; drop the sentence that delegates by DM tool) and the wake frame (keep
// NO_REPLY; drop "claim first with commonly_claim_message", which the native
// runtime does itself). sprint-review on #2261: the first cut of this file
// left both, and its test only drove a one-seat pod.
const CUT_MARKERS: Readonly<Record<string, string>> = Object.freeze({
  [KERNEL_FRAME_TAGS.collaborativePod]: ' Delegate only when',
  [KERNEL_FRAME_TAGS.wakeOnMessage]: ' If you do act, the message must be claimed first',
});

const TOOL_NAME = /commonly_[a-z_]+/g;

/**
 * The kernel's mention content as a native turn should read it. `nativeTools`
 * is every tool a native turn can be offered: after the rewrites above, a
 * frame that still names any other commonly_* tool is dropped (and logged)
 * rather than shown, so a new kernel clause can never teach a native model a
 * tool it does not have.
 */
export const nativeCueFromKernel = (content: string, podId: string, nativeTools: Iterable<string>): string => {
  const { frames, body } = splitKernelFrames(content);
  if (!frames.length) return content;
  const allowed = new Set(nativeTools);
  const rewritten = frames.flatMap((frame) => {
    const tag = frameTagOf(frame);
    let next: string = frame;
    if (tag === KERNEL_FRAME_TAGS.podContext) next = nativePodContextFrame(podId);
    else if (tag === KERNEL_FRAME_TAGS.consultation) return [];
    else if (tag === KERNEL_FRAME_TAGS.trigger) next = frame.replace(/commonly_get_messages/g, 'commonly_read_context');
    else if (tag && CUT_MARKERS[tag]) next = cutBefore(frame, CUT_MARKERS[tag]) ?? frame;
    const foreign = [...new Set(next.match(TOOL_NAME) || [])].filter((name) => !allowed.has(name));
    if (foreign.length) {
      console.warn(`[native-cue] dropped a kernel frame (${tag || 'untagged'}) naming ${foreign.join(', ')}`);
      return [];
    }
    return [next];
  });
  return joinKernelFrames(rewritten, body);
};
