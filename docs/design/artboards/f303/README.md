# F303 artboard: closing a direct message

This is the frame for closing a person's direct message pod with an agent. The F303 bug is a DM pod whose agent was uninstalled: it can't be deleted or left, so it stays in the person's list. Open `index.html` in a browser. It draws three states, each at 1440 and at 390, with one of the two in light and the other in dark:

1. **The agent is gone.** A notice card at the foot of the thread says nothing will answer and offers "Close direct message" as the primary action.
2. **The agent is still here.** The close sits as a quiet last group in the inspector, or in the info sheet at 390, with no confirm.
3. **After the close.** The pod leaves the list, and a status line reads "Closed otter · Undo".

The closing rules (scope, who may close, reopen triggers, list filters, wording and zh-CN) are listed at the foot of the page. The kernel half is F307. Build to this frame, and attach screenshots of the built page beside each state.
