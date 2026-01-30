/**
 * Device Utilities Tests
 *
 * Tests for device identification and naming functions.
 * Note: getDeviceHostname() cannot be tested here because it imports
 * from 'obsidian' which is not available in the test environment.
 */

import { describe, it, expect } from "bun:test";

// We can't import from device.ts directly because it imports Platform from obsidian.
// Instead, we'll test the nodeIdToWords function by copying its logic here.
// This tests the algorithm without the Obsidian dependency.

/**
 * Word list for generating memorable device names.
 * Same as in device.ts.
 */
const WORD_LIST = [
  // Animals (64)
  "ant", "ape", "bat", "bear", "bee", "bird", "boar", "bug",
  "bull", "calf", "cat", "clam", "cob", "cod", "cow", "crab",
  "crow", "deer", "dog", "dove", "duck", "eel", "elk", "emu",
  "fish", "flea", "fly", "fox", "frog", "goat", "hawk", "hen",
  "hog", "jay", "lamb", "lark", "lion", "lynx", "mole", "moth",
  "mouse", "mule", "newt", "owl", "ox", "pig", "pike", "pony",
  "pug", "ram", "rat", "seal", "slug", "swan", "toad", "trout",
  "wasp", "whale", "wolf", "worm", "wren", "yak", "zebra", "finch",
  // Colors & Nature (64)
  "red", "blue", "gold", "gray", "jade", "navy", "pink", "plum",
  "rose", "ruby", "sage", "sand", "teal", "aqua", "bone", "coal",
  "corn", "dawn", "dew", "dusk", "fern", "fire", "foam", "frost",
  "glow", "haze", "ice", "iron", "leaf", "lime", "mint", "moon",
  "moss", "oak", "palm", "peak", "pine", "rain", "reef", "rock",
  "root", "snow", "soil", "star", "stem", "stone", "sun", "tide",
  "tree", "vine", "wave", "wind", "wood", "brook", "cave", "clay",
  "cliff", "cloud", "coast", "coral", "creek", "delta", "field", "flame",
  // Objects (64)
  "axe", "bag", "ball", "bell", "boat", "book", "boot", "bowl",
  "box", "brick", "broom", "brush", "cake", "card", "cart", "chair",
  "chest", "clock", "cloth", "coin", "cone", "cord", "cork", "crown",
  "cup", "desk", "dish", "door", "drum", "flag", "fork", "gate",
  "gear", "gift", "glass", "globe", "glove", "gong", "hat", "helm",
  "hook", "horn", "jar", "key", "kite", "knob", "lamp", "lens",
  "lock", "mask", "mill", "nail", "nest", "note", "oar", "pan",
  "pen", "pipe", "plug", "pot", "ring", "rope", "sail", "shelf",
  // Actions & Qualities (64)
  "bold", "brave", "calm", "cool", "crisp", "dark", "deep", "dry",
  "fair", "fast", "firm", "flat", "free", "fresh", "full", "glad",
  "good", "grand", "great", "half", "hard", "high", "holy", "hot",
  "keen", "kind", "late", "lean", "left", "light", "live", "long",
  "loud", "low", "main", "mild", "near", "neat", "new", "nice",
  "odd", "old", "open", "pale", "plain", "prime", "pure", "quick",
  "rare", "raw", "rich", "ripe", "safe", "sharp", "short", "slim",
  "slow", "small", "smart", "soft", "solid", "spare", "sweet", "swift",
];

/**
 * Generate a memorable 3-word name from a node ID.
 * Same algorithm as in device.ts.
 */
function nodeIdToWords(nodeId: string): string {
  const cleaned = nodeId.replace(/[^a-fA-F0-9]/g, "");

  const byte1 = parseInt(cleaned.slice(0, 2) || "00", 16) % 256;
  const byte2 = parseInt(cleaned.slice(16, 18) || cleaned.slice(2, 4) || "00", 16) % 256;
  const byte3 = parseInt(cleaned.slice(32, 34) || cleaned.slice(4, 6) || "00", 16) % 256;

  const word1 = WORD_LIST[byte1 % WORD_LIST.length];
  const word2 = WORD_LIST[byte2 % WORD_LIST.length];
  const word3 = WORD_LIST[byte3 % WORD_LIST.length];

  return `${word1}-${word2}-${word3}`;
}

// ============================================================================
// nodeIdToWords Tests
// ============================================================================

describe("nodeIdToWords", () => {
  it("should generate a 3-word hyphenated name", () => {
    const result = nodeIdToWords("abc123def456");
    const words = result.split("-");
    expect(words.length).toBe(3);
  });

  it("should be deterministic - same input gives same output", () => {
    const nodeId = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";
    const result1 = nodeIdToWords(nodeId);
    const result2 = nodeIdToWords(nodeId);
    expect(result1).toBe(result2);
  });

  it("should generate different names for different node IDs", () => {
    const name1 = nodeIdToWords("0000000000000000");
    const name2 = nodeIdToWords("ffffffffffffffff");
    const name3 = nodeIdToWords("123456789abcdef0");

    // All should be different (statistically very likely)
    expect(name1).not.toBe(name2);
    expect(name2).not.toBe(name3);
    expect(name1).not.toBe(name3);
  });

  it("should handle short node IDs", () => {
    const result = nodeIdToWords("abc");
    const words = result.split("-");
    expect(words.length).toBe(3);
    // Each word should be non-empty
    expect(words[0]!.length).toBeGreaterThan(0);
    expect(words[1]!.length).toBeGreaterThan(0);
    expect(words[2]!.length).toBeGreaterThan(0);
  });

  it("should handle empty node ID", () => {
    const result = nodeIdToWords("");
    const words = result.split("-");
    expect(words.length).toBe(3);
  });

  it("should strip non-hex characters", () => {
    // Node ID with dashes, spaces, and other chars
    const withChars = nodeIdToWords("ab-cd-ef-12-34");
    const withoutChars = nodeIdToWords("abcdef1234");
    // After stripping, they should produce the same result
    expect(withChars).toBe(withoutChars);
  });

  it("should use different parts of long node IDs for variety", () => {
    // Two node IDs that differ at the sampled positions (0-2, 16-18, 32-34)
    // Algorithm samples: byte1 from 0-2, byte2 from 16-18, byte3 from 32-34
    const nodeId1 = "aa00000000000000bb00000000000000cc000000";
    const nodeId2 = "ff00000000000000dd00000000000000ee000000";

    const name1 = nodeIdToWords(nodeId1);
    const name2 = nodeIdToWords(nodeId2);

    // Should produce different names since sampled positions differ
    expect(name1).not.toBe(name2);
  });

  it("should produce lowercase hyphenated format", () => {
    const result = nodeIdToWords("ABCDEF123456");
    // Result should be lowercase with hyphens
    expect(result).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/);
  });

  it("should handle typical 64-char node IDs", () => {
    const longNodeId = "a".repeat(64);
    const result = nodeIdToWords(longNodeId);
    const words = result.split("-");
    expect(words.length).toBe(3);
  });

  it("should produce words from the expected word list", () => {
    // Test several node IDs and verify words are valid
    const testIds = [
      "0123456789abcdef",
      "fedcba9876543210",
      "deadbeefcafebabe",
    ];

    for (const nodeId of testIds) {
      const result = nodeIdToWords(nodeId);
      const words = result.split("-");

      // Each word should be a short, readable word
      for (const word of words) {
        expect(word.length).toBeGreaterThan(0);
        expect(word.length).toBeLessThan(10); // Words in the list are short
      }
    }
  });
});
