/**
 * Input Validation Utilities
 *
 * Functions for sanitizing and validating user inputs.
 */

/**
 * Maximum lengths for user inputs.
 */
export const INPUT_LIMITS = {
  groupName: 50,
  nickname: 30,
  folderPath: 500,
  relayUrl: 200,
} as const;

/**
 * Sanitize a string by removing control characters and trimming.
 */
export function sanitizeString(input: string, maxLength: number): string {
  // Remove control characters (except newlines/tabs for text areas)
  // eslint-disable-next-line no-control-regex
  const cleaned = input.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
  // Trim and limit length
  return cleaned.trim().slice(0, maxLength);
}

/**
 * Validate and sanitize a group name.
 */
export function validateGroupName(name: string): { valid: boolean; value: string; error?: string } {
  const sanitized = sanitizeString(name, INPUT_LIMITS.groupName);

  if (sanitized.length === 0) {
    return { valid: false, value: "", error: "Group name cannot be empty" };
  }

  if (sanitized.length < 2) {
    return { valid: false, value: sanitized, error: "Group name must be at least 2 characters" };
  }

  return { valid: true, value: sanitized };
}

/**
 * Validate and sanitize a device nickname.
 */
export function validateNickname(name: string): { valid: boolean; value: string; error?: string } {
  const sanitized = sanitizeString(name, INPUT_LIMITS.nickname);

  // Empty is valid (means use auto-generated name)
  if (sanitized.length === 0) {
    return { valid: true, value: "" };
  }

  if (sanitized.length < 2) {
    return { valid: false, value: sanitized, error: "Nickname must be at least 2 characters" };
  }

  return { valid: true, value: sanitized };
}

/**
 * Validate a folder path.
 */
export function validateFolderPath(path: string): { valid: boolean; value: string; error?: string } {
  const sanitized = sanitizeString(path, INPUT_LIMITS.folderPath);

  if (sanitized.length === 0) {
    return { valid: false, value: "", error: "Folder path cannot be empty" };
  }

  // Normalize path separators
  const normalized = sanitized.replace(/\\/g, "/");

  // Check for path traversal attempts
  if (normalized.includes("..")) {
    return { valid: false, value: normalized, error: "Path traversal not allowed" };
  }

  return { valid: true, value: normalized };
}

/**
 * Validate a relay URL.
 */
export function validateRelayUrl(url: string): { valid: boolean; value: string; error?: string } {
  const sanitized = sanitizeString(url, INPUT_LIMITS.relayUrl);

  if (sanitized.length === 0) {
    return { valid: true, value: "" }; // Empty is valid (use default)
  }

  try {
    const parsed = new URL(sanitized);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return { valid: false, value: sanitized, error: "Relay URL must use http or https" };
    }
    return { valid: true, value: sanitized };
  } catch {
    return { valid: false, value: sanitized, error: "Invalid URL format" };
  }
}

/**
 * Validate an Iroh connection ticket.
 */
export function validateTicket(ticket: string): { valid: boolean; value: string; error?: string } {
  const trimmed = ticket.trim();

  if (trimmed.length === 0) {
    return { valid: false, value: "", error: "Ticket cannot be empty" };
  }

  if (!trimmed.startsWith("iroh://")) {
    return { valid: false, value: trimmed, error: "Ticket must start with iroh://" };
  }

  // Basic length check (tickets are typically 100+ characters)
  if (trimmed.length < 50) {
    return { valid: false, value: trimmed, error: "Ticket appears to be truncated" };
  }

  return { valid: true, value: trimmed };
}
