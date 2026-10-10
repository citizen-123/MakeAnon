/**
 * Email service privacy tests: no plaintext destination/recipient addresses
 * may reach logs or returned error strings (which get stored in EmailLog.error).
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';

const mockSendMail = jest.fn<(...args: any[]) => any>();

jest.mock('nodemailer', () => ({
  __esModule: true,
  default: { createTransport: jest.fn(() => ({ sendMail: mockSendMail, verify: jest.fn() })) },
}));

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { forwardEmail, sendNotification, sendReplyEmail, scrubEmailAddresses } from '../../../services/emailService';
import logger from '../../../utils/logger';

const REAL = 'real.person@private-mail.com';

function allLogText(): string {
  const l = logger as unknown as Record<string, jest.Mock>;
  return ['info', 'warn', 'error', 'debug']
    .flatMap(level => l[level].mock.calls)
    .map(args => args.map(a => (a instanceof Error ? a.message : String(a))).join(' '))
    .join('\n');
}

const message = { from: 'sender@example.org', to: ['abc@alias.test.com'], subject: 'Hi', text: 'body' };

describe('scrubEmailAddresses', () => {
  it('redacts email addresses', () => {
    expect(scrubEmailAddresses(`550 5.1.1 <${REAL}>: Recipient address rejected`)).toBe(
      '550 5.1.1 <[redacted]>: Recipient address rejected'
    );
  });

  it('redacts multiple addresses and leaves other text alone', () => {
    expect(scrubEmailAddresses('a@b.com and c.d+e@f.co failed')).toBe('[redacted] and [redacted] failed');
    expect(scrubEmailAddresses('Connection timeout')).toBe('Connection timeout');
  });

  it('caps very long messages', () => {
    expect(scrubEmailAddresses('x'.repeat(5000)).length).toBeLessThanOrEqual(500);
  });
});

describe('forwardEmail privacy', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('does not log the real destination on success', async () => {
    mockSendMail.mockResolvedValue({ messageId: 'id' });
    const result = await forwardEmail(message, REAL, 'abc@alias.test.com');
    expect(result.success).toBe(true);
    expect(allLogText()).not.toContain(REAL);
  });

  it('scrubs addresses from the returned error and does not log the failure itself', async () => {
    mockSendMail.mockRejectedValue(new Error(`Can't send mail - all recipients were rejected: 550 <${REAL}> no such user`));
    const result = await forwardEmail(message, REAL, 'abc@alias.test.com');
    expect(result.success).toBe(false);
    expect(result.error).not.toContain(REAL);
    expect(result.error).toContain('[redacted]');
    // Caller (smtpServer) logs forward failures once with alias context
    expect((logger.error as jest.Mock).mock.calls).toHaveLength(0);
    expect(allLogText()).not.toContain(REAL);
  });
});

describe('sendNotification / sendReplyEmail privacy', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('scrubs addresses in notification errors', async () => {
    mockSendMail.mockRejectedValue(new Error(`rejected ${REAL}`));
    const result = await sendNotification(REAL, 's', 't');
    expect(result.error).not.toContain(REAL);
    expect(allLogText()).not.toContain(REAL);
  });

  it('does not log third-party addresses when sending replies', async () => {
    mockSendMail.mockResolvedValue({ messageId: 'id' });
    await sendReplyEmail(REAL, 'abc@alias.test.com', 's', 't');
    mockSendMail.mockRejectedValue(new Error(`rejected ${REAL}`));
    const result = await sendReplyEmail(REAL, 'abc@alias.test.com', 's', 't');
    expect(result.error).not.toContain(REAL);
    expect(allLogText()).not.toContain(REAL);
  });
});
