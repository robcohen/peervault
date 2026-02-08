/**
 * Validation Tests
 *
 * Tests for input validation and sanitization functions.
 */

import { describe, it, expect } from "bun:test";
import {
  INPUT_LIMITS,
  sanitizeString,
  validateGroupName,
  validateNickname,
  validateFolderPath,
  validateRelayUrl,
  validateTicket,
} from "../src/utils/validation";

// ============================================================================
// sanitizeString Tests
// ============================================================================

describe("sanitizeString", () => {
  it("should trim whitespace", () => {
    expect(sanitizeString("  hello  ", 100)).toBe("hello");
  });

  it("should limit length", () => {
    expect(sanitizeString("hello world", 5)).toBe("hello");
  });

  it("should remove control characters", () => {
    expect(sanitizeString("hello\x00world", 100)).toBe("helloworld");
    expect(sanitizeString("test\x1Fvalue", 100)).toBe("testvalue");
    expect(sanitizeString("\x7Fdata", 100)).toBe("data");
  });

  it("should preserve newlines and tabs", () => {
    // The regex excludes \n (0x0A) and \t (0x09)
    const input = "line1\nline2";
    const result = sanitizeString(input, 100);
    expect(result).toContain("\n");
  });

  it("should handle empty string", () => {
    expect(sanitizeString("", 100)).toBe("");
  });

  it("should handle string with only whitespace", () => {
    expect(sanitizeString("   ", 100)).toBe("");
  });

  it("should handle unicode characters", () => {
    expect(sanitizeString("héllo wörld 🎉", 100)).toBe("héllo wörld 🎉");
  });
});

// ============================================================================
// validateGroupName Tests
// ============================================================================

describe("validateGroupName", () => {
  it("should accept valid group names", () => {
    const result = validateGroupName("Work");
    expect(result.valid).toBe(true);
    expect(result.value).toBe("Work");
    expect(result.error).toBeUndefined();
  });

  it("should reject empty names", () => {
    const result = validateGroupName("");
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Group name cannot be empty");
  });

  it("should reject single character names", () => {
    const result = validateGroupName("A");
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Group name must be at least 2 characters");
  });

  it("should accept two character names", () => {
    const result = validateGroupName("AB");
    expect(result.valid).toBe(true);
  });

  it("should trim and sanitize", () => {
    const result = validateGroupName("  My Group  ");
    expect(result.valid).toBe(true);
    expect(result.value).toBe("My Group");
  });

  it("should truncate to max length", () => {
    const longName = "A".repeat(100);
    const result = validateGroupName(longName);
    expect(result.valid).toBe(true);
    expect(result.value.length).toBe(INPUT_LIMITS.groupName);
  });
});

// ============================================================================
// validateNickname Tests
// ============================================================================

describe("validateNickname", () => {
  it("should accept valid nicknames", () => {
    const result = validateNickname("My Laptop");
    expect(result.valid).toBe(true);
    expect(result.value).toBe("My Laptop");
  });

  it("should accept empty nickname (uses auto-generated)", () => {
    const result = validateNickname("");
    expect(result.valid).toBe(true);
    expect(result.value).toBe("");
  });

  it("should reject single character nicknames", () => {
    const result = validateNickname("A");
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Nickname must be at least 2 characters");
  });

  it("should accept two character nicknames", () => {
    const result = validateNickname("AB");
    expect(result.valid).toBe(true);
  });

  it("should truncate to max length", () => {
    const longName = "A".repeat(100);
    const result = validateNickname(longName);
    expect(result.valid).toBe(true);
    expect(result.value.length).toBe(INPUT_LIMITS.nickname);
  });
});

// ============================================================================
// validateFolderPath Tests
// ============================================================================

describe("validateFolderPath", () => {
  it("should accept valid paths", () => {
    const result = validateFolderPath("folder/subfolder");
    expect(result.valid).toBe(true);
    expect(result.value).toBe("folder/subfolder");
  });

  it("should reject empty paths", () => {
    const result = validateFolderPath("");
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Folder path cannot be empty");
  });

  it("should normalize backslashes to forward slashes", () => {
    const result = validateFolderPath("folder\\subfolder");
    expect(result.valid).toBe(true);
    expect(result.value).toBe("folder/subfolder");
  });

  it("should reject path traversal attempts", () => {
    const result = validateFolderPath("folder/../etc");
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Path traversal not allowed");
  });

  it("should reject standalone ..", () => {
    const result = validateFolderPath("..");
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Path traversal not allowed");
  });

  it("should accept paths with dots in filenames", () => {
    const result = validateFolderPath("folder/file.txt");
    expect(result.valid).toBe(true);
  });

  it("should reject relative paths starting with dot-slash", () => {
    const result = validateFolderPath("./folder");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("Relative paths not allowed");
  });

  it("should reject self-reference paths", () => {
    const result1 = validateFolderPath("folder/./subfolder");
    expect(result1.valid).toBe(false);
    expect(result1.error).toContain("self-reference");

    const result2 = validateFolderPath("folder/.");
    expect(result2.valid).toBe(false);
  });

  it("should reject double slashes", () => {
    const result = validateFolderPath("folder//subfolder");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("double slashes");
  });

  it("should truncate long paths", () => {
    const longPath = "a/".repeat(300);
    const result = validateFolderPath(longPath);
    expect(result.valid).toBe(true);
    expect(result.value.length).toBeLessThanOrEqual(INPUT_LIMITS.folderPath);
  });
});

