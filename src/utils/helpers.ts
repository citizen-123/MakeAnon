import { customAlphabet } from 'nanoid';
import crypto from 'crypto';

// Create a nanoid generator with lowercase letters and numbers (no confusing chars)
const alphabet = 'abcdefghijkmnopqrstuvwxyz23456789';

/**
 * Generate a unique alias string
 */
export function generateAlias(length?: number): string {
  const aliasLength = length || parseInt(process.env.ALIAS_LENGTH || '8');
  const generateId = customAlphabet(alphabet, aliasLength);
  return generateId();
}

/**
 * Generate a secure random token
 */
export function generateSecureToken(length = 32): string {
  return crypto.randomBytes(length).toString('hex');
}

/**
 * Generate a management token for public aliases
 */
export function generateManagementToken(): string {
  return generateSecureToken(24);
}

/**
 * Generate a reply prefix for alias replies
 */
export function generateReplyPrefix(): string {
  const prefix = customAlphabet(alphabet, 20);
  return `r${prefix()}`;
}

/**
 * Hash a string using SHA256
 */
export function hashString(str: string): string {
  return crypto.createHash('sha256').update(str).digest('hex');
}

/**
 * Get configured email domains
 */
export function getEmailDomains(): string[] {
  const domains = process.env.EMAIL_DOMAINS || 'mask.example.com';
  return domains.split(',').map((d) => d.trim().toLowerCase());
}

/**
 * Get default email domain
 */
export function getDefaultDomain(): string {
  const domains = getEmailDomains();
  return domains[0];
}

/**
 * Check if a domain is valid for aliases
 */
export function isValidAliasDomain(domain: string): boolean {
  const domains = getEmailDomains();
  return domains.includes(domain.toLowerCase());
}

/**
 * Create full email address from alias and domain
 */
export function createFullAliasEmail(alias: string, domain?: string): string {
  const emailDomain = domain || getDefaultDomain();
  return `${alias.toLowerCase()}@${emailDomain}`;
}

/**
 * Extract alias and domain from full email address
 */
export function parseAliasEmail(email: string): { alias: string; domain: string } | null {
  const parts = email.toLowerCase().split('@');
  if (parts.length !== 2) return null;

  const [alias, domain] = parts;
  if (!isValidAliasDomain(domain)) return null;

  return { alias, domain };
}

/**
 * Check if email matches a reply address pattern
 */
export function isReplyAddress(email: string): boolean {
  const parsed = parseAliasEmail(email);
  if (!parsed) return false;
  return parsed.alias.startsWith('r') && parsed.alias.length === 21;
}

/**
 * Validate email format
 */
