import axios from 'axios';

interface SendResult {
  success: boolean;
  error?: string;
  // Telegram's own error_code and description, passed through unchanged for
  // callers that classify delivery failures. This service decides nothing: a
  // 400 "chat not found" and a 400 "can't parse entities" look identical here
  // and mean opposite things to a caller, so the meaning stays at the call site
  // (wren 73777) — which chat a send targets is a property of the call site, not
  // of the message text.
  errorCode?: number;
  description?: string;
  // Telegram's message_id for the sent message — the bridge stores it to
  // route quote-replies back to the agent whose line was quoted. Absent on
  // failure; existing callers that only read `success` are unaffected.
  messageId?: number;
}

// Every text interpolated into `parse_mode: 'HTML'` below must be escaped: a pod
// named `A <b>` makes Telegram reject the whole send with 400 "can't parse
// entities", and the bind confirmation that carries the pod name must never be
// lost that way (wren 73778). Lives beside the parse_mode it exists for so the
// route and the bridge share one implementation instead of a fourth copy.
const escapeHtml = (raw: string): string => String(raw)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

async function sendMessage(botToken: string, chatId: string | number, text: string, options?: {
  replyToMessageId?: string;
  plainText?: boolean;
}): Promise<SendResult> {
  if (!botToken || !chatId || !text) {
    return { success: false, error: 'Missing botToken, chatId, or text' };
  }

  try {
    const response = await axios.post<{ ok: boolean; result?: { message_id?: number } }>(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        chat_id: chatId,
        text,
        ...(!options?.plainText ? { parse_mode: 'HTML' } : {}),
        ...(options?.replyToMessageId ? { reply_parameters: { message_id: Number(options.replyToMessageId) } } : {}),
        disable_web_page_preview: true,
      },
    );

    return {
      success: response.data?.ok === true,
      messageId: response.data?.result?.message_id,
    };
  } catch (error) {
    const err = error as {
      response?: { data?: { error_code?: number; description?: string } };
      message: string;
    };
    console.error(
      'Error sending Telegram message:',
      err.response?.data || err.message,
    );
    return {
      success: false,
      error: err.message,
      errorCode: err.response?.data?.error_code,
      description: err.response?.data?.description,
    };
  }
}

export { sendMessage, escapeHtml };
