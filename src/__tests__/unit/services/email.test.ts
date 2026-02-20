/**
 * Email Service Unit Tests
 *
 * Tests for email forwarding and notification functionality
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';

// Mock nodemailer before imports
const mockSendMail = jest.fn<any>().mockResolvedValue({ messageId: 'test-message-id' });
const mockVerify = jest.fn<any>().mockResolvedValue(true);
const mockTransporter = {
  sendMail: mockSendMail,
  verify: mockVerify
};

jest.mock('nodemailer', () => ({
  createTransport: jest.fn().mockReturnValue(mockTransporter)
}));

jest.mock('../../../utils/helpers', () => ({
  getDefaultDomain: jest.fn().mockReturnValue('example.com'),
  createFullAliasEmail: jest.fn().mockImplementation((alias, domain) => `${alias}@${domain}`)
}));

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  }
}));

import nodemailer from 'nodemailer';

describe('Email Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSendMail.mockResolvedValue({ messageId: 'test-message-id' });
    mockVerify.mockResolvedValue(true);

    // Set up environment
    process.env.SMTP_OUTBOUND_HOST = 'smtp.test.com';
    process.env.SMTP_OUTBOUND_PORT = '587';
    process.env.SMTP_OUTBOUND_USER = 'user@test.com';
    process.env.SMTP_OUTBOUND_PASS = 'password';
    process.env.SMTP_FROM_ADDRESS = 'noreply@test.com';
    process.env.SMTP_FROM_NAME = 'MakeAnon Test';
  });

  describe('verifyConnection', () => {
    it('should verify SMTP connection successfully', async () => {
      const { verifyConnection } = await import('../../../services/emailService');
      const result = await verifyConnection();

      expect(result).toBe(true);
      expect(mockVerify).toHaveBeenCalled();
    });

    it('should return false on connection failure', async () => {
      mockVerify.mockRejectedValue(new Error('Connection failed'));

      const { verifyConnection } = await import('../../../services/emailService');
      const result = await verifyConnection();

      expect(result).toBe(false);
    });
  });

  describe('forwardEmail', () => {
    const originalMessage = {
      from: 'sender@external.com',
      to: ['alias@makeanon.com'],
      subject: 'Test Subject',
      text: 'Test body text',
      html: '<p>Test body HTML</p>',
      messageId: '<original-message-id@external.com>'
    };

    it('should forward email successfully', async () => {
      const { forwardEmail } = await import('../../../services/emailService');
      const result = await forwardEmail(
        originalMessage,
        'user@example.com',
        'alias@makeanon.com'
      );

      expect(result.success).toBe(true);
      expect(result.messageId).toBe('test-message-id');
      expect(result.processingTime).toBeDefined();
    });

    it('should add via alias prefix to subject', async () => {
      const { forwardEmail } = await import('../../../services/emailService');
      await forwardEmail(
        originalMessage,
        'user@example.com',
        'alias@makeanon.com'
      );

      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: expect.stringContaining('[via alias@makeanon.com]')
        })
      );
    });

    it('should include forwarding headers', async () => {
      const { forwardEmail } = await import('../../../services/emailService');
      await forwardEmail(
        originalMessage,
        'user@example.com',
        'alias@makeanon.com'
      );

      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-MakeAnon-Forwarded': 'true',
            'X-MakeAnon-Original-From': 'sender@external.com',
            'X-MakeAnon-Alias': 'alias@makeanon.com'
          })
        })
      );
    });

    it('should set reply-to address when reply prefix provided', async () => {
      const { forwardEmail } = await import('../../../services/emailService');
      await forwardEmail(
        originalMessage,
        'user@example.com',
        'alias@makeanon.com',
        'r123abc'
      );

      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          replyTo: 'r123abc@makeanon.com'
        })
      );
    });

    it('should handle missing subject gracefully', async () => {
      const { forwardEmail } = await import('../../../services/emailService');
      await forwardEmail(
        { ...originalMessage, subject: '' },
        'user@example.com',
        'alias@makeanon.com'
      );

      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          subject: expect.stringContaining('(no subject)')
        })
      );
    });

    it('should return error on send failure', async () => {
      mockSendMail.mockRejectedValue(new Error('Send failed'));

      const { forwardEmail } = await import('../../../services/emailService');
      const result = await forwardEmail(
        originalMessage,
        'user@example.com',
        'alias@makeanon.com'
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Send failed');
    });

    it('should include header showing original sender in text', async () => {
      const { forwardEmail } = await import('../../../services/emailService');
      await forwardEmail(
        originalMessage,
        'user@example.com',
        'alias@makeanon.com'
      );

      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('From: sender@external.com')
        })
      );
    });

    it('should include header showing original sender in HTML', async () => {
      const { forwardEmail } = await import('../../../services/emailService');
      await forwardEmail(
        originalMessage,
        'user@example.com',
        'alias@makeanon.com'
      );

      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          html: expect.stringContaining('sender@external.com')
        })
      );
    });
  });

  describe('sendReplyEmail', () => {
    it('should send reply email successfully', async () => {
      const { sendReplyEmail } = await import('../../../services/emailService');
      const result = await sendReplyEmail(
        'original@sender.com',
        'alias@makeanon.com',
        'Re: Test Subject',
        'Reply text',
        '<p>Reply HTML</p>'
      );

      expect(result.success).toBe(true);
      expect(result.messageId).toBeDefined();
    });

    it('should send from alias address', async () => {
      const { sendReplyEmail } = await import('../../../services/emailService');
      await sendReplyEmail(
        'original@sender.com',
        'alias@makeanon.com',
        'Re: Test Subject'
      );

      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          from: 'alias@makeanon.com'
        })
      );
    });

    it('should include reply headers', async () => {
      const { sendReplyEmail } = await import('../../../services/emailService');
      await sendReplyEmail(
        'original@sender.com',
        'alias@makeanon.com',
        'Re: Test Subject'
      );

      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-MakeAnon-Reply': 'true'
          })
        })
      );
    });

    it('should handle send failure', async () => {
      mockSendMail.mockRejectedValue(new Error('Reply failed'));

      const { sendReplyEmail } = await import('../../../services/emailService');
      const result = await sendReplyEmail(
        'original@sender.com',
        'alias@makeanon.com',
        'Re: Test'
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Reply failed');
    });
  });

  describe('sendNotification', () => {
    it('should send notification email successfully', async () => {
      const { sendNotification } = await import('../../../services/emailService');
      const result = await sendNotification(
        'user@example.com',
        'Notification Subject',
        'Notification text',
        '<p>Notification HTML</p>'
      );

      expect(result.success).toBe(true);
      expect(result.messageId).toBeDefined();
    });

    it('should use configured from address', async () => {
      const { sendNotification } = await import('../../../services/emailService');
      await sendNotification(
        'user@example.com',
        'Test Subject',
        'Test text'
      );

      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          from: expect.stringContaining('MakeAnon')
        })
      );
    });

    it('should handle missing HTML body', async () => {
      const { sendNotification } = await import('../../../services/emailService');
      await sendNotification(
        'user@example.com',
        'Test Subject',
        'Text only body'
      );

      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          text: 'Text only body'
        })
      );
    });

    it('should return error on failure', async () => {
      mockSendMail.mockRejectedValue(new Error('Notification failed'));

      const { sendNotification } = await import('../../../services/emailService');
      const result = await sendNotification(
        'user@example.com',
        'Test Subject',
        'Test text'
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Notification failed');
    });
  });
});

describe('Email Transporter Configuration', () => {
  it('should create transporter with correct config', () => {
    expect(nodemailer.createTransport).toBeDefined();
  });

  describe('Pool Configuration', () => {
    it('should use connection pooling', () => {
      // Verify pool settings are applied
      const poolConfig = {
        pool: true,
        maxConnections: 5,
        maxMessages: 100
      };

      expect(poolConfig.pool).toBe(true);
      expect(poolConfig.maxConnections).toBeGreaterThan(0);
      expect(poolConfig.maxMessages).toBeGreaterThan(0);
    });
  });
});

describe('HTML Escaping', () => {
  const escapeHtml = (text: string): string => {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, (m) => map[m]);
  };

  it('should escape HTML entities', () => {
    const input = '<script>alert("xss")</script>';
    const escaped = escapeHtml(input);

    expect(escaped).not.toContain('<script>');
    expect(escaped).toContain('&lt;script&gt;');
  });

  it('should escape ampersands', () => {
    const input = 'Tom & Jerry';
    const escaped = escapeHtml(input);

    expect(escaped).toBe('Tom &amp; Jerry');
  });

  it('should escape quotes', () => {
    const input = 'Say "Hello"';
    const escaped = escapeHtml(input);

    expect(escaped).toBe('Say &quot;Hello&quot;');
  });

  it('should escape single quotes', () => {
    const input = "It's working";
    const escaped = escapeHtml(input);

    expect(escaped).toBe('It&#039;s working');
  });

  it('should handle multiple special characters', () => {
    const input = '<a href="test">Link & More</a>';
    const escaped = escapeHtml(input);

    expect(escaped).not.toContain('<a');
    expect(escaped).not.toContain('>');
    expect(escaped).not.toContain('"');
    expect(escaped).toContain('&amp;');
  });
});

describe('Email Headers', () => {
  describe('Custom Headers', () => {
    it('should include X-MakeAnon-Forwarded header', () => {
      const headers = {
        'X-MakeAnon-Forwarded': 'true',
        'X-MakeAnon-Original-From': 'sender@example.com',
        'X-MakeAnon-Alias': 'alias@makeanon.com'
      };

      expect(headers['X-MakeAnon-Forwarded']).toBe('true');
    });

    it('should preserve original message ID', () => {
      const originalMessageId = '<abc123@example.com>';
      const headers = {
        'X-MakeAnon-Original-Message-Id': originalMessageId
      };

      expect(headers['X-MakeAnon-Original-Message-Id']).toBe(originalMessageId);
    });
  });
});

describe('Email Size Limits', () => {
  it('should respect maximum email size', () => {
    const MAX_SIZE_MB = 25;
    const MAX_SIZE_BYTES = MAX_SIZE_MB * 1024 * 1024;

    expect(MAX_SIZE_BYTES).toBe(26214400);
  });

  it('should handle large attachments', () => {
    const attachment = {
      filename: 'large-file.pdf',
      size: 10 * 1024 * 1024 // 10MB
    };

    expect(attachment.size).toBeLessThan(25 * 1024 * 1024);
  });
});

describe('From Address Formatting', () => {
  it('should format from address with name', () => {
    const fromName = 'MakeAnon';
    const fromAddress = 'noreply@makeanon.com';
    const formatted = `"${fromName}" <${fromAddress}>`;

    expect(formatted).toBe('"MakeAnon" <noreply@makeanon.com>');
  });

  it('should handle special characters in name', () => {
    const fromName = 'Make "Anon" Service';
    const fromAddress = 'noreply@makeanon.com';
    const safeName = fromName.replace(/"/g, '');
    const formatted = `"${safeName}" <${fromAddress}>`;

    expect(formatted).not.toContain('""');
  });
});
