/**
 * The one place that writes to the socket, so a scripted cut behaves the same
 * in every wire format: after N frames (SSE) or N bytes (JSON), the provider
 * either goes silent with the socket held open or destroys the socket.
 */

export const openReply = (res, cut) => {
  let frames = 0;
  let cutOff = false;

  const stop = () => {
    cutOff = true;
    // end(), not destroy(): flush what was promised, then FIN mid-body.
    if (cut.mode === 'close') res.socket?.end();
  };

  /**
   * Write one SSE frame unless the cut has been reached. The cut fires right
   * after the Nth frame, so a cut at exactly the last frame leaves the stream
   * complete but never terminated; a cut past it is no cut.
   */
  const frame = (text) => {
    if (cutOff) return false;
    res.write(text);
    frames += 1;
    if (cut && frames >= cut.after) stop();
    return !cutOff;
  };

  return {
    get cutOff() { return cutOff; },

    json(status, value, headers = {}) {
      const body = Buffer.from(JSON.stringify(value));
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': body.length, ...headers });
      if (!cut) { res.end(body); return; }
      // A cut JSON body is a truncated body: the client was promised more bytes.
      res.write(body.subarray(0, Math.min(cut.after, body.length)));
      stop();
    },

    sse(headers = {}) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...headers });
      res.flushHeaders();
      if (cut && cut.after === 0) stop();
      return {
        /** Named event (Anthropic, Responses) or bare data frame (chat) when name is null. */
        event: (name, data) => frame(`${name ? `event: ${name}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`),
        end: () => { if (!cutOff) res.end(); },
      };
    },
  };
};
