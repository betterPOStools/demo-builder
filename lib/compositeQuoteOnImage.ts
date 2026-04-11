/**
 * Composite a quote + attribution onto a background image using the browser
 * Canvas API. Used by the branding sidebar flow: fal generates a plain
 * FLUX Pro texture, then this utility draws the quote on top so text layout
 * is fully controlled (no more Ideogram layout surprises).
 *
 * Runs client-side only — requires `document` and `HTMLCanvasElement`.
 */

export type QuoteTreatment = "bare" | "band" | "card";

export interface CompositeQuoteOptions {
  /** Default: "Georgia, serif" */
  fontFamily?: string;
  /** Default: "#ffffff" */
  textColor?: string;
  /** Default: "band" */
  treatment?: QuoteTreatment;
  /** Default: 360 (matches SIDEBAR_W) */
  canvasWidth?: number;
  /** Default: 696 (matches SIDEBAR_H) */
  canvasHeight?: number;
}

const QUOTE_FONT_SIZE = 18;
const QUOTE_LINE_HEIGHT = 26;
const ATTR_FONT_SIZE = 13;
const ATTR_MARGIN_TOP = 12;
const TEXT_MAX_WIDTH_PCT = 0.8;

/**
 * Draw the quote + attribution over `backgroundDataUri` and return a new PNG
 * data URI sized to canvasWidth × canvasHeight.
 */
export function compositeQuoteOnImage(
  backgroundDataUri: string,
  quote: string,
  attribution: string,
  options: CompositeQuoteOptions = {},
): Promise<string> {
  const {
    fontFamily = "Georgia, serif",
    textColor = "#ffffff",
    treatment = "band",
    canvasWidth = 360,
    canvasHeight = 696,
  } = options;

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = canvasWidth;
        canvas.height = canvasHeight;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("2D canvas context unavailable"));
          return;
        }

        // 1. Draw background scaled to cover the canvas
        const scale = Math.max(canvasWidth / img.width, canvasHeight / img.height);
        const sw = img.width * scale;
        const sh = img.height * scale;
        const sx = (canvasWidth - sw) / 2;
        const sy = (canvasHeight - sh) / 2;
        ctx.drawImage(img, sx, sy, sw, sh);

        // Measure the quote lines first so we know how tall the text block is
        const maxTextWidth = canvasWidth * TEXT_MAX_WIDTH_PCT;
        ctx.font = `bold ${QUOTE_FONT_SIZE}px ${fontFamily}`;
        const quoteLines = wrapText(ctx, quote, maxTextWidth);

        const hasAttribution = attribution.trim().length > 0;
        const attributionText = hasAttribution ? `— ${attribution.trim()}` : "";
        const attributionHeight = hasAttribution
          ? ATTR_MARGIN_TOP + ATTR_FONT_SIZE
          : 0;

        const textBlockHeight =
          quoteLines.length * QUOTE_LINE_HEIGHT + attributionHeight;

        const centerX = canvasWidth / 2;
        const centerY = canvasHeight / 2;

        // 2. Draw treatment behind the text
        if (treatment === "band") {
          const padding = 24;
          const bandHeight = textBlockHeight + padding * 2;
          ctx.fillStyle = "rgba(0,0,0,0.55)";
          ctx.fillRect(0, centerY - bandHeight / 2, canvasWidth, bandHeight);
        } else if (treatment === "card") {
          const padding = 24;
          const cardWidth = canvasWidth * 0.8;
          const cardHeight = textBlockHeight + padding * 2;
          const cardX = (canvasWidth - cardWidth) / 2;
          const cardY = centerY - cardHeight / 2;
          ctx.fillStyle = "rgba(255,255,255,0.08)";
          drawRoundedRect(ctx, cardX, cardY, cardWidth, cardHeight, 16);
          ctx.fill();
        }

        // 3. Draw quote text lines
        ctx.fillStyle = textColor;
        ctx.textAlign = "center";
        ctx.textBaseline = "alphabetic";
        ctx.font = `bold ${QUOTE_FONT_SIZE}px ${fontFamily}`;

        const textTop = centerY - textBlockHeight / 2;
        let baselineY = textTop + QUOTE_FONT_SIZE;
        for (const line of quoteLines) {
          ctx.fillText(line, centerX, baselineY);
          baselineY += QUOTE_LINE_HEIGHT;
        }

        // 4. Draw attribution below the quote (if any)
        if (hasAttribution) {
          ctx.font = `italic ${ATTR_FONT_SIZE}px ${fontFamily}`;
          ctx.globalAlpha = 0.7;
          const attributionBaselineY =
            baselineY - QUOTE_LINE_HEIGHT + ATTR_MARGIN_TOP + ATTR_FONT_SIZE;
          ctx.fillText(attributionText, centerX, attributionBaselineY);
          ctx.globalAlpha = 1;
        }

        resolve(canvas.toDataURL("image/png"));
      } catch (err) {
        reject(err);
      }
    };
    img.onerror = () =>
      reject(new Error("Failed to load background image for quote composite"));
    img.src = backgroundDataUri;
  });
}

function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const lines: string[] = [];
  let current = words[0];

  for (let i = 1; i < words.length; i++) {
    const candidate = `${current} ${words[i]}`;
    if (ctx.measureText(candidate).width > maxWidth) {
      lines.push(current);
      current = words[i];
    } else {
      current = candidate;
    }
  }
  lines.push(current);
  return lines;
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.arcTo(x + w, y, x + w, y + radius, radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius);
  ctx.lineTo(x + radius, y + h);
  ctx.arcTo(x, y + h, x, y + h - radius, radius);
  ctx.lineTo(x, y + radius);
  ctx.arcTo(x, y, x + radius, y, radius);
  ctx.closePath();
}
