/**
 * Device Utilities
 *
 * Helper functions for device identification.
 */

import { Platform } from "obsidian";

/**
 * Word list for generating memorable device names from node IDs.
 * 256 words = 8 bits per word, 3 words = 24 bits = 16M combinations.
 * Curated for memorability: short, distinct, easy to pronounce.
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
 * The name is deterministic - same node ID always produces the same words.
 *
 * @param nodeId - The peer's node ID (hex string or any unique identifier)
 * @returns A hyphenated 3-word name like "bold-fox-rain"
 */
export function nodeIdToWords(nodeId: string): string {
  // Simple hash: take bytes from different parts of the node ID
  // Node IDs are typically 64+ hex chars, we just need 3 bytes (24 bits)
  const cleaned = nodeId.replace(/[^a-fA-F0-9]/g, "");

  // Use different positions in the ID for variety
  const byte1 = parseInt(cleaned.slice(0, 2) || "00", 16) % 256;
  const byte2 = parseInt(cleaned.slice(16, 18) || cleaned.slice(2, 4) || "00", 16) % 256;
  const byte3 = parseInt(cleaned.slice(32, 34) || cleaned.slice(4, 6) || "00", 16) % 256;

  const word1 = WORD_LIST[byte1 % WORD_LIST.length];
  const word2 = WORD_LIST[byte2 % WORD_LIST.length];
  const word3 = WORD_LIST[byte3 % WORD_LIST.length];

  return `${word1}-${word2}-${word3}`;
}

/**
 * Known iPhone model identifiers mapped to marketing names.
 * Based on https://gist.github.com/adamawolf/3048717
 */
const IPHONE_MODELS: Record<string, string> = {
  "iPhone1,1": "iPhone",
  "iPhone1,2": "iPhone 3G",
  "iPhone2,1": "iPhone 3GS",
  "iPhone3,1": "iPhone 4",
  "iPhone3,2": "iPhone 4",
  "iPhone3,3": "iPhone 4",
  "iPhone4,1": "iPhone 4S",
  "iPhone5,1": "iPhone 5",
  "iPhone5,2": "iPhone 5",
  "iPhone5,3": "iPhone 5c",
  "iPhone5,4": "iPhone 5c",
  "iPhone6,1": "iPhone 5s",
  "iPhone6,2": "iPhone 5s",
  "iPhone7,2": "iPhone 6",
  "iPhone7,1": "iPhone 6 Plus",
  "iPhone8,1": "iPhone 6s",
  "iPhone8,2": "iPhone 6s Plus",
  "iPhone8,4": "iPhone SE",
  "iPhone9,1": "iPhone 7",
  "iPhone9,3": "iPhone 7",
  "iPhone9,2": "iPhone 7 Plus",
  "iPhone9,4": "iPhone 7 Plus",
  "iPhone10,1": "iPhone 8",
  "iPhone10,4": "iPhone 8",
  "iPhone10,2": "iPhone 8 Plus",
  "iPhone10,5": "iPhone 8 Plus",
  "iPhone10,3": "iPhone X",
  "iPhone10,6": "iPhone X",
  "iPhone11,2": "iPhone XS",
  "iPhone11,4": "iPhone XS Max",
  "iPhone11,6": "iPhone XS Max",
  "iPhone11,8": "iPhone XR",
  "iPhone12,1": "iPhone 11",
  "iPhone12,3": "iPhone 11 Pro",
  "iPhone12,5": "iPhone 11 Pro Max",
  "iPhone12,8": "iPhone SE 2",
  "iPhone13,1": "iPhone 12 mini",
  "iPhone13,2": "iPhone 12",
  "iPhone13,3": "iPhone 12 Pro",
  "iPhone13,4": "iPhone 12 Pro Max",
  "iPhone14,4": "iPhone 13 mini",
  "iPhone14,5": "iPhone 13",
  "iPhone14,2": "iPhone 13 Pro",
  "iPhone14,3": "iPhone 13 Pro Max",
  "iPhone14,6": "iPhone SE 3",
  "iPhone14,7": "iPhone 14",
  "iPhone14,8": "iPhone 14 Plus",
  "iPhone15,2": "iPhone 14 Pro",
  "iPhone15,3": "iPhone 14 Pro Max",
  "iPhone15,4": "iPhone 15",
  "iPhone15,5": "iPhone 15 Plus",
  "iPhone16,1": "iPhone 15 Pro",
  "iPhone16,2": "iPhone 15 Pro Max",
  "iPhone17,1": "iPhone 16 Pro",
  "iPhone17,2": "iPhone 16 Pro Max",
  "iPhone17,3": "iPhone 16",
  "iPhone17,4": "iPhone 16 Plus",
};

