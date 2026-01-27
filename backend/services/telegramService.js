const axios = require('axios');

async function sendMessage(botToken, chatId, text) {
  if (!botToken || !chatId || !text) {
    return { success: false, error: 'Missing botToken, chatId, or text' };
  }

  try {
    const response = await axios.post(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      },
    );

    return { success: response.data?.ok === true };
  } catch (error) {
    console.error(
      'Error sending Telegram message:',
      error.response?.data || error.message,
    );
    return { success: false, error: error.message };
  }
}

module.exports = {
  sendMessage,
};