// ============================================================================
// validateRelayUrl Tests
// ============================================================================

describe("validateRelayUrl", () => {
  it("should accept valid https URLs", () => {
    const result = validateRelayUrl("https://relay.example.com");
    expect(result.valid).toBe(true);
    expect(result.value).toBe("https://relay.example.com");
  });

  it("should accept valid http URLs", () => {
    const result = validateRelayUrl("http://localhost:3000");
    expect(result.valid).toBe(true);
  });

  it("should accept empty URL (uses default)", () => {
    const result = validateRelayUrl("");
    expect(result.valid).toBe(true);
    expect(result.value).toBe("");
  });

  it("should reject non-http/https URLs", () => {
    const result = validateRelayUrl("ftp://example.com");
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Relay URL must use http or https");
  });

  it("should reject invalid URL format", () => {
    const result = validateRelayUrl("not a url");
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Invalid URL format");
  });

  it("should reject URLs with just protocol", () => {
    const result = validateRelayUrl("https://");
    expect(result.valid).toBe(false);
  });

  it("should trim whitespace", () => {
    const result = validateRelayUrl("  https://example.com  ");
    expect(result.valid).toBe(true);
    expect(result.value).toBe("https://example.com");
  });
});

// ============================================================================
// validateTicket Tests
// ============================================================================

describe("validateTicket", () => {
  // Base32 format tests
  it("should accept valid base32 tickets", () => {
    const ticket = "endpoint1" + "a".repeat(100);
    const result = validateTicket(ticket);
    expect(result.valid).toBe(true);
    expect(result.value).toBe(ticket);
  });

  it("should reject base32 tickets with invalid characters", () => {
    const ticket = "endpoint1ABC123"; // uppercase not allowed
    const result = validateTicket(ticket);
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Invalid base32 ticket format");
  });

  it("should reject truncated base32 tickets", () => {
    const result = validateTicket("endpoint1short");
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Ticket appears to be truncated");
  });

  // JSON format tests
  it("should accept valid JSON tickets", () => {
    const ticket = JSON.stringify({ id: "abc123", addrs: [{ Relay: "https://example.com" }] });
    const result = validateTicket(ticket);
    expect(result.valid).toBe(true);
    expect(result.value).toBe(ticket);
  });

  it("should reject JSON tickets missing id", () => {
    const ticket = JSON.stringify({ addrs: [] });
    const result = validateTicket(ticket);
    expect(result.valid).toBe(false);
    expect(result.error).toBe("JSON ticket missing 'id' field");
  });

  it("should reject JSON tickets missing addrs", () => {
    const ticket = JSON.stringify({ id: "abc123" });
    const result = validateTicket(ticket);
    expect(result.valid).toBe(false);
    expect(result.error).toBe("JSON ticket missing 'addrs' array");
  });

  it("should reject invalid JSON", () => {
    const result = validateTicket("{invalid json");
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Invalid JSON format");
  });

  // General tests
  it("should reject empty tickets", () => {
    const result = validateTicket("");
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Ticket cannot be empty");
  });

  it("should reject unrecognized formats", () => {
    const result = validateTicket("abc123");
    expect(result.valid).toBe(false);
    expect(result.error).toBe("Unrecognized ticket format (expected base32 or JSON)");
  });

  it("should trim whitespace", () => {
    const ticket = "endpoint1" + "a".repeat(100);
    const result = validateTicket("  " + ticket + "  ");
    expect(result.valid).toBe(true);
    expect(result.value).toBe(ticket);
  });

  it("should accept base32 ticket at minimum valid length", () => {
    const ticket = "endpoint1" + "a".repeat(41); // 9 + 41 = 50 chars total
    const result = validateTicket(ticket);
    expect(result.valid).toBe(true);
  });
});

// ============================================================================
// INPUT_LIMITS Tests
// ============================================================================

describe("INPUT_LIMITS", () => {
  it("should have expected limits", () => {
    expect(INPUT_LIMITS.groupName).toBe(50);
    expect(INPUT_LIMITS.nickname).toBe(30);
    expect(INPUT_LIMITS.folderPath).toBe(500);
    expect(INPUT_LIMITS.relayUrl).toBe(200);
  });
});
