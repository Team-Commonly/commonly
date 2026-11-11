/**
 * A public seat writes nothing once Commonly has been unreachable this turn.
 *
 * A public seat answers strangers. When its Commonly calls start failing (the
 * API answers 5xx during a rollout, a connection drops, the token is refused),
 * the model's next move is to narrate the failure, and the post tool would put
 * that narration in front of a stranger. The CLI already withholds the reply it
 * would post for such a turn, and retries the event (cli/src/lib/
 * public-tool-error.js). A post the model makes itself, through this server,
 * happens before that check and is not taken back; on a retry it repeats.
 *
 * So once this process has seen Commonly unreachable, every tool that is not a
 * read refuses with one fixed line, and reads carry on. The latch lasts as long
 * as this process, which is one turn: the CLI spawns the runtime per turn, the
 * runtime starts this server as its stdio child, and this server's credential
 * is read once at start from a file minted for that spawn (client.js).
 *
 * It is on only when the CLI declares the seat public
 * (`COMMONLY_MCP_PUBLIC_SEAT=1`). Without the flag nothing changes: a private
 * seat keeps writing through a blip, and a person's own client never sees this.
 *
 * "Unreachable" is the CLI's rule read from this side: a request that got no
 * answer (`TransportError`), or an answer the person cannot be told about,
 * which is any status but the refusals in `ANSWERABLE_API_STATUSES`. That set
 * is a copy of the CLI's; a test on each side holds the two equal.
 */
import { HttpError, TransportError } from './client.js';

export const PUBLIC_SEAT_ENV = 'COMMONLY_MCP_PUBLIC_SEAT';

export const UNREACHABLE_REFUSAL = 'Commonly is unreachable this turn; post nothing.';

// cli/src/lib/public-tool-error.js ANSWERABLE_API_STATUSES, verbatim.
export const ANSWERABLE_API_STATUSES = new Set([400, 403, 404, 409, 410, 413, 422]);

// Every other tool is a write and is gated, so a tool added later is gated
// until someone lists it here. commonly_catch_up is not a read: it marks a
// backlog skipped on the server.
export const READ_ONLY_TOOLS = new Set([
  'commonly_get_started',
  'commonly_get_ui_card_catalogue',
  'commonly_get_messages',
  'commonly_get_context',
  'commonly_list_files',
  'commonly_list_artifacts',
  'commonly_read_file',
  'commonly_get_posts',
  'commonly_get_tasks',
  'commonly_list_pods',
  'commonly_read_agent_memory',
]);

export const showsCommonlyUnreachable = (error) => (
  error instanceof TransportError
  || (error instanceof HttpError && !ANSWERABLE_API_STATUSES.has(error.status))
);

export const createPublicSeatGate = (env = process.env) => {
  const active = env?.[PUBLIC_SEAT_ENV] === '1';
  let latched = false;
  return {
    active,
    get latched() { return latched; },
    observe(error) {
      if (active && showsCommonlyUnreachable(error)) latched = true;
    },
    refusal(toolName) {
      if (!active || !latched || READ_ONLY_TOOLS.has(toolName)) return null;
      return { isError: true, content: [{ type: 'text', text: UNREACHABLE_REFUSAL }] };
    },
  };
};
