import axios from 'axios';

interface SendResult {
  success: boolean;
  error?: string;
  // Telegram's message_id for the sent message — the bridge stores it to
  // route quote-replies back to the agent whose line was quoted. Absent on
  // failure; existing callers that only read `success` are unaffected.
  messageId?: number;
}

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
    const err = error as { response?: { data: unknown }; message: string };
    console.error(
      'Error sending Telegram message:',
      err.response?.data || err.message,
    );
    return { success: false, error: err.message };
  }
}

export { sendMessage };
