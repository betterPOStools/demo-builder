// Ported from adv-menu-import/lib/processing/mhtmlParser.ts

export interface MhtmlPart {
  name: string;
  mimeType: string;
  base64: string;
}

export interface MhtmlResult {
  html: string;
  images: MhtmlPart[];
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeQuotedPrintable(text: string): string {
  return text
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
}

/**
 * Parse an MHTML file into its HTML text and embedded images.
 * Falls back to treating the entire content as HTML if boundary parsing fails.
 */
export function parseMhtml(buffer: Buffer): MhtmlResult {
  const text = buffer.toString("utf-8");

  const boundaryMatch = text.match(/boundary=["']?([^"'\r\n;]+)["']?/i);
  if (!boundaryMatch) return { html: text, images: [] };

  const boundary = "--" + boundaryMatch[1].trim();
  const parts = text.split(new RegExp(`\\r?\\n${escapeRegex(boundary)}`));

  let html = "";
  const images: MhtmlPart[] = [];

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    if (!part.trim() || part.trimStart().startsWith("--")) continue;

    const crlfSplit = part.indexOf("\r\n\r\n");
    const lfSplit = part.indexOf("\n\n");
    const headerEnd = crlfSplit !== -1 ? crlfSplit : lfSplit;
    if (headerEnd === -1) continue;

    const headerStr = part.slice(0, headerEnd);
    const body = part.slice(headerEnd + (crlfSplit !== -1 ? 4 : 2));

    const headers: Record<string, string> = {};
    for (const line of headerStr.split(/\r?\n/)) {
      const idx = line.indexOf(":");
      if (idx > 0)
        headers[line.slice(0, idx).trim().toLowerCase()] = line
          .slice(idx + 1)
          .trim();
    }

    const ct = (headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    const enc = (headers["content-transfer-encoding"] || "").trim().toLowerCase();
    const loc = headers["content-location"] || "";

    if (ct === "text/html") {
      html =
        enc === "quoted-printable"
          ? decodeQuotedPrintable(body)
          : enc === "base64"
            ? Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf-8")
            : body;
    } else if (ct.startsWith("image/") || ct === "image/svg+xml") {
      const base64 =
        enc === "base64"
          ? body.replace(/\s+/g, "")
          : Buffer.from(body).toString("base64");
      const rawName = loc.split("/").pop()?.split("?")[0] || `image_${i}`;
      if (base64.length > 100) {
        images.push({ name: rawName, mimeType: ct, base64 });
      }
    }
  }

  return { html, images };
}
