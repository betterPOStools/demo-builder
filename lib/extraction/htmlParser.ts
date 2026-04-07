// Ported from adv-menu-import/lib/processing/htmlParser.ts

const MAX_TEXT_LENGTH = 40_000;

/**
 * Extract JSON-LD structured data from HTML (schema.org Menu, Restaurant, etc.)
 * Many JS-rendered restaurant sites embed menu data this way even when the
 * visible text is loaded client-side.
 */
export function extractJsonLd(html: string): string {
  const blocks: string[] = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1].trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      const str = JSON.stringify(parsed, null, 2);
      // Only keep if it looks menu/restaurant related
      if (
        /menu|restaurant|food|drink|price|offer/i.test(str) ||
        /@type.*?Restaurant/i.test(str) ||
        /@type.*?Menu/i.test(str)
      ) {
        blocks.push(str);
      }
    } catch {
      // malformed JSON-LD, skip
    }
  }
  return blocks.join("\n\n").slice(0, MAX_TEXT_LENGTH);
}

export function extractPageTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  if (!m) return null;
  const raw = m[1]
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
  if (!raw) return null;
  const trimmed = raw.split(/\s*[|\-\u2013\u2014]\s*/)[0].trim();
  return trimmed || raw;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, "\n")
    .trim()
    .slice(0, MAX_TEXT_LENGTH);
}

export function extractImageUrls(html: string, baseUrl: string): string[] {
  const favicons = new Set<string>();
  const images = new Set<string>();
  let m: RegExpExecArray | null;

  // Favicons
  const linkRe = /<link([^>]+)>/gi;
  while ((m = linkRe.exec(html)) !== null) {
    const attrs = m[1];
    if (/rel=["'][^"']*(?:icon|apple-touch-icon)[^"']*["']/i.test(attrs)) {
      const href = attrs.match(/href=["']([^"']+)["']/i);
      if (href) {
        try { favicons.add(new URL(href[1], baseUrl).href); } catch {}
      }
    }
  }
  try {
    const root = new URL(baseUrl);
    favicons.add(`${root.protocol}//${root.host}/favicon.ico`);
  } catch {}

  // <img> tags + lazy-load attributes
  const imgTagRe = /<img([^>]+)>/gi;
  const lazyAttrRe =
    /(?:^|\s)(?:src|data-src|data-lazy-src|data-lazy|data-original|data-img|data-url)=["']([^"']+)["']/gi;
  while ((m = imgTagRe.exec(html)) !== null) {
    const tag = m[1];
    let a: RegExpExecArray | null;
    lazyAttrRe.lastIndex = 0;
    while ((a = lazyAttrRe.exec(tag)) !== null) {
      const val = a[1].trim().split(/\s+/)[0];
      if (val && !val.startsWith("data:")) {
        try { images.add(new URL(val, baseUrl).href); } catch {}
      }
    }
  }

  // srcset
  const srcsetRe = /data-srcset=["']([^"']+)["']|srcset=["']([^"']+)["']/gi;
  while ((m = srcsetRe.exec(html)) !== null) {
    const raw = (m[1] || m[2] || "").trim().split(",")[0].trim().split(/\s+/)[0];
    if (raw) {
      try { images.add(new URL(raw, baseUrl).href); } catch {}
    }
  }

  // CSS background-image
  const bgRe = /url\(["']?(https?:\/\/[^"')]+)["']?\)/gi;
  while ((m = bgRe.exec(html)) !== null) {
    try { images.add(new URL(m[1], baseUrl).href); } catch {}
  }

  return [...favicons, ...images];
}