/**
 * Known iPad model identifiers mapped to marketing names.
 */
const IPAD_MODELS: Record<string, string> = {
  "iPad1,1": "iPad",
  "iPad2,1": "iPad 2",
  "iPad2,2": "iPad 2",
  "iPad2,3": "iPad 2",
  "iPad2,4": "iPad 2",
  "iPad3,1": "iPad 3",
  "iPad3,2": "iPad 3",
  "iPad3,3": "iPad 3",
  "iPad3,4": "iPad 4",
  "iPad3,5": "iPad 4",
  "iPad3,6": "iPad 4",
  "iPad6,11": "iPad 5",
  "iPad6,12": "iPad 5",
  "iPad7,5": "iPad 6",
  "iPad7,6": "iPad 6",
  "iPad7,11": "iPad 7",
  "iPad7,12": "iPad 7",
  "iPad11,6": "iPad 8",
  "iPad11,7": "iPad 8",
  "iPad12,1": "iPad 9",
  "iPad12,2": "iPad 9",
  "iPad13,18": "iPad 10",
  "iPad13,19": "iPad 10",
  // iPad Air
  "iPad4,1": "iPad Air",
  "iPad4,2": "iPad Air",
  "iPad4,3": "iPad Air",
  "iPad5,3": "iPad Air 2",
  "iPad5,4": "iPad Air 2",
  "iPad11,3": "iPad Air 3",
  "iPad11,4": "iPad Air 3",
  "iPad13,1": "iPad Air 4",
  "iPad13,2": "iPad Air 4",
  "iPad13,16": "iPad Air 5",
  "iPad13,17": "iPad Air 5",
  // iPad Pro
  "iPad6,3": "iPad Pro 9.7",
  "iPad6,4": "iPad Pro 9.7",
  "iPad6,7": "iPad Pro 12.9",
  "iPad6,8": "iPad Pro 12.9",
  "iPad7,1": "iPad Pro 12.9 2",
  "iPad7,2": "iPad Pro 12.9 2",
  "iPad7,3": "iPad Pro 10.5",
  "iPad7,4": "iPad Pro 10.5",
  "iPad8,1": "iPad Pro 11",
  "iPad8,2": "iPad Pro 11",
  "iPad8,3": "iPad Pro 11",
  "iPad8,4": "iPad Pro 11",
  "iPad8,5": "iPad Pro 12.9 3",
  "iPad8,6": "iPad Pro 12.9 3",
  "iPad8,7": "iPad Pro 12.9 3",
  "iPad8,8": "iPad Pro 12.9 3",
  "iPad8,9": "iPad Pro 11 2",
  "iPad8,10": "iPad Pro 11 2",
  "iPad8,11": "iPad Pro 12.9 4",
  "iPad8,12": "iPad Pro 12.9 4",
  "iPad13,4": "iPad Pro 11 3",
  "iPad13,5": "iPad Pro 11 3",
  "iPad13,6": "iPad Pro 11 3",
  "iPad13,7": "iPad Pro 11 3",
  "iPad13,8": "iPad Pro 12.9 5",
  "iPad13,9": "iPad Pro 12.9 5",
  "iPad13,10": "iPad Pro 12.9 5",
  "iPad13,11": "iPad Pro 12.9 5",
  "iPad14,3": "iPad Pro 11 4",
  "iPad14,4": "iPad Pro 11 4",
  "iPad14,5": "iPad Pro 12.9 6",
  "iPad14,6": "iPad Pro 12.9 6",
  // iPad mini
  "iPad2,5": "iPad mini",
  "iPad2,6": "iPad mini",
  "iPad2,7": "iPad mini",
  "iPad4,4": "iPad mini 2",
  "iPad4,5": "iPad mini 2",
  "iPad4,6": "iPad mini 2",
  "iPad4,7": "iPad mini 3",
  "iPad4,8": "iPad mini 3",
  "iPad4,9": "iPad mini 3",
  "iPad5,1": "iPad mini 4",
  "iPad5,2": "iPad mini 4",
  "iPad11,1": "iPad mini 5",
  "iPad11,2": "iPad mini 5",
  "iPad14,1": "iPad mini 6",
  "iPad14,2": "iPad mini 6",
};