export function isValidEmail(email: unknown): email is string {
  if (typeof email !== 'string' || email.length > 254) return false;
  // Reject whitespace (incl. CR/LF), control chars, angle brackets, quotes and commas
  // so the value can never smuggle extra recipients or headers.
  const emailRegex = /^[^\s@<>",\x00-\x1f\x7f]+@[^\s@<>",\x00-\x1f\x7f]+\.[^\s@<>",\x00-\x1f\x7f]+$/;
  return emailRegex.test(email);
}

/**
 * Local parts that must never be claimable as custom aliases
 * (role accounts, RFC 2142 mailboxes, CA validation addresses, etc.)
 */
export const RESERVED_LOCAL_PARTS: ReadonlySet<string> = new Set([
  'admin',
  'administrator',
  'hostmaster',
  'webmaster',
  'postmaster',
  'abuse',
  'security',
  'root',
  'noreply',
  'no-reply',
  'support',
  'info',
  'mailer-daemon',
  'ssl-admin',
  'ssladmin',
  'ssl',
  'www',
  'ftp',
  'usenet',
  'news',
  'uucp',
  'marketing',
  'sales',
  'billing',
  'privacy',
  'legal',
  'contact',
  'help',
]);

/**
 * Check whether a local part is reserved (case-insensitive, exact match)
 */
export function isReservedLocalPart(localPart: string): boolean {
  return RESERVED_LOCAL_PARTS.has(localPart.toLowerCase());
}

/**
 * Validate custom alias format
 */
export function isValidCustomAlias(alias: unknown): alias is string {
  if (typeof alias !== 'string') return false;
  const minLength = parseInt(process.env.MIN_CUSTOM_ALIAS_LENGTH || '4');
  const maxLength = 32;

  // Must be alphanumeric with optional hyphens/underscores, no consecutive special chars
  const aliasRegex = /^[a-z0-9]+([._-][a-z0-9]+)*$/i;

  return (
    alias.length >= minLength &&
    alias.length <= maxLength &&
    aliasRegex.test(alias) &&
    !alias.toLowerCase().startsWith('r') && // Reserved for reply addresses
    !isReservedLocalPart(alias)
  );
}

/**
 * Sanitize string for safe logging
 */
export function sanitizeForLog(str: string, maxLength = 100): string {
  return str.substring(0, maxLength).replace(/[\n\r]/g, ' ');
}

/**
 * Parse email address to extract name and email
 */
export function parseEmailAddress(address: string): { name: string | null; email: string } {
  // Handle formats like "John Doe <john@example.com>" or just "john@example.com"
  const match = address.match(/^(?:"?([^"]*)"?\s)?<?([^>]+@[^>]+)>?$/);
  if (match) {
    return {
      name: match[1]?.trim() || null,
      email: match[2].trim().toLowerCase(),
    };
  }
  return { name: null, email: address.trim().toLowerCase() };
}

/**
 * Get base URL for links
 */
export function getBaseUrl(): string {
  return process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
}

/**
 * Create management URL for an alias
 */
export function createManagementUrl(managementToken: string): string {
  // Token goes in the URL fragment so it is never sent to the server (and never
  // lands in access logs); the SPA reads #manage?token=...
  return `${getBaseUrl()}/#manage?token=${encodeURIComponent(managementToken)}`;
}

/**
 * Create verification URL
 */
export function createVerificationUrl(token: string): string {
  return `${getBaseUrl()}/api/v1/verify/${token}`;
}

/**
 * Calculate expiration date
 */
export function calculateExpiresAt(days: number): Date {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date;
}

export const MIN_EXPIRES_IN_DAYS = 1;
export const MAX_EXPIRES_IN_DAYS = 365;

/**
 * Validate an expiresIn value (days). Accepts undefined/null (no expiry) or an
 * integer number of days within [MIN_EXPIRES_IN_DAYS, MAX_EXPIRES_IN_DAYS].
 */
export function parseExpiresInDays(
  value: unknown
): { valid: true; days: number | null } | { valid: false } {
  if (value === undefined || value === null) return { valid: true, days: null };
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < MIN_EXPIRES_IN_DAYS ||
    value > MAX_EXPIRES_IN_DAYS
  ) {
    return { valid: false };
  }
  return { valid: true, days: value };
}

/**
 * Validate an optional free-text field. undefined = not provided; null/'' clears it.
 * Returns an error message if invalid.
 */
export function validateOptionalText(
  value: unknown,
  field: string,
  maxLength: number
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return `${field} must be a string`;
  if (value.length > maxLength) return `${field} must be at most ${maxLength} characters`;
  return null;
}

export const MAX_LABEL_LENGTH = 100;
export const MAX_DESCRIPTION_LENGTH = 500;
export const MAX_REASON_LENGTH = 200;

/**
 * Parse page/limit query params, clamping to sane bounds with NaN fallback
 */
export function parsePagination(
  pageRaw: unknown,
  limitRaw: unknown,
  defaultLimit = 20,
  maxLimit = 100
): { page: number; limit: number; skip: number } {
  let page = parseInt(String(pageRaw ?? ''), 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  page = Math.min(page, 100000);
  let limit = parseInt(String(limitRaw ?? ''), 10);
  if (!Number.isFinite(limit)) limit = defaultLimit;
  limit = Math.min(Math.max(limit, 1), maxLimit);
  return { page, limit, skip: (page - 1) * limit };
}

/**
 * Check if a date is expired
 */
export function isExpired(date: Date | null): boolean {
  if (!date) return false;
  return new Date() > new Date(date);
}

/**
 * Format date for display
 */
export function formatDate(date: Date): string {
  return new Date(date).toISOString();
}

/**
 * Sleep for a specified number of milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry a function with exponential backoff
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelayMs = 1000
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      if (attempt < maxRetries - 1) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        await sleep(delay);
      }
    }
  }

  throw lastError;
}

// List of known disposable email domains
const DISPOSABLE_DOMAINS = new Set([
  'tempmail.com',
  'throwaway.email',
  'guerrillamail.com',
  'mailinator.com',
  '10minutemail.com',
  'temp-mail.org',
  'fakeinbox.com',
  // Add more as needed
]);

/**
 * Check if email is from a disposable domain
 */
export function isDisposableEmail(email: string): boolean {
  const domain = email.split('@')[1]?.toLowerCase();
  return domain ? DISPOSABLE_DOMAINS.has(domain) : false;
}
