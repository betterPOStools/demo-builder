// Ported from adv-menu-import/lib/processing/docParser.ts
// Text extraction for Office document formats (DOCX, PPTX) and RTF.
// Uses jszip (already a dependency via other packages) for DOCX/PPTX.

const MAX_TEXT_LENGTH = 40_000;

/**
 * Strip RTF control words and braces to extract plain text.
 */
export function stripRtf(rtf: string): string {
  return rtf
    .replace(/\{\\[\w\s*;]+\}/g, "")
    .replace(/\\[a-z]+[-\d]* ?/gi, "")
    .replace(/[{}\\]/g, "")
    .replace(/\s{2,}/g, "\n")
    .trim()
    .slice(0, MAX_TEXT_LENGTH);
}

/**
 * Extract plain text from a DOCX buffer using jszip.
 */
export async function extractDocxText(buffer: Buffer): Promise<string> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(buffer);
  const xmlFile = zip.file("word/document.xml");
  if (!xmlFile) return "";
  const xml = await xmlFile.async("string");
  return xml
    .replace(/<w:p[ >][^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s{2,}/g, "\n")
    .trim()
    .slice(0, MAX_TEXT_LENGTH);
}

/**
 * Extract plain text from a PPTX buffer using jszip.
 */
export async function extractPptxText(buffer: Buffer): Promise<string> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(buffer);
  const slideNames = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/i.test(n))
    .sort();
  const parts: string[] = [];
  for (const name of slideNames) {
    const xml = await zip.files[name].async("string");
    const text = xml
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&nbsp;/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
    if (text) parts.push(text);
  }
  return parts.join("\n\n").slice(0, MAX_TEXT_LENGTH);
}
