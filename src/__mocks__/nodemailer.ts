/**
 * Nodemailer Mock
 *
 * Provides a mock implementation of nodemailer for testing
 */

import { jest } from '@jest/globals';

// Store sent emails for verification
export const sentEmails: Array<{
  from: string;
  to: string;
  subject: string;
  text?: string;
  html?: string;
  headers?: Record<string, string>;
  messageId: string;
  timestamp: Date;
}> = [];

export const resetSentEmails = () => {
  sentEmails.length = 0;
};

// Mock transporter
export const mockTransporter = {
  sendMail: jest.fn<(mailOptions: any) => Promise<any>>().mockImplementation((mailOptions: any) => {
    const messageId = `<test-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local>`;
    sentEmails.push({
      from: mailOptions.from,
      to: mailOptions.to,
      subject: mailOptions.subject,
      text: mailOptions.text,
      html: mailOptions.html,
      headers: mailOptions.headers,
      messageId,
      timestamp: new Date()
    });
    return Promise.resolve({
      messageId,
      accepted: [mailOptions.to],
      rejected: [],
      pending: [],
      response: '250 OK'
    });
  }),
  verify: jest.fn<() => Promise<boolean>>().mockResolvedValue(true),
  close: jest.fn()
};

// Mock createTransport
export const createTransport = jest.fn().mockReturnValue(mockTransporter);

// Default export matching nodemailer structure
const nodemailer = {
  createTransport
};

export default nodemailer;

// Helper to get last sent email
export const getLastSentEmail = () => sentEmails[sentEmails.length - 1];

// Helper to find emails by recipient
export const findEmailsByRecipient = (recipient: string) =>
  sentEmails.filter(email => email.to === recipient || email.to.includes(recipient));

// Helper to find emails by subject
export const findEmailsBySubject = (subject: string) =>
  sentEmails.filter(email => email.subject.includes(subject));
