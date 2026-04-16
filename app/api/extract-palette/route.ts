// Mechanical palette extractor — zero-AI brand color lookup.
// Ported from agent/batch_pipeline.py:_extract_branding_mechanical.
// Fetches the homepage HTML server-side, regex-scans for <meta name="theme-color">
// and CSS custom properties (--primary, --brand, --accent, --wp--preset--color--*),
// and returns a palette with WCAG-compliant button font color.

const WP_DEFAULT_PALETTE = new Set([
  "#cf2e2e", "#ff6900", "#fcb900", "#7bdcb5", "#00d084",
  "#8ed1fc", "#0693e3", "#abb8c3", "#9b51e0",
]);

function luminance(hex: string): number {
  const h = hex.replace("#", "");
  if (h.length !== 6) return 0;
  const chans: number[] = [];
  for (let i = 0; i < 6; i += 2) {
    const v = parseInt(h.slice(i, i + 2), 16) / 255;
    chans.push(v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  }
  return 0.2126 * chans[0] + 0.7152 * chans[1] + 0.0722 * chans[2];
}

function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function pickFontColor(bg: string): string {
  return contrast(bg, "#FFFFFF") >= contrast(bg, "#000000") ? "#FFFFFF" : "#000000";
}

function extractFromHtml(html: string): { buttons_background_color: string } | null {
  if (!html) return null;

  const metaMatch = html.match(
    /<meta\s+name=["']theme-color["']\s+content=["'](#[0-9A-Fa-f]{6})["']/i,
  );
  if (metaMatch) {
    return { buttons_background_color: metaMatch[1].toUpperCase() };
  }

  const cssMatch = html.match(
    /--(?:primary|brand|brand-primary|accent|accent-color|color-primary|wp--preset--color--primary|wp--preset--color--accent)\s*:\s*(#[0-9A-Fa-f]{6})/i,
  );
  if (cssMatch) {
    const hex = cssMatch[1].toLowerCase();
    if (!WP_DEFAULT_PALETTE.has(hex)) {
      return { buttons_background_color: hex.toUpperCase() };
    }
  }

  return null;
}

async function fetchHtml(url: string): Promise<string> {
  const target = url.startsWith("http") ? url : `https://${url}`;
  const res = await fetch(target, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Fetch failed: HTTP ${res.status}`);
  return res.text();
}

export async function POST(request: Request) {
  try {
    const { url } = (await request.json()) as { url: string };
    if (!url) {
      return Response.json({ error: "Missing url" }, { status: 400 });
    }

    let html: string;
    try {
      html = await fetchHtml(url);
    } catch (err) {
      return Response.json(
        { found: false, reason: `Fetch failed: ${(err as Error).message}` },
        { status: 200 },
      );
    }

    const palette = extractFromHtml(html);
    if (!palette) {
      return Response.json({
        found: false,
        reason: "No theme-color meta tag or brand CSS custom properties found.",
      });
    }

    const bg = palette.buttons_background_color;
    return Response.json({
      found: true,
      palette: {
        background: null,
        buttons_background_color: bg,
        buttons_font_color: pickFontColor(bg),
      },
    });
  } catch (err) {
    return Response.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}
