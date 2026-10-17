import { isReservedEmailDomain } from '../utils/reservedEmailDomain';
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
  // The backstop for every caller (sprint-review on #2298): an address on a
  // reserved domain (.invalid, .test, .example, .localhost) can never receive
  // mail, so a send buys only a bounce against the reputation every real
  // person's email depends on. Every QA walk registers such an account and its
  // verification email bounced. Returned, never thrown: a throw would send the
  // background verification into its retry and log as a delivery failure.
  // `data` mirrors the reason for callers that log the provider's response.
  // Callers that can skip earlier still should (the digest skips before it
  // mints a token); this only stops the send itself.
  if (isReservedEmailDomain(to)) {
    console.info('Email skipped: the recipient is on a reserved domain and cannot be delivered.', { subject });
    return { skipped: 'reserved_domain', data: { skipped: 'reserved_domain' } };
  }
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

