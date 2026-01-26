/**
 * PeerVault Error Base Class
 *
 * All PeerVault errors extend this class for consistent handling.
 * Based on spec/09-error-handling.md
 */

import { ErrorSeverity, ErrorCategory, type ErrorContext } from "./types";

/**
 * Base error class for all PeerVault errors.
 *
 * Provides structured error information including:
 * - Unique error code for programmatic handling
 * - Category for routing to appropriate handler
 * - Severity for user notification decisions
 * - Recoverability flag for retry logic
 * - Context for debugging
 */
export class PeerVaultError extends Error {
  override readonly name = "PeerVaultError";

  constructor(
    message: string,
    public readonly code: string,
    public readonly category: ErrorCategory,
    public readonly severity: ErrorSeverity,
    public readonly recoverable: boolean,
    public readonly context?: ErrorContext,
    public override readonly cause?: Error,
  ) {
    super(message);

    // Maintains proper stack trace for where error was thrown
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, PeerVaultError);
    }

    // Include cause in stack if available
    if (cause?.stack) {
      this.stack = `${this.stack}\nCaused by: ${cause.stack}`;
    }
  }

  /**
   * Serialize error for logging or transmission.
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      category: this.category,
      severity: this.severity,
      recoverable: this.recoverable,
      context: this.context,
      stack: this.stack,
    };
  }

  /**
   * Create a string representation for logging.
   */
  override toString(): string {
    const parts = [`[${this.code}] ${this.message}`];
    if (this.context) {
      parts.push(`Context: ${JSON.stringify(this.context)}`);
    }
    return parts.join(" | ");
  }

  /**
   * Check if this error is of a specific category.
   */
  isCategory(category: ErrorCategory): boolean {
    return this.category === category;
  }

  /**
   * Check if this error should trigger user notification.
   */
  shouldNotifyUser(): boolean {
    return (
      this.severity === ErrorSeverity.ERROR ||
      this.severity === ErrorSeverity.CRITICAL
    );
  }

  /**
   * Wrap an unknown error as a PeerVaultError.
   */
  static wrap(
    error: unknown,
    code: string,
    category: ErrorCategory,
    context?: ErrorContext,
  ): PeerVaultError {
    if (error instanceof PeerVaultError) {
      return error;
    }

    const cause = error instanceof Error ? error : undefined;
    const message =
      error instanceof Error ? error.message : String(error);

    return new PeerVaultError(
      message,
      code,
      category,
      ErrorSeverity.ERROR,
      false,
      context,
      cause,
    );
  }

  /**
   * Check if an error is a PeerVaultError.
   */
  static isPeerVaultError(error: unknown): error is PeerVaultError {
    return error instanceof PeerVaultError;
  }
}
