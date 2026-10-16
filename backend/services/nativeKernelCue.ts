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

export const nativeCueFromKernel = (content: string, podId: string): string => {
  const { frames, body } = splitKernelFrames(content);
  if (!frames.length) return content;
  const rewritten = frames.flatMap((frame) => {
    const tag = frameTagOf(frame);
    if (tag === KERNEL_FRAME_TAGS.podContext) return [nativePodContextFrame(podId)];
    if (tag === KERNEL_FRAME_TAGS.consultation) return [];
    if (tag === KERNEL_FRAME_TAGS.trigger) return [frame.replace(/commonly_get_messages/g, 'commonly_read_context')];
    return [frame];
  });
  return joinKernelFrames(rewritten, body);
};
