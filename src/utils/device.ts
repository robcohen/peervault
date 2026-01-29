/**
 * Device Utilities
 *
 * Helper functions for device identification.
 */

import { Platform } from "obsidian";

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
    const userAgent = navigator.userAgent;
    const androidMatch = userAgent.match(/Android\s+[\d.]+;\s*([^)]+)\)/);
    if (androidMatch?.[1]) {
      // Clean up the model name
      let model = androidMatch[1].trim();
      // Remove "Build/..." suffix if present
      model = model.replace(/\s*Build\/.*$/, "").trim();
      if (model && model !== "wv") {
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
