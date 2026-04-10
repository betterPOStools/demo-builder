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
  "composition_style": [1-2 descriptors, e.g. "layered depth", "clean minimal"],
  "textureWords": [2-4 short physical material descriptors that could be surfaces — e.g. "weathered cedar", "rough-cast plaster", "woven linen", "river stone"],
  "lightingDescription": string (one sentence describing light quality and direction — e.g. "Late afternoon sun raking at a low angle across rough surfaces, casting long warm shadows"),
  "dominantAtmosphere": exactly one of: "warm" | "cool" | "neutral" | "dramatic" | "soft",
  "flux_scene_prompt": string — a single richly detailed scene description for FLUX Pro. Cinematic photography language. Include: physical setting with specific materials and surfaces, lighting quality/direction/color temperature, atmosphere and mood in sensory terms, camera/composition feel. CRITICAL COMPOSITION: place the main subject and focal interest in the RIGHT 70% of the frame — the leftmost 30% will be covered by a sidebar panel in the POS layout, so only supporting texture/shadow should occupy that zone. End with: "no text, no UI elements, atmospheric only". Example: "Tight overhead shot of sizzling carne asada on a blackened cast iron comal positioned right of center, amber kitchen spotlight cutting through rising smoke, dark rough-hewn wood fills left edge into shadow, shallow depth of field, warm crimson shadows, no text, atmospheric only",
  "flux_sidebar_prompt": string — same format as flux_scene_prompt but composed for a narrow vertical surface. Same physical world as flux_scene_prompt — same light source, same materials — but framed as a vertical architectural detail rather than a hero food shot. Example: "Vertical close-up of weathered mesquite wood planking with dried chili ristras casting long shadows, amber sidelight from off-frame, dark moody background, no text, portrait orientation",
  "negative_prompt": string — what to explicitly avoid, written as a Stable Diffusion negative prompt string. Should capture what would look wrong for this specific brand. Example: "geometric patterns, hexagons, gradients, flat design, corporate, sterile, bright white, neon, digital artifacts, blurry text"
}`;

const DRAMATIC_INSTRUCTION = `
After extracting, internally enhance the tokens to be more visually dramatic and suitable for high-impact POS demo backgrounds:
- Increase contrast in mood and style descriptors
- Make imagery_keywords more cinematic and vivid (e.g. "coastal dock" → "weathered dock pilings at golden hour, bokeh water reflections")
- For textureWords: describe physical surfaces you can touch — grain, roughness, temperature. Be specific (not "rustic" but "rough-hewn cedar plank" or "cracked terracotta").
- For lightingDescription: describe WHERE the light comes from, its COLOR temperature, and what SHADOWS it casts. One evocative sentence.
- For dominantAtmosphere: choose the single word that best captures the overall emotional register.
- Keep all enhancements aligned with the original brand identity.

For the fal/image-generation fields, write as a professional prompt engineer targeting Stable Diffusion / FLUX Pro. These prompts will be sent directly to image generation models — be specific, sensory, and cinematic. Avoid abstract adjectives like "vibrant", "dynamic", "modern" — describe physical reality instead:
- flux_scene_prompt: A hero shot of the cuisine/brand environment. Specific materials, specific light source, specific camera angle. End with "no text, no UI elements, atmospheric only".
- flux_sidebar_prompt: The same physical world as flux_scene_prompt but reframed as a narrow vertical architectural detail — a wall, a surface, a doorway edge, a texture strip. Same light, same materials, portrait framing. End with "no text, portrait orientation".
- negative_prompt: List specific visual elements that would be tonally wrong for this brand. Concrete nouns and styles, not generic terms.
`;

async function extractTokensFromText(text: string): Promise<object> {
  const msg = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: `You are a brand visual analyst and professional image generation prompt engineer. Extract design tokens from this website content and return ONLY valid JSON matching this schema exactly:

${TOKEN_SCHEMA}
${DRAMATIC_INSTRUCTION}

For textureWords: infer physical materials from the cuisine type, brand name, and any visual language used on the site. A seafood restaurant implies weathered dock wood, sea-worn rope, raw oyster shell. An Italian trattoria implies worn terracotta, linen tablecloth, rough stone wall. Be specific and tactile.
For lightingDescription: infer from the cuisine's natural environment and time-of-day associations. A rooftop bar suggests golden hour sun. A dim sum restaurant suggests warm lantern light. Write one evocative sentence.
For dominantAtmosphere: based on the overall brand personality and cuisine.
For flux_scene_prompt / flux_sidebar_prompt / negative_prompt: write as a professional FLUX Pro / Stable Diffusion prompt engineer — physical, specific, cinematic. No abstract adjectives.

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
            text: `You are a brand visual analyst and professional image generation prompt engineer. Analyze this restaurant/brand image and extract design tokens. Return ONLY valid JSON matching this schema exactly:

${TOKEN_SCHEMA}
${DRAMATIC_INSTRUCTION}

Extraction focus:
- color_palette: sample the dominant dark tone for background, the most prominent mid-tone for primary, a vibrant supporting tone for secondary, the brightest accent color for accent
- textureWords: describe the physical surfaces and materials you can actually see or strongly infer — be specific and tactile (e.g. "smoked cedar planks", "poured concrete counter", "woven seagrass")
- lightingDescription: describe exactly where the light comes from, its color temperature (warm/cool/neutral), and what shadows or highlights it creates. One vivid sentence.
- dominantAtmosphere: the single emotional register of the image
- flux_scene_prompt / flux_sidebar_prompt / negative_prompt: write as a professional FLUX Pro / Stable Diffusion prompt engineer — physical, specific, cinematic. Base these directly on what you can see in the image.
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

    console.log("=== ANALYZE-BRAND OUTPUT ===", JSON.stringify(tokens, null, 2));
    return Response.json({ tokens });
  } catch (err: unknown) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}