/**
 * Parse the model identifier from userAgent string.
 * iOS userAgent contains model like "iPhone14,2" or "iPad13,4"
 */
function parseIOSModel(userAgent: string): string | null {
  // iOS userAgent format includes the model identifier
  // e.g., "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)"
  // But the actual model ID comes from different sources

  // Try to find iPhone or iPad model identifier pattern
  const iphoneMatch = userAgent.match(/iPhone(\d+,\d+)/);
  if (iphoneMatch) {
    return `iPhone${iphoneMatch[1]}`;
  }

  const ipadMatch = userAgent.match(/iPad(\d+,\d+)/);
  if (ipadMatch) {
    return `iPad${ipadMatch[1]}`;
  }

  return null;
}

/**
 * Get a friendly device name for the current device.
 *
 * On desktop: Uses os.hostname()
 * On mobile: Uses platform detection and userAgent parsing
 */
export function getDeviceHostname(): string {
  // Try os.hostname() first (works on desktop)
  try {
    // Dynamic import to avoid bundler issues
    const os = require("os");
    const hostname = os.hostname();
    if (hostname) {
      return hostname;
    }
  } catch {
    // os module not available (mobile)
  }

  // Mobile fallback: Use platform detection
  if (Platform.isIosApp) {
    // Try to get specific model from userAgent
    const userAgent = navigator.userAgent;
    const modelId = parseIOSModel(userAgent);

    if (modelId) {
      // Look up friendly name
      const friendlyName = IPHONE_MODELS[modelId] || IPAD_MODELS[modelId];
      if (friendlyName) {
        return friendlyName;
      }
      // Return the model ID if no friendly name found
      return modelId;
    }

    // Check if it's iPad or iPhone from userAgent
    if (userAgent.includes("iPad")) {
      return "iPad";
    }
    return "iPhone";
  }

  if (Platform.isAndroidApp) {
    // Try to extract Android device model from userAgent
    // Format: "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/..."
    // WebView format: "Mozilla/5.0 (Linux; Android 13; K; wv) AppleWebKit/..."
    const userAgent = navigator.userAgent;
    const androidMatch = userAgent.match(/Android\s+[\d.]+;\s*([^)]+)\)/);
    if (androidMatch?.[1]) {
      // Clean up the model name
      let model = androidMatch[1].trim();
      // Remove "Build/..." suffix if present
      model = model.replace(/\s*Build\/.*$/, "").trim();
      // Remove WebView indicator and other garbage
      model = model.replace(/;\s*wv\s*$/i, "").trim();
      model = model.replace(/^K\s*;?\s*/i, "").trim(); // "K" is Android 14+ privacy placeholder
      // Only use if we have a real model name (not empty, not just punctuation)
      if (model && model.length > 2 && !/^[;\s]+$/.test(model)) {
        return model;
      }
    }
    return "Android";
  }

  // Generic fallback
  if (Platform.isMobile) {
    return "Mobile Device";
  }

  return "Desktop";
}
