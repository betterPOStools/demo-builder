import Anthropic from "@anthropic-ai/sdk";
import type { ImageBlockParam } from "@anthropic-ai/sdk/resources/messages";

const client = new Anthropic();

export const maxDuration = 60;

// ── Helpers ──────────────────────────────────────────────────────────────────

function isImageUrl(url: string) {
  return /\.(jpg|jpeg|png|webp|gif|avif)(\?.*)?$/i.test(url);
}

async function fetchWebsiteText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; BrandBot/1.0)" },
    signal: AbortSignal.timeout(8000),
  });
  const html = await res.text();

  // Extract useful metadata via regex (no DOM parser needed server-side)
  const get = (pattern: RegExp) => (html.match(pattern)?.[1] ?? "").trim();

  const title =
    get(/<title[^>]*>([^<]+)<\/title>/i) ||
    get(/property="og:title"\s+content="([^"]+)"/i) ||
    get(/content="([^"]+)"\s+property="og:title"/i);

  const description =
    get(/name="description"\s+content="([^"]+)"/i) ||
    get(/property="og:description"\s+content="([^"]+)"/i) ||
    get(/content="([^"]+)"\s+name="description"/i);

  const themeColor =
    get(/name="theme-color"\s+content="([^"]+)"/i) ||
    get(/content="([^"]+)"\s+name="theme-color"/i);

  const ogImage =
    get(/property="og:image"\s+content="([^"]+)"/i) ||
    get(/content="([^"]+)"\s+property="og:image"/i);

  // Grab body text (strip tags, collapse whitespace, first 1500 chars)
  const bodyText = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, 1500);

  return [
    title && `Title: ${title}`,
    description && `Description: ${description}`,
    themeColor && `Theme color: ${themeColor}`,
    ogImage && `OG image: ${ogImage}`,
    `Body text: ${bodyText}`,
  ]
    .filter(Boolean)
    .join("\n");
}

const TOKEN_SCHEMA = `{
  "brand_name": string,
  "industry": string,
  "color_palette": {
    "primary": hex string,
    "secondary": hex string,
    "accent": hex string,
    "background": hex string (dark, suitable for POS)
  },
  "visual_style": [2-4 words, e.g. "cinematic", "minimal", "rustic", "luxury"],
  "mood": [2-4 words, e.g. "warm", "energetic", "premium", "playful"],
  "textures": [1-3 words, e.g. "wood grain", "marble", "glass"],
  "imagery_keywords": [3-5 short visual phrases usable in image generation prompts],
  "lighting_style": [1-2 descriptors, e.g. "soft ambient", "golden hour", "neon glow"],
  "composition_style": [1-2 descriptors, e.g. "layered depth", "clean minimal"]
}`;

const DRAMATIC_INSTRUCTION = `
After extracting, internally enhance the tokens to be more visually dramatic and suitable for high-impact POS demo backgrounds:
- Increase contrast in mood and style descriptors
- Make imagery_keywords more cinematic and vivid (e.g. "coastal dock" → "weathered dock pilings at golden hour, bokeh water reflections")
- Keep them aligned with the original brand identity but amplify them for visual impact
`;

async function extractTokensFromText(text: string): Promise<object> {
  const msg = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: `You are a brand visual analyst. Extract design tokens from this website content and return ONLY valid JSON matching this schema exactly:

${TOKEN_SCHEMA}
${DRAMATIC_INSTRUCTION}

WEBSITE CONTENT:
${text}

Return ONLY the JSON object, no markdown, no explanation.`,
      },
    ],
  });
  const raw = (msg.content[0] as { type: string; text: string }).text
    .replace(/```json?\n?/g, "")
    .replace(/```\n?/g, "")
    .trim();
  return JSON.parse(raw);
}

