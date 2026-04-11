import Anthropic from "@anthropic-ai/sdk";
import { extractConceptTags, extractFoodCategory } from "@/lib/itemTags";

const client = new Anthropic();

export const maxDuration = 60;

// ─── fal.ai — Recraft V3 icon ─────────────────────────────────────────────────

async function generateViaRecraft(
  itemName: string,
  groupName?: string,
  restaurantType?: string,
  styleHints?: string,
  recraftStyle: "vector_illustration" | "digital_illustration" = "vector_illustration",
): Promise<string> {
  const falKey = process.env.FAL_KEY;
  if (!falKey) throw new Error("FAL_KEY not set");

  // Keep the prompt tight — Recraft's icon style responds better to concise,
  // noun-focused descriptions. Adding too much context pulls it toward
  // illustration territory instead of clean icon output.
  const category = groupName ? ` ${groupName.toLowerCase()}` : "";
  const extra = styleHints ? `, ${styleHints}` : "";
  const prompt =
    `${itemName}${category}, vector illustration, clean bold shapes, ` +
    `vivid colors, centered composition, transparent background, ` +
    `no text, no labels${extra}`;

  // suppress unused warning — restaurantType reserved for future prompt use
  void restaurantType;

  const res = await fetch("https://fal.run/fal-ai/recraft-v3", {
    method: "POST",
    headers: {
      Authorization: `Key ${falKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prompt,
      style: recraftStyle,
      image_size: { width: 512, height: 512 },
      output_format: "png", // PNG preserves the alpha/transparency channel
    }),
    signal: AbortSignal.timeout(45000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Recraft HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = (await res.json()) as { images?: { url: string }[] };
  const imageUrl = data.images?.[0]?.url;
  if (!imageUrl) throw new Error("No image URL in Recraft response");

  // Download and convert to data URI
  const imgRes = await fetch(imageUrl, { signal: AbortSignal.timeout(15000) });
  if (!imgRes.ok) throw new Error(`Image download failed: HTTP ${imgRes.status}`);
  const arrayBuffer = await imgRes.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString("base64");
  const contentType = imgRes.headers.get("content-type") || "image/png";
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
    const { itemName, groupName, restaurantType, styleHints, recraftStyle } =
      (await request.json()) as {
        itemName: string;
        groupName?: string;
        restaurantType?: string;
        styleHints?: string;
        recraftStyle?: "vector_illustration" | "digital_illustration";
      };

    if (!itemName) {
      return Response.json({ error: "itemName is required" }, { status: 400 });
    }

    const conceptTags = extractConceptTags(itemName, groupName, restaurantType);
    const foodCategory = extractFoodCategory(groupName);
    const cuisineType = restaurantType?.toLowerCase() || "general";

    // Try Recraft V3 first, fall back to Claude SVG
    try {
      const dataUri = await generateViaRecraft(itemName, groupName, restaurantType, styleHints, recraftStyle);
      return Response.json({
        dataUri,
        itemName,
        source: "recraft",
        conceptTags,
        foodCategory,
        cuisineType,
        generatedFor: undefined,
      });
    } catch (recraftErr) {
      console.warn("Recraft generation failed, falling back to Claude SVG:", (recraftErr as Error).message);
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
