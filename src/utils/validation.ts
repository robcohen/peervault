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
  let normalized = sanitized.replace(/\\/g, "/");

  // Remove leading/trailing slashes for consistency
  normalized = normalized.replace(/^\/+|\/+$/g, "");

  // Check for path traversal attempts
  if (normalized.includes("..")) {
    return { valid: false, value: normalized, error: "Path traversal not allowed" };
  }

  // Check for relative path indicators
  if (normalized.startsWith("./") || normalized === ".") {
    return { valid: false, value: normalized, error: "Relative paths not allowed" };
  }

  // Check for self-references in path (e.g., /foo/./bar)
  if (normalized.includes("/./") || normalized.endsWith("/.")) {
    return { valid: false, value: normalized, error: "Path contains invalid self-reference" };
  }

  // Check for double slashes (could indicate path manipulation)
  if (normalized.includes("//")) {
    return { valid: false, value: normalized, error: "Path contains invalid double slashes" };
  }

  // Check for null bytes (can bypass checks in some systems)
  if (normalized.includes("\0")) {
    return { valid: false, value: normalized, error: "Path contains invalid characters" };
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

/**
 * Check if a path matches or is inside an excluded folder.
 * Used for selective sync exclusion logic.
 *
 * @param path - The path to check
 * @param excludedFolder - The excluded folder path
 * @returns true if the path should be excluded
 */
export function isPathExcluded(path: string, excludedFolder: string): boolean {
  return path === excludedFolder || path.startsWith(excludedFolder + "/");
}

/**
 * Check if a path matches any of the excluded folders.
 *
 * @param path - The path to check
 * @param excludedFolders - Array of excluded folder paths
 * @returns true if the path should be excluded
 */
export function isPathInExcludedFolders(path: string, excludedFolders: string[]): boolean {
  for (const excluded of excludedFolders) {
    if (isPathExcluded(path, excluded)) {
      return true;
    }
  }
  return false;
}

/**
 * Map of technical error patterns to user-friendly messages.
 */
const ERROR_MESSAGES: Record<string, string> = {
  "network error": "Network connection failed. Check your internet connection.",
  "connection refused": "Could not connect to peer. They may be offline.",
  "timeout": "Connection timed out. The peer may be unreachable.",
  "ENOTFOUND": "Could not find the server. Check your network connection.",
  "ECONNREFUSED": "Connection refused. The peer may be offline.",
  "ETIMEDOUT": "Connection timed out. Try again later.",
  "certificate": "Security certificate error. Check your network settings.",
  "rate limit": "Too many requests. Please wait a moment and try again.",
  "invalid ticket": "Invalid pairing code. Please check and try again.",
  "already paired": "This device is already paired.",
  "not found": "The requested item could not be found.",
  "permission denied": "Permission denied. Check your access rights.",
  "disk full": "Storage is full. Free up some space and try again.",
  "file too large": "File is too large to sync.",
};

/**
 * Format an error for user-friendly display.
 * Converts technical error messages to plain language.
 *
 * @param error - The error to format (can be Error, string, or unknown)
 * @returns A user-friendly error message
 */
export function formatUserError(error: unknown): string {
  // Extract the error message
  let message: string;
  if (error instanceof Error) {
    message = error.message;
  } else if (typeof error === "string") {
    message = error;
  } else {
    message = "An unexpected error occurred";
  }

  // Check for known error patterns
  const lowerMessage = message.toLowerCase();
  for (const [pattern, friendlyMsg] of Object.entries(ERROR_MESSAGES)) {
    if (lowerMessage.includes(pattern.toLowerCase())) {
      return friendlyMsg;
    }
  }

  // If the message is very long (like a stack trace), truncate it
  if (message.length > 100) {
    // Try to extract just the first meaningful line
    const firstLine = (message.split("\n")[0] ?? "").trim();
    if (firstLine.length > 100) {
      return "An error occurred. Check the console for details.";
    }
    return firstLine;
  }

  return message;
}
