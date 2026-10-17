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

  // Every QA walk registers an @ops.commonly.invalid account, and its
  // verification email bounced against the sender's reputation.
  it('skips a reserved-domain recipient without throwing, sends nothing, and logs without the address', async () => {
    process.env.SMTP2GO_API_KEY = 'smtp-key';
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});

    const result = await sendEmail({
      to: 'walk-123@ops.commonly.invalid',
      subject: 'Verify Your Email - Commonly',
      textBody: 'Plain text',
      htmlBody: '<p>Plain text</p>',
    });

    expect(result).toEqual({ skipped: 'reserved_domain', data: { skipped: 'reserved_domain' } });
    expect(axios.post).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(infoSpy.mock.calls[0])).not.toContain('commonly.invalid');
    infoSpy.mockRestore();
  });

  it('skips a reserved-domain recipient even when email is not configured: it could never deliver', async () => {
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    await expect(sendEmail({
      to: 'a@x.test', subject: 'Hello', textBody: 'Plain text', htmlBody: '<p>Plain text</p>',
    })).resolves.toEqual(expect.objectContaining({ skipped: 'reserved_domain' }));
    expect(axios.post).not.toHaveBeenCalled();
    infoSpy.mockRestore();
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
