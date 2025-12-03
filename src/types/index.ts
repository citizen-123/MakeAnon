import { Request } from 'express';

// ============================================================================
// Request Types
// ============================================================================

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
    isAdmin: boolean;
  };
  apiKey?: {
    id: string;
    userId: string;
    scopes: string[];
  };
}

export interface JwtPayload {
  id: string;
  email: string;
  isAdmin: boolean;
  iat?: number;
  exp?: number;
}

// ============================================================================
// Alias Types
// ============================================================================

export interface CreatePublicAliasInput {
  destinationEmail: string;
  domainId?: string;
  customAlias?: string;
  label?: string;
  description?: string;
  expiresIn?: number; // Days until expiration
}

export interface CreatePrivateAliasInput extends CreatePublicAliasInput {
  isPrivate: true;
}

export interface UpdateAliasInput {
  label?: string;
  description?: string;
  isActive?: boolean;
  replyEnabled?: boolean;
  expiresAt?: Date | null;
}

export interface AliasResponse {
  id: string;
  alias: string;
  fullAddress: string;
  domain: {
    id: string;
    domain: string;
  };
  destinationEmail: string;
  emailVerified: boolean;
  label: string | null;
  description: string | null;
  isActive: boolean;
  isPrivate: boolean;
  forwardCount: number;
  lastForwardAt: Date | null;
  replyEnabled: boolean;
  createdAt: Date;
  expiresAt: Date | null;
  managementUrl?: string;
}

// ============================================================================
// Domain Types
// ============================================================================

export interface DomainInfo {
  id: string;
  domain: string;
  description: string | null;
  isDefault: boolean;
  aliasCount: number;
}

export interface CreateDomainInput {
  domain: string;
  description?: string;
  isDefault?: boolean;
  isPublic?: boolean;
}

// ============================================================================
// Email Types
// ============================================================================

export interface EmailMessage {
  from: string;
  to: string[];
  subject?: string;
  text?: string;
  html?: string;
  headers?: Record<string, string>;
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  attachments?: EmailAttachment[];
}

export interface EmailAttachment {
  filename: string;
  contentType: string;
  size: number;
  content: Buffer;
}

export interface ForwardResult {
  success: boolean;
  messageId?: string;
  error?: string;
  processingTime?: number;
}

// ============================================================================
// Verification Types
// ============================================================================

export interface VerificationResult {
  success: boolean;
  message: string;
  alias?: AliasResponse;
}

export interface SendVerificationResult {
  success: boolean;
  message: string;
  expiresAt?: Date;
}

// ============================================================================
// User Types
// ============================================================================

export interface UserProfile {
  id: string;
  email: string;
  name: string | null;
  isAdmin: boolean;
  emailVerified: boolean;
  maxAliases: number;
  aliasCount: number;
  createdAt: Date;
}

export interface CreateAccountInput {
  email: string;
  password: string;
  name?: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

// ============================================================================
// API Response Types
// ============================================================================

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  message?: string;
  error?: string;
  details?: ValidationError[];
}

export interface ValidationError {
  field: string;
  message: string;
}

export interface PaginatedResponse<T> {
  items: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
}

export interface PaginationParams {
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

// ============================================================================
// Statistics Types
// ============================================================================

export interface GlobalStats {
  totalAliases: number;
  activeAliases: number;
  totalForwarded: number;
  totalBlocked: number;
  totalUsers: number;
  domainsCount: number;
}

export interface UserStats {
  totalAliases: number;
  activeAliases: number;
  totalForwarded: number;
  maxAliases: number;
  recentActivity: RecentActivity[];
}

export interface RecentActivity {
  aliasId: string;
  alias: string;
  fullAddress: string;
  label: string | null;
  lastForwardAt: Date | null;
  forwardCount: number;
}

// ============================================================================
// Webhook Types
// ============================================================================

export type WebhookEvent =
  | 'alias.created'
  | 'alias.deleted'
  | 'alias.updated'
  | 'email.received'
  | 'email.forwarded'
  | 'email.blocked'
  | 'email.failed';

export interface WebhookPayload {
  event: WebhookEvent;
  timestamp: string;
  data: Record<string, unknown>;
}

export interface CreateWebhookInput {
  url: string;
  events: WebhookEvent[];
}

// ============================================================================
// Rate Limiting Types
// ============================================================================

export interface RateLimitInfo {
  key: string;
  limit: number;
  remaining: number;
  resetAt: Date;
}

// ============================================================================
// Admin Types
// ============================================================================

export interface AdminStats extends GlobalStats {
  emailsToday: number;
  emailsThisWeek: number;
  newUsersToday: number;
  newAliasesToday: number;
  topDomains: { domain: string; count: number }[];
}

export interface SystemHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  database: boolean;
  redis: boolean;
  smtp: boolean;
  uptime: number;
  version: string;
}
