/**
 * SMTP server unit tests: wildcard matching, sender blocking, alias
 * deliverability, forward-failure handling, size limits, TLS loading.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, jest } from '@jest/globals';
import { Readable } from 'stream';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';

process.env.MIN_PROCESSING_MS = '0';

const mockPrisma = {
  alias: { findFirst: jest.fn<(...args: any[]) => any>(), update: jest.fn<(...args: any[]) => any>() },
  emailLog: { create: jest.fn<(...args: any[]) => any>() },
};

jest.mock('../../../services/database', () => ({ __esModule: true, default: mockPrisma }));

const mockForwardEmail = jest.fn<(...args: any[]) => any>();
jest.mock('../../../services/emailService', () => {
  const actual = jest.requireActual('../../../services/emailService') as Record<string, unknown>;
  return { __esModule: true, ...actual, forwardEmail: (...args: unknown[]) => mockForwardEmail(...args) };
});

const delivered = new Set<string>();
jest.mock('../../../services/redis', () => ({
  __esModule: true,
  checkRateLimit: jest.fn(async () => ({ allowed: true, remaining: 1, resetAt: new Date() })),
  getCachedAlias: jest.fn(async () => null),
  cacheAlias: jest.fn(async () => undefined),
  isDeliveryRecorded: jest.fn(async (id: string) => delivered.has(id)),
  recordDelivery: jest.fn(async (id: string) => {
    if (delivered.has(id)) return false;
    delivered.add(id);
    return true;
  }),
}));

jest.mock('../../../utils/encryption', () => ({
  __esModule: true,
  decryptEmail: jest.fn(() => 'owner@private.example'),
}));

jest.mock('../../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  wildcardMatch,
  isSenderBlocked,
  getAliasBlockReason,
  processEmail,
  loadTlsCredentials,
  refreshTlsCredentials,
  SmtpResponseError,
} from '../../../services/smtpServer';
import logger from '../../../utils/logger';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAlias(overrides: Record<string, unknown> = {}) {
  return {
    id: 'alias-id',
    alias: 'abc123',
    fullAddress: 'abc123@test.example.com',
    destinationEmail: 'ciphertext',
    destinationIv: 'iv',
    destinationSalt: 'salt',
    destinationAuthTag: 'tag',
    isEncrypted: true,
    emailVerified: true,
    isActive: true,
    isPrivate: false,
    replyEnabled: false,
    replyPrefix: null,
    userId: null,
    domainId: 'domain-id',
    expiresAt: null,
    user: null,
    blockedSenders: [],
    ...overrides,
  };
}

function makeMessage(opts: { from?: string; messageId?: string; body?: string } = {}) {
  return [
    `From: ${opts.from || 'Sender <sender@example.org>'}`,
    'To: abc123@test.example.com',
    'Subject: Hello',
    `Message-ID: ${opts.messageId || '<msg-1@example.org>'}`,
    '',
    opts.body || 'Hello there',
    '',
  ].join('\r\n');
}

function makeStream(raw: string, sizeExceeded = false) {
  const stream = Readable.from([Buffer.from(raw)]) as Readable & { sizeExceeded: boolean; byteLength: number };
  stream.sizeExceeded = sizeExceeded;
  stream.byteLength = raw.length;
  return stream as any;
}

function makeSession(rcpts: string[], mailFrom = 'sender@example.org') {
  return {
    envelope: {
      mailFrom: { address: mailFrom, args: false },
      rcptTo: rcpts.map(address => ({ address, args: false })),
    },
  } as any;
}

function allLogText(): string {
  const l = logger as unknown as Record<string, jest.Mock>;
  return ['info', 'warn', 'error', 'debug']
    .flatMap(level => l[level].mock.calls)
    .map(args => args.map(a => (a instanceof Error ? a.message : String(a))).join(' '))
    .join('\n');
}

// ---------------------------------------------------------------------------
// wildcardMatch
// ---------------------------------------------------------------------------

describe('wildcardMatch', () => {
  it('matches exact strings case-insensitively', () => {
    expect(wildcardMatch('Spam@Example.com', 'spam@example.COM')).toBe(true);
    expect(wildcardMatch('spam@example.com', 'spam@example.co')).toBe(false);
  });

  it('supports * and ?', () => {
    expect(wildcardMatch('*@spam.com', 'anyone@spam.com')).toBe(true);
    expect(wildcardMatch('*@spam.com', 'anyone@notspam.org')).toBe(false);
    expect(wildcardMatch('news?@*.com', 'news1@foo.com')).toBe(true);
    expect(wildcardMatch('news?@*.com', 'news12@foo.com')).toBe(false);
    expect(wildcardMatch('*', '')).toBe(true);
    expect(wildcardMatch('?', '')).toBe(false);
    expect(wildcardMatch('a*b*c', 'axxbyyc')).toBe(true);
    expect(wildcardMatch('a*b*c', 'axxbyy')).toBe(false);
  });

  it('treats regex metacharacters literally', () => {
    expect(wildcardMatch('a.b@x.com', 'axb@x.com')).toBe(false);
    expect(wildcardMatch('(a+)+$@x.com', '(a+)+$@x.com')).toBe(true);
  });

  it('collapses consecutive stars', () => {
    expect(wildcardMatch('***@x.com', 'abc@x.com')).toBe(true);
  });

  it('handles pathological patterns quickly', () => {
    const pattern = '*a*a*a*a*a*a*a*a*@b';
    const text = 'a'.repeat(200);
    const start = Date.now();
    expect(wildcardMatch(pattern, text)).toBe(false);
    expect(wildcardMatch('*' + '*a'.repeat(50) + '@b', 'a'.repeat(5000))).toBe(false);
    expect(Date.now() - start).toBeLessThan(50);
  });
});

// ---------------------------------------------------------------------------
// isSenderBlocked
// ---------------------------------------------------------------------------

describe('isSenderBlocked', () => {
  const blocked = [
    { email: 'bad@spam.com', isPattern: false },
    { email: '*@evil.org', isPattern: true },
  ];

  it('blocks when any sender address matches', () => {
    expect(isSenderBlocked(['ok@fine.com', 'BAD@spam.com'], blocked)).toBe(true);
    expect(isSenderBlocked(['x@evil.org'], blocked)).toBe(true);
    expect(isSenderBlocked(['ok@fine.com'], blocked)).toBe(false);
    expect(isSenderBlocked([], blocked)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getAliasBlockReason
// ---------------------------------------------------------------------------

describe('getAliasBlockReason', () => {
  it('allows active, verified, unexpired public aliases', () => {
    expect(getAliasBlockReason(makeAlias() as any)).toBeNull();
  });

  it('blocks inactive aliases', () => {
    expect(getAliasBlockReason(makeAlias({ isActive: false }) as any)).toMatch(/inactive/i);
  });

  it('blocks unverified aliases', () => {
    expect(getAliasBlockReason(makeAlias({ emailVerified: false }) as any)).toMatch(/verified/i);
  });

  it('blocks expired aliases (Date or cached ISO string)', () => {
    const past = new Date(Date.now() - 1000);
    expect(getAliasBlockReason(makeAlias({ expiresAt: past }) as any)).toMatch(/expired/i);
    expect(getAliasBlockReason(makeAlias({ expiresAt: past.toISOString() }) as any)).toMatch(/expired/i);
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(getAliasBlockReason(makeAlias({ expiresAt: future }) as any)).toBeNull();
  });

  it('blocks private aliases whose owner is inactive or missing', () => {
    expect(getAliasBlockReason(makeAlias({ isPrivate: true, userId: 'u', user: { isActive: false } }) as any)).toMatch(/owner/i);
    expect(getAliasBlockReason(makeAlias({ isPrivate: true, userId: 'u', user: null }) as any)).toMatch(/owner/i);
    expect(getAliasBlockReason(makeAlias({ isPrivate: true, userId: null, user: null }) as any)).toMatch(/owner/i);
    expect(getAliasBlockReason(makeAlias({ isPrivate: true, userId: 'u', user: { isActive: true } }) as any)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// processEmail
// ---------------------------------------------------------------------------

describe('processEmail', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delivered.clear();
    mockPrisma.alias.findFirst.mockResolvedValue(makeAlias());
    mockPrisma.alias.update.mockResolvedValue({});
    mockPrisma.emailLog.create.mockResolvedValue({});
    mockForwardEmail.mockResolvedValue({ success: true, messageId: 'out-1' });
  });

  it('forwards to an active verified alias', async () => {
    await expect(processEmail(makeSession(['abc123@test.example.com']), makeStream(makeMessage()))).resolves.toBeUndefined();
    expect(mockForwardEmail).toHaveBeenCalledTimes(1);
  });

  it('includes the user and expiry in the alias lookup', async () => {
    await processEmail(makeSession(['abc123@test.example.com']), makeStream(makeMessage()));
    const select = mockPrisma.alias.findFirst.mock.calls[0][0].select;
    expect(select.expiresAt).toBe(true);
    expect(select.user).toEqual({ select: { isActive: true } });
  });

  it.each([
    ['unverified', { emailVerified: false }],
    ['expired', { expiresAt: new Date(Date.now() - 1000) }],
    ['owner inactive', { isPrivate: true, userId: 'u1', user: { isActive: false } }],
    ['owner missing', { isPrivate: true, userId: 'u1', user: null }],
  ])('does not forward when alias is %s', async (_label, overrides) => {
    mockPrisma.alias.findFirst.mockResolvedValue(makeAlias(overrides));
    await processEmail(makeSession(['abc123@test.example.com']), makeStream(makeMessage()));
    expect(mockForwardEmail).not.toHaveBeenCalled();
    expect(mockPrisma.emailLog.create.mock.calls[0][0].data.status).toBe('blocked');
  });

  it('responds 451 when forwarding fails, and logs the failure once', async () => {
    mockForwardEmail.mockResolvedValue({ success: false, error: 'Connection refused' });
    const err = await processEmail(makeSession(['abc123@test.example.com']), makeStream(makeMessage())).catch(e => e);
    expect(err).toBeInstanceOf(SmtpResponseError);
    expect(err.responseCode).toBe(451);
    expect(err.message).toMatch(/^4\.3\.0 /);
    expect((logger.error as jest.Mock).mock.calls).toHaveLength(1);
    expect(mockPrisma.emailLog.create.mock.calls[0][0].data.status).toBe('failed');
  });

  it('responds 451 on unexpected processing errors', async () => {
    mockPrisma.alias.findFirst.mockRejectedValue(new Error('db down'));
    const err = await processEmail(makeSession(['abc123@test.example.com']), makeStream(makeMessage())).catch(e => e);
    expect(err).toBeInstanceOf(SmtpResponseError);
    expect(err.responseCode).toBe(451);
  });

  it('skips already-delivered recipients when the same message is retried', async () => {
    const rcpts = ['abc123@test.example.com', 'def456@test.example.com'];
    mockPrisma.alias.findFirst.mockImplementation(async (args: any) =>
      makeAlias({ id: args.where.alias, alias: args.where.alias, fullAddress: `${args.where.alias}@test.example.com` })
    );
    // First attempt: first recipient succeeds, second fails
    mockForwardEmail
      .mockResolvedValueOnce({ success: true, messageId: 'o1' })
      .mockResolvedValueOnce({ success: false, error: 'timeout' });
    const err = await processEmail(makeSession(rcpts), makeStream(makeMessage())).catch(e => e);
    expect(err.responseCode).toBe(451);
    expect(mockForwardEmail).toHaveBeenCalledTimes(2);

    // Retry: only the failed recipient is forwarded
    mockForwardEmail.mockReset();
    mockForwardEmail.mockResolvedValue({ success: true, messageId: 'o2' });
    await expect(processEmail(makeSession(rcpts), makeStream(makeMessage()))).resolves.toBeUndefined();
    expect(mockForwardEmail).toHaveBeenCalledTimes(1);
    expect(mockForwardEmail.mock.calls[0][2]).toBe('def456@test.example.com');
  });

  it('does not treat a different message with the same Message-ID as a retry', async () => {
    await processEmail(makeSession(['abc123@test.example.com']), makeStream(makeMessage({ body: 'one' })));
    await processEmail(makeSession(['abc123@test.example.com']), makeStream(makeMessage({ body: 'two' })));
    expect(mockForwardEmail).toHaveBeenCalledTimes(2);
  });

  it('rejects oversized messages with 552 5.3.4', async () => {
    const err = await processEmail(makeSession(['abc123@test.example.com']), makeStream(makeMessage(), true)).catch(e => e);
    expect(err).toBeInstanceOf(SmtpResponseError);
    expect(err.responseCode).toBe(552);
    expect(err.message).toMatch(/^5\.3\.4 /);
    expect(mockForwardEmail).not.toHaveBeenCalled();
  });

  it('blocks when the From header matches a blocked sender even if MAIL FROM does not', async () => {
    mockPrisma.alias.findFirst.mockResolvedValue(makeAlias({ blockedSenders: [{ email: '*@evil.org', isPattern: true }] }));
    await processEmail(
      makeSession(['abc123@test.example.com'], 'bounce@innocent.net'),
      makeStream(makeMessage({ from: 'Evil <boss@evil.org>' }))
    );
    expect(mockForwardEmail).not.toHaveBeenCalled();
    expect(mockPrisma.emailLog.create.mock.calls[0][0].data.status).toBe('blocked');
  });

  it('blocks when MAIL FROM matches a blocked sender', async () => {
    mockPrisma.alias.findFirst.mockResolvedValue(makeAlias({ blockedSenders: [{ email: 'bounce@innocent.net', isPattern: false }] }));
    await processEmail(makeSession(['abc123@test.example.com'], 'bounce@innocent.net'), makeStream(makeMessage()));
    expect(mockForwardEmail).not.toHaveBeenCalled();
  });

  it('never logs the decrypted destination address', async () => {
    mockForwardEmail.mockResolvedValue({ success: false, error: 'rejected [redacted]' });
    await processEmail(makeSession(['abc123@test.example.com']), makeStream(makeMessage())).catch(() => undefined);
    expect(allLogText()).not.toContain('owner@private.example');
  });
});

// ---------------------------------------------------------------------------
// TLS credentials
// ---------------------------------------------------------------------------

describe('TLS credentials', () => {
  let dir: string;
  let keyPath: string;
  let certPath: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smtp-tls-'));
    keyPath = path.join(dir, 'key.pem');
    certPath = path.join(dir, 'cert.pem');
    execSync(
      `openssl req -x509 -newkey rsa:2048 -nodes -keyout ${keyPath} -out ${certPath} -days 1 -subj /CN=localhost`,
      { stdio: 'ignore' }
    );
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.SMTP_TLS_KEY_PATH;
    delete process.env.SMTP_TLS_CERT_PATH;
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns null when env vars are unset', () => {
    delete process.env.SMTP_TLS_KEY_PATH;
    delete process.env.SMTP_TLS_CERT_PATH;
    expect(loadTlsCredentials()).toBeNull();
  });

  it('returns null and warns (without throwing) when files are missing', () => {
    process.env.SMTP_TLS_KEY_PATH = path.join(dir, 'nope.key');
    process.env.SMTP_TLS_CERT_PATH = path.join(dir, 'nope.crt');
    expect(loadTlsCredentials()).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('returns null when the files are not a valid key/cert pair', () => {
    const junk = path.join(dir, 'junk.pem');
    fs.writeFileSync(junk, 'not a pem');
    process.env.SMTP_TLS_KEY_PATH = junk;
    process.env.SMTP_TLS_CERT_PATH = junk;
    expect(loadTlsCredentials()).toBeNull();
  });

  it('loads a valid key/cert pair', () => {
    process.env.SMTP_TLS_KEY_PATH = keyPath;
    process.env.SMTP_TLS_CERT_PATH = certPath;
    const creds = loadTlsCredentials();
    expect(creds).not.toBeNull();
    expect(creds!.key.equals(fs.readFileSync(keyPath))).toBe(true);
    expect(creds!.cert.equals(fs.readFileSync(certPath))).toBe(true);
  });

  it('updates the secure context only when the files change', () => {
    process.env.SMTP_TLS_KEY_PATH = keyPath;
    process.env.SMTP_TLS_CERT_PATH = certPath;
    const server = { updateSecureContext: jest.fn() };
    const initial = loadTlsCredentials();

    const same = refreshTlsCredentials(server as any, initial);
    expect(server.updateSecureContext).not.toHaveBeenCalled();
    expect(same).toBe(initial);

    // Rotate the cert
    execSync(
      `openssl req -x509 -newkey rsa:2048 -nodes -keyout ${keyPath} -out ${certPath} -days 1 -subj /CN=localhost`,
      { stdio: 'ignore' }
    );
    const updated = refreshTlsCredentials(server as any, initial);
    expect(server.updateSecureContext).toHaveBeenCalledTimes(1);
    expect(updated).not.toBe(initial);
  });

  it('keeps the current context and does not throw when reload fails', () => {
    process.env.SMTP_TLS_KEY_PATH = path.join(dir, 'gone.key');
    process.env.SMTP_TLS_CERT_PATH = path.join(dir, 'gone.crt');
    const server = { updateSecureContext: jest.fn() };
    const current = { key: Buffer.from('k'), cert: Buffer.from('c') };
    expect(refreshTlsCredentials(server as any, current)).toBe(current);
    expect(server.updateSecureContext).not.toHaveBeenCalled();
  });
});