async function extractTokensFromImage(
  source: ImageBlockParam["source"],
): Promise<object> {
  const msg = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source },
          {
            type: "text",
            text: `You are a brand visual analyst. Analyze this restaurant/brand image and extract design tokens. Return ONLY valid JSON matching this schema exactly:

${TOKEN_SCHEMA}
${DRAMATIC_INSTRUCTION}

Focus on: dominant colors, textures visible, lighting quality, mood/atmosphere, visual style.
Return ONLY the JSON object, no markdown, no explanation.`,
          },
        ],
      },
    ],
  });
  const raw = (msg.content[0] as { type: string; text: string }).text
    .replace(/```json?\n?/g, "")
    .replace(/```\n?/g, "")
    .trim();
  return JSON.parse(raw);
}

// ── Prompt builders ───────────────────────────────────────────────────────────

function buildBackgroundPrompt(t: Record<string, unknown>): string {
  const palette = (t.color_palette as Record<string, string>) ?? {};
  const mood = (t.mood as string[] ?? []).join(", ");
  const style = (t.visual_style as string[] ?? []).join(", ");
  const lighting = (t.lighting_style as string[] ?? []).join(", ");
  const textures = (t.textures as string[] ?? []).join(", ");
  const keywords = (t.imagery_keywords as string[] ?? []).join("; ");
  const composition = (t.composition_style as string[] ?? []).join(", ");

  return (
    `Cinematic POS background for ${t.brand_name ?? "restaurant"} (${t.industry ?? "dining"}). ` +
    `Color story: ${palette.primary} primary, ${palette.accent} accent, deep ${palette.background} base. ` +
    `Mood: ${mood}. Visual style: ${style}. ` +
    `Lighting: ${lighting}. Textures to suggest: ${textures}. ` +
    `Composition: ${composition}. ` +
    `Key imagery to evoke (blurred, atmospheric): ${keywords}. ` +
    `Center area kept dark and low-contrast for UI readability. Soft color blooms at edges and corners. ` +
    `Cinematic shallow depth-of-field. No text, no faces, no sharp subjects.`
  );
}

function buildSidebarPrompt(t: Record<string, unknown>): string {
  const palette = (t.color_palette as Record<string, string>) ?? {};
  const mood = (t.mood as string[] ?? []).join(", ");
  const style = (t.visual_style as string[] ?? []).join(", ");
  const keywords = (t.imagery_keywords as string[] ?? []).slice(0, 3).join("; ");

  return (
    `Vertical sidebar panel for ${t.brand_name ?? "restaurant"} POS (${t.industry ?? "dining"}). ` +
    `Bold brand colors: ${palette.primary} and ${palette.accent} on ${palette.background} base. ` +
    `Style: ${style}. Mood: ${mood}. ` +
    `Rich, saturated vertical composition — this is the visual showcase strip. ` +
    `Imagery: ${keywords}. ` +
    `High contrast, brand-forward, geometric depth. Narrow portrait format (360×696).`
  );
}

// ── Route ─────────────────────────────────────────────────────────────────────

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      url?: string;
      imageBase64?: string;
      imageMediaType?: string;
      restaurantName?: string;
    };
    const { url, imageBase64, imageMediaType, restaurantName } = body;

    let tokens: Record<string, unknown>;

    if (imageBase64 && imageMediaType) {
      // Uploaded image → vision
      tokens = (await extractTokensFromImage({
        type: "base64",
        media_type: imageMediaType as
          | "image/jpeg"
          | "image/png"
          | "image/webp"
          | "image/gif",
        data: imageBase64,
      })) as Record<string, unknown>;
    } else if (url && isImageUrl(url)) {
      // Image URL → vision
      tokens = (await extractTokensFromImage({
        type: "url",
        url,
      })) as Record<string, unknown>;
    } else if (url) {
      // Website URL → scrape + text analysis
      const text = await fetchWebsiteText(url);
      tokens = (await extractTokensFromText(text)) as Record<string, unknown>;
    } else {
      return Response.json(
        { error: "Provide url or imageBase64+imageMediaType" },
        { status: 400 },
      );
    }

    // Override brand name if restaurant name is known
    if (restaurantName) tokens.brand_name = restaurantName;

    return Response.json({
      tokens,
      background_prompt: buildBackgroundPrompt(tokens),
      sidebar_prompt: buildSidebarPrompt(tokens),
    });
  } catch (err: unknown) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}
