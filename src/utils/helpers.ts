import { customAlphabet } from 'nanoid';

// Create a nanoid generator with lowercase letters and numbers (no confusing chars)
const alphabet = 'abcdefghijkmnopqrstuvwxyz23456789';
const generateId = customAlphabet(alphabet, parseInt(process.env.ALIAS_LENGTH || '8'));

/**
 * Generate a unique alias string
 */
export function generateAlias(): string {
  return generateId();
}

/**
 * Create full email address from alias
 */
export function createFullAliasEmail(alias: string): string {
  const domain = process.env.EMAIL_DOMAIN || 'mask.example.com';
  return `${alias}@${domain}`;
}

/**
 * Extract alias from full email address
 */
export function extractAliasFromEmail(email: string): string | null {
  const domain = process.env.EMAIL_DOMAIN || 'mask.example.com';
  const regex = new RegExp(`^([^@]+)@${domain.replace('.', '\\.')}$`, 'i');
  const match = email.match(regex);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Validate email format
 */
export function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
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
