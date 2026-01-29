/**
 * QR Code Utilities
 *
 * Shared functions for QR code generation and scanning.
 */

export interface QRCodeOptions {
  /** Width in pixels (default: 200) */
  width?: number;
  /** CSS class for the canvas element */
  canvasClass?: string;
  /** Error CSS class for the container */
  errorClass?: string;
  /** Error message to display on failure */
  errorMessage?: string;
}

const DEFAULT_OPTIONS: Required<QRCodeOptions> = {
  width: 200,
  canvasClass: "peervault-qr-canvas",
  errorClass: "peervault-qr-error",
  errorMessage: "QR code generation failed",
};

/**
 * Generate a QR code and render it to a canvas in the container.
 * Automatically adapts colors for dark/light mode.
 */
export async function generateQRCode(
  container: HTMLElement,
  data: string,
  options: QRCodeOptions = {},
): Promise<HTMLCanvasElement | null> {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  try {
    const QRCode = await import("qrcode");
    const canvas = container.createEl("canvas", { cls: opts.canvasClass });

    // Check if dark mode is active
    const isDark = document.body.classList.contains("theme-dark");

    await QRCode.toCanvas(canvas, data, {
      width: opts.width,
      margin: 2,
      color: {
        dark: isDark ? "#ffffff" : "#000000",
        light: isDark ? "#1e1e1e" : "#ffffff",
      },
      errorCorrectionLevel: "M",
    });

    return canvas;
  } catch (error) {
    container.createEl("p", {
      text: opts.errorMessage,
      cls: opts.errorClass,
    });
    return null;
  }
}

/**
 * Load an image file and return its ImageData for processing.
 */
export async function loadImageData(file: File): Promise<ImageData> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("Could not get canvas context"));
        return;
      }
      ctx.drawImage(img, 0, 0);
      resolve(ctx.getImageData(0, 0, canvas.width, canvas.height));
    };

    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Failed to load image"));
    };

    img.src = objectUrl;
  });
}

/**
 * Scan an image file for a QR code and return the decoded data.
 * Returns null if no QR code is found.
 */
export async function scanQRFromImage(file: File): Promise<string | null> {
  const imageData = await loadImageData(file);
  const jsQR = (await import("jsqr")).default;
  const code = jsQR(imageData.data, imageData.width, imageData.height);
  return code?.data ?? null;
}

/**
 * Scan QR code from clipboard image.
 * Returns the decoded data or null if no QR code found.
 */
export async function scanQRFromClipboard(): Promise<string | null> {
  const items = await navigator.clipboard.read();

  for (const item of items) {
    // Check for image types
    const imageType = item.types.find((type) => type.startsWith("image/"));
    if (imageType) {
      const blob = await item.getType(imageType);
      const file = new File([blob], "clipboard.png", { type: imageType });
      return scanQRFromImage(file);
    }
  }

  return null;
}

/**
 * Open a file picker for selecting an image to scan.
 * Returns the decoded QR data or null.
 */
export function openQRFilePicker(): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";

    input.onchange = async () => {
      const file = input.files?.[0];
      if (file) {
        try {
          const result = await scanQRFromImage(file);
          resolve(result);
        } catch {
          resolve(null);
        }
      } else {
        resolve(null);
      }
    };

    // Handle cancel
    input.oncancel = () => resolve(null);

    input.click();
  });
}
