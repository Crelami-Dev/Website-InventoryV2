/**
 * DocuFlow Inventory Multi-Owner V2.4.1
 * Standardized Error Contracts & Safe Error Handling
 */

import type { ReturnErrorCode } from '../types/inventory-domain.ts';

export type AppErrorCode =
  | 'ERR_UNAUTHORIZED'
  | 'ERR_FORBIDDEN_OWNER'
  | 'ERR_FORBIDDEN_WAREHOUSE'
  | 'ERR_FORBIDDEN_ROLE'
  | 'ERR_FORBIDDEN_SUPERADMIN_NO_GRANT'
  | 'ERR_VALIDATION'
  | 'ERR_NOT_FOUND'
  | 'ERR_CONFLICT'
  | 'ERR_CONFLICT_SN'
  | 'ERR_IDEMPOTENCY_REPLAY'
  | 'UNIT_MISMATCH'
  | 'ERR_INTERNAL_SERVER'
  | ReturnErrorCode;

export interface SafeErrorResponse {
  success: false;
  error: {
    code: AppErrorCode;
    message: string;
    correlationId: string;
    details?: Record<string, unknown>;
  };
}

export class AppError extends Error {
  public readonly code: AppErrorCode;
  public readonly statusCode: number;
  public readonly correlationId: string;
  public readonly details?: Record<string, unknown>;

  constructor(
    code: AppErrorCode,
    message: string,
    statusCode = 400,
    details?: Record<string, unknown>,
    correlationId?: string
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    this.correlationId = correlationId || `err_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    Object.setPrototypeOf(this, AppError.prototype);
  }

  public toSafeResponse(): SafeErrorResponse {
    return {
      success: false,
      error: {
        code: this.code,
        message: this.message,
        correlationId: this.correlationId,
        ...(this.details ? { details: this.details } : {})
      }
    };
  }
}

export function createUnauthorizedError(message = 'Sesi tidak valid atau telah kedaluwarsa'): AppError {
  return new AppError('ERR_UNAUTHORIZED', message, 401);
}

export function createForbiddenOwnerError(message = 'Akses ditolak: Anda bukan anggota sah dari Owner ini'): AppError {
  return new AppError('ERR_FORBIDDEN_OWNER', message, 403);
}

export function createForbiddenWarehouseError(message = 'Akses ditolak: Gudang berada di luar penugasan aktif Anda'): AppError {
  return new AppError('ERR_FORBIDDEN_WAREHOUSE', message, 403);
}

export function createForbiddenSuperAdminError(message = 'Akses ditolak: Super Admin memerlukan grant operasional aktif yang disetujui Owner'): AppError {
  return new AppError('ERR_FORBIDDEN_SUPERADMIN_NO_GRANT', message, 403);
}

export function createValidationError(message: string, details?: Record<string, unknown>): AppError {
  return new AppError('ERR_VALIDATION', message, 400, details);
}
