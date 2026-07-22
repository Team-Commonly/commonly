// eslint-disable-next-line global-require
const axios = require('axios');

export interface SendEmailOptions {
  to: string;
  subject: string;
  textBody: string;
  htmlBody: string;
}

export class EmailNotConfiguredError extends Error {
  code: string;

  constructor() {
    super('SMTP2GO email delivery is not configured');
    this.name = 'EmailNotConfiguredError';
    this.code = 'EMAIL_NOT_CONFIGURED';
  }
}

export const sendEmail = async ({
  to,
  subject,
  textBody,
  htmlBody,
}: SendEmailOptions): Promise<any> => {
  const apiKey = process.env.SMTP2GO_API_KEY;
  if (!apiKey) throw new EmailNotConfiguredError();

  const baseUrl = String(process.env.SMTP2GO_BASE_URL || 'https://api.smtp2go.com/v3')
    .replace(/\/$/, '');

  return axios.post(`${baseUrl}/email/send`, {
    api_key: apiKey,
    to: [to],
    sender: process.env.SMTP2GO_FROM_EMAIL,
    from_name: process.env.SMTP2GO_FROM_NAME || 'Commonly',
    subject,
    text_body: textBody,
    html_body: htmlBody,
  }, { timeout: 30000 });
};

