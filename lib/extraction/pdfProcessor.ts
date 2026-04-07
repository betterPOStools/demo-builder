// Ported from adv-menu-import/lib/processing/pdfProcessor.ts
// Server-side only — uses mupdf native module

let mupdfModule: Record<string, unknown> | null = null;
let mupdfLoaded = false;

async function getMupdf(): Promise<any> {
  if (mupdfLoaded) return mupdfModule;
  mupdfLoaded = true;
  try {
    mupdfModule = await import("mupdf");
    return mupdfModule;
  } catch {
    console.warn("[pdfProcessor] mupdf not available — PDF features degraded");
    return null;
  }
}

const MAX_TEXT_LENGTH = 40_000;

export async function extractPdfText(buffer: Buffer): Promise<string> {
  const mupdf = await getMupdf();
  if (!mupdf) return "";

  try {
    const doc = mupdf.Document.openDocument(buffer, "application/pdf");
    const pageCount = doc.countPages();
    const parts: string[] = [];

    for (let i = 0; i < pageCount; i++) {
      const page = doc.loadPage(i);
      try {
        const sText = page.toStructuredText("preserve-whitespace");
        try {
          parts.push(sText.asText());
        } catch {
          const json = JSON.parse(sText.asJSON());
          const lines: string[] = [];
          for (const block of json.blocks ?? []) {
            for (const line of block.lines ?? []) {
              const text = (line.spans ?? [])
                .map((s: { text: string }) => s.text)
                .join("");
              if (text.trim()) lines.push(text);
            }
          }
          parts.push(lines.join("\n"));
        }
      } catch {
        // Skip pages that fail
      }
    }

    return parts.join("\n\n").slice(0, MAX_TEXT_LENGTH);
  } catch {
    return "";
  }
}

export interface RenderedPage {
  base64: string;
  mimeType: "image/jpeg";
}

const RENDER_DPI = 150;
const RENDER_SCALE = RENDER_DPI / 72;
const RENDER_QUALITY = 82;
const MAX_RENDER_PAGES = 30;

export async function renderPdfPages(buffer: Buffer): Promise<RenderedPage[]> {
  const mupdf = await getMupdf();
  if (!mupdf) return [];

  try {
    const doc = mupdf.Document.openDocument(buffer, "application/pdf");
    const pageCount = Math.min(doc.countPages(), MAX_RENDER_PAGES);
    const pages: RenderedPage[] = [];

    for (let i = 0; i < pageCount; i++) {
      try {
        const page = doc.loadPage(i);
        const matrix = mupdf.Matrix.scale(RENDER_SCALE, RENDER_SCALE);
        const pixmap = page.toPixmap(
          matrix,
          mupdf.ColorSpace.DeviceRGB,
          false,
          true,
        );
        const jpegBuf = Buffer.from(pixmap.asJPEG(RENDER_QUALITY));
        pages.push({
          base64: jpegBuf.toString("base64"),
          mimeType: "image/jpeg",
        });
      } catch {
        // Skip pages that fail
      }
    }

    return pages;
  } catch {
    return [];
  }
}
