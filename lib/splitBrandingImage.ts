/**
 * Split a combined 1384×716 branding image into sidebar + background pieces.
 *
 * POS layout (left→right):
 *   Sidebar panel : 360px wide, image padded with equal margin top/bottom/left
 *   Background    : 1024px wide × 716px tall
 *
 * Sidebar image size  : 360×696  (716 - 20px vertical padding = 696)
 * Background img size : 1024×716
 * Combined canvas     : 1384×716
 */

export const SIDEBAR_W = 360;
export const SIDEBAR_H = 696;
export const BG_W = 1024;
export const BG_H = 716;
export const COMBINED_W = SIDEBAR_W + BG_W; // 1384
export const COMBINED_H = BG_H;             // 716

/** Vertical offset to center sidebar image within the combined height */
const SIDEBAR_Y_OFFSET = Math.floor((COMBINED_H - SIDEBAR_H) / 2); // 10

export interface SplitResult {
  sidebarPng: string;
  backgroundPng: string;
}

/**
 * Crop a PNG data URI (must be COMBINED_W × COMBINED_H) into the two POS assets.
 */
export function splitBrandingImage(fullDataUri: string): Promise<SplitResult> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      // Sidebar: left strip, vertically centred
      const sbCanvas = document.createElement("canvas");
      sbCanvas.width = SIDEBAR_W;
      sbCanvas.height = SIDEBAR_H;
      const sbCtx = sbCanvas.getContext("2d")!;
      sbCtx.drawImage(img, 0, SIDEBAR_Y_OFFSET, SIDEBAR_W, SIDEBAR_H, 0, 0, SIDEBAR_W, SIDEBAR_H);

      // Background: right strip, full height
      const bgCanvas = document.createElement("canvas");
      bgCanvas.width = BG_W;
      bgCanvas.height = BG_H;
      const bgCtx = bgCanvas.getContext("2d")!;
      bgCtx.drawImage(img, SIDEBAR_W, 0, BG_W, BG_H, 0, 0, BG_W, BG_H);

      resolve({
        sidebarPng: sbCanvas.toDataURL("image/png"),
        backgroundPng: bgCanvas.toDataURL("image/png"),
      });
    };
    img.onerror = reject;
    img.src = fullDataUri;
  });
}

/**
 * Scale any user-supplied image to cover COMBINED_W × COMBINED_H, then split.
 */
export function splitUploadedImage(file: File): Promise<SplitResult> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);

      const scale = Math.max(COMBINED_W / img.width, COMBINED_H / img.height);
      const sw = img.width * scale;
      const sh = img.height * scale;
      const sx = (COMBINED_W - sw) / 2;
      const sy = (COMBINED_H - sh) / 2;

      const combined = document.createElement("canvas");
      combined.width = COMBINED_W;
      combined.height = COMBINED_H;
      const ctx = combined.getContext("2d")!;
      ctx.drawImage(img, sx, sy, sw, sh);

      splitBrandingImage(combined.toDataURL("image/png")).then(resolve).catch(reject);
    };
    img.onerror = reject;
    img.src = url;
  });
}
