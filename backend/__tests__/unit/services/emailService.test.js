jest.mock('axios', () => ({ post: jest.fn() }));

const axios = require('axios');
const {
  EmailNotConfiguredError,
  sendEmail,
} = require('../../../services/emailService');

describe('emailService', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.SMTP2GO_API_KEY;
    delete process.env.SMTP2GO_BASE_URL;
    process.env.SMTP2GO_FROM_EMAIL = 'hello@commonly.me';
    process.env.SMTP2GO_FROM_NAME = 'Commonly';
    axios.post.mockReset();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('throws a typed error without an SMTP2GO API key and makes no network call', async () => {
    await expect(sendEmail({
      to: 'person@example.com',
      subject: 'Hello',
      textBody: 'Plain text',
      htmlBody: '<p>Plain text</p>',
    })).rejects.toBeInstanceOf(EmailNotConfiguredError);
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('sends the shared SMTP2GO payload with the configured endpoint', async () => {
    process.env.SMTP2GO_API_KEY = 'smtp-key';
    process.env.SMTP2GO_BASE_URL = 'https://smtp.example/v3/';
    axios.post.mockResolvedValue({ data: { data: { succeeded: 1 } } });

    await sendEmail({
      to: 'person@example.com',
      subject: 'Daily digest',
      textBody: 'Plain text',
      htmlBody: '<p>Plain text</p>',
    });

    expect(axios.post).toHaveBeenCalledWith(
      'https://smtp.example/v3/email/send',
      {
        api_key: 'smtp-key',
        to: ['person@example.com'],
        sender: 'hello@commonly.me',
        from_name: 'Commonly',
        subject: 'Daily digest',
        text_body: 'Plain text',
        html_body: '<p>Plain text</p>',
      },
      { timeout: 30000 },
    );
  });
});
