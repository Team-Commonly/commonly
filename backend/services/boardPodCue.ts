// Board wakes name the pod their tasks live in, on a line of its own.
//
// A wake reaches the seat beside other 24-hex ids (the pod owner, the event,
// the delivery), and nothing said which one the board's podId is. Fresh seat
// sessions then called commonly_*_task without podId: measured 2026-10-27 across
// five Haiku seats, 12 of 20 task calls made before the session had used any
// podId omitted it, against 10 of 344 afterwards (TASK-581). Same pattern as
// agentMentionService's pod-context frame: the model reads an inline literal
// it is told to pass, and skips a structured payload field.
export const formatBoardPodLine = (podId: string): string =>
  `Board pod: ${podId}; pass it as podId to every commonly_*_task call.`;
