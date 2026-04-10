import Anthropic from "@anthropic-ai/sdk";
import { extractConceptTags, extractFoodCategory } from "@/lib/itemTags";

const client = new Anthropic();

export const maxDuration = 60;

// ─── fal.ai — FLUX Schnell (primary) ─────────────────────────────────────────

async function generateViaFal(
  itemName: string,
  groupName?: string,
  restaurantType?: string,
  styleHints?: string,
  negativePrompt?: string,
): Promise<string> {
  const falKey = process.env.FAL_KEY;
  if (!falKey) throw new Error("FAL_KEY not set");

  const context = [
    restaurantType && `${restaurantType} restaurant`,
    groupName && `${groupName} category`,
  ]
    .filter(Boolean)
    .join(", ");

  const style = styleHints ? `, ${styleHints}` : "";
  const prompt =
    `Food photography of ${itemName}` +
    (context ? `, ${context}` : "") +
    `, clean neutral dark background, studio lighting, appetizing close-up, square composition, no text, no labels${style}`;

  const res = await fetch("https://fal.run/fal-ai/flux/schnell", {
    method: "POST",
    headers: {
      Authorization: `Key ${falKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prompt,
      ...(negativePrompt ? { negative_prompt: negativePrompt } : {}),
      image_size: { width: 512, height: 512 },
      num_inference_steps: 4,
      safety_tolerance: "5",
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`fal HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = (await res.json()) as { images?: { url: string }[] };
  const imageUrl = data.images?.[0]?.url;
  if (!imageUrl) throw new Error("No image URL in fal response");

  // Download and convert to data URI
  const imgRes = await fetch(imageUrl, { signal: AbortSignal.timeout(15000) });
  if (!imgRes.ok) throw new Error(`Image download failed: HTTP ${imgRes.status}`);
  const arrayBuffer = await imgRes.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString("base64");
  const contentType = imgRes.headers.get("content-type") || "image/webp";
  return `data:${contentType};base64,${base64}`;
}

// ─── Claude Haiku — SVG fallback ─────────────────────────────────────────────

async function generateViaClaude(
  itemName: string,
  groupName?: string,
  restaurantType?: string,
  styleHints?: string,
): Promise<string> {
  const context = [
    `Menu item: ${itemName}`,
    groupName && `Group: ${groupName}`,
    restaurantType && `Restaurant type: ${restaurantType}`,
    styleHints && `Style: ${styleHints}`,
  ]
    .filter(Boolean)
    .join("\n");

  const msg = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content: `Create an SVG icon for a POS (point of sale) menu item button. The icon should be 90x90px.

${context}

Requirements:
- Transparent background — NO background rect, NO filled rectangle behind the icon
- Simple, flat-design food/drink icon that works on both light and dark button colors
- The food/drink should be clearly recognizable at small sizes
- Use bold, clean shapes — no fine details (this renders at 90x90px on screen)
- 2-3 bright/vivid colors for the icon itself (avoid very dark colors — must show on dark POS buttons)
- White or light outlines/strokes on elements so the icon is visible on dark buttons
- No text, labels, or words
- Icon should fill most of the 90x90 canvas with some padding
- Style: modern, minimal, slightly stylized (not photorealistic)
- The SVG root element must NOT have a background-color style or a filled rect covering the whole canvas

Return ONLY the SVG code, no explanation.`,
      },
    ],
  });

  const text = msg.content[0].type === "text" ? msg.content[0].text : "";
  const svgMatch = text.match(/<svg[\s\S]*?<\/svg>/);
  if (!svgMatch) throw new Error("No SVG found in Claude response");
  return svgMatch[0];
}

// ─── Route ────────────────────────────────────────────────────────────────────

export async function POST(request: Request) {
  try {
    const { itemName, groupName, restaurantType, styleHints } =
      (await request.json()) as {
        itemName: string;
        groupName?: string;
        restaurantType?: string;
        styleHints?: string;
      };

    if (!itemName) {
      return Response.json({ error: "itemName is required" }, { status: 400 });
    }

    const conceptTags = extractConceptTags(itemName, groupName, restaurantType);
    const foodCategory = extractFoodCategory(groupName);
    const cuisineType = restaurantType?.toLowerCase() || "general";

    // Try fal first, fall back to Claude SVG
    try {
      const dataUri = await generateViaFal(itemName, groupName, restaurantType, styleHints);
      return Response.json({
        dataUri,
        itemName,
        source: "fal",
        conceptTags,
        foodCategory,
        cuisineType,
        generatedFor: undefined,
      });
    } catch (falErr) {
      console.warn("fal generation failed, falling back to Claude SVG:", (falErr as Error).message);
    }

    // Claude SVG fallback
    const svg = await generateViaClaude(itemName, groupName, restaurantType, styleHints);
    return Response.json({
      svg,
      itemName,
      source: "claude",
      conceptTags,
      foodCategory,
      cuisineType,
      generatedFor: undefined,
    });
  } catch (error: unknown) {
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}
