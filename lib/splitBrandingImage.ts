/**
 * Split a 1024×716 background image into sidebar + background pieces.
 *
 * POS layout: the background fills the full 1024×716 area, and the sidebar
 * panel is overlaid on top of the background's left edge with equal 10px
 * padding on top, bottom, and left (no right padding — the panel butts up
 * against the menu content).
 *
 *   Background  : 1024 × 716  (full canvas)
 *   Sidebar     :  360 × 696  positioned at (x=10, y=10), occupying
 *                              x:10–370, y:10–706 of the background.
 *
 * Sidebar pixels are cropped directly from the background image so the
 * overlay seam is invisible.
 */

export const SIDEBAR_W = 360;
export const SIDEBAR_H = 696;
export const BG_W = 1024;
export const BG_H = 716;
export const COMBINED_W = SIDEBAR_W + BG_W; // legacy — used by old AutoPilot path
export const COMBINED_H = BG_H;
export const SIDEBAR_X_OFFSET = 10;
export const SIDEBAR_Y_OFFSET = Math.floor((BG_H - SIDEBAR_H) / 2); // 10

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
 * Seamless split: derive sidebar by cropping the left edge of a BG_W×BG_H image.
 * Both sidebar and background come from the same fal-generated image — no second call needed.
 */
export function splitFromBackground(bgDataUri: string): Promise<SplitResult> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const bgCanvas = document.createElement("canvas");
      bgCanvas.width = BG_W;
      bgCanvas.height = BG_H;
      const bgCtx = bgCanvas.getContext("2d")!;
      bgCtx.drawImage(img, 0, 0, BG_W, BG_H);

      const sbCanvas = document.createElement("canvas");
      sbCanvas.width = SIDEBAR_W;
      sbCanvas.height = SIDEBAR_H;
      const sbCtx = sbCanvas.getContext("2d")!;
      sbCtx.drawImage(
        bgCanvas,
        SIDEBAR_X_OFFSET, SIDEBAR_Y_OFFSET, SIDEBAR_W, SIDEBAR_H,
        0, 0, SIDEBAR_W, SIDEBAR_H,
      );

      resolve({
        sidebarPng: sbCanvas.toDataURL("image/png"),
        backgroundPng: bgCanvas.toDataURL("image/png"),
      });
    };
    img.onerror = reject;
    img.src = bgDataUri;
  });
}

/**
 * Scale any image source to cover the background dimensions (1024×716),
 * then crop the sidebar from the SAME image so the overlay is seamless.
 *
 * The POS renders the background full-width and overlays the sidebar on top
 * at (SIDEBAR_X_OFFSET, SIDEBAR_Y_OFFSET) — so the sidebar pixels must come
 * from the same region of the background image, not a separate slice.
 */
function splitFromHTMLImage(img: HTMLImageElement): Promise<SplitResult> {
  // Scale to cover the background canvas (object-fit: cover behavior)
  const scale = Math.max(BG_W / img.width, BG_H / img.height);
  const sw = img.width * scale;
  const sh = img.height * scale;
  const sx = (BG_W - sw) / 2;
  const sy = (BG_H - sh) / 2;

  const bgCanvas = document.createElement("canvas");
  bgCanvas.width = BG_W;
  bgCanvas.height = BG_H;
  const ctx = bgCanvas.getContext("2d")!;
  ctx.drawImage(img, sx, sy, sw, sh);

  return splitFromBackground(bgCanvas.toDataURL("image/png"));
}

export function splitUploadedImage(file: File): Promise<SplitResult> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      splitFromHTMLImage(img).then(resolve).catch(reject);
    };
    img.onerror = reject;
    img.src = url;
  });
}

/**
 * Take an arbitrary data URI (e.g. fal-generated background) and run it
 * through the same scale-to-cover + split pipeline used for uploaded images.
 * If the source is already 1024×716 the scale step is a no-op.
 */
export function splitFromDataUri(dataUri: string): Promise<SplitResult> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => splitFromHTMLImage(img).then(resolve).catch(reject);
    img.onerror = reject;
    img.src = dataUri;
  });
}

/**
 * Normalize any image data URI to exactly SIDEBAR_W × SIDEBAR_H using
 * scale-to-cover + center crop. Used to fit Ideogram/FLUX sidebar generations
 * (which come back at the model's native dimensions) into the POS sidebar
 * panel without distortion.
 */
export function fitToSidebar(dataUri: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.max(SIDEBAR_W / img.width, SIDEBAR_H / img.height);
      const sw = img.width * scale;
      const sh = img.height * scale;
      const sx = (SIDEBAR_W - sw) / 2;
      const sy = (SIDEBAR_H - sh) / 2;

      const canvas = document.createElement("canvas");
      canvas.width = SIDEBAR_W;
      canvas.height = SIDEBAR_H;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, sx, sy, sw, sh);
      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = reject;
    img.src = dataUri;
  });
}
