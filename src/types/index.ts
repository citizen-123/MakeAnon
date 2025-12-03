import { Request } from 'express';

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    email: string;
  };
}

export interface JwtPayload {
  id: string;
  email: string;
  iat?: number;
  exp?: number;
}

export interface CreateAliasInput {
  label?: string;
  description?: string;
}

export interface UpdateAliasInput {
  label?: string;
  description?: string;
  isActive?: boolean;
}

export interface EmailMessage {
  from: string;
  to: string[];
  subject: string;
  text?: string;
  html?: string;
  headers?: Record<string, string>;
}

export interface ForwardResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  message?: string;
  error?: string;
}

export interface PaginationParams {
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface AliasStats {
  totalAliases: number;
  activeAliases: number;
  totalForwarded: number;
  recentActivity: {
    aliasId: string;
    alias: string;
    lastForwardAt: Date | null;
  }[];
}
