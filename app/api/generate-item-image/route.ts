import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

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
    if (!svgMatch) {
      return Response.json(
        { error: "No SVG found in response", raw: text.slice(0, 500) },
        { status: 500 },
      );
    }

    const svg = svgMatch[0];

    return Response.json({
      svg,
      itemName,
      usage: {
        input_tokens: msg.usage.input_tokens,
        output_tokens: msg.usage.output_tokens,
      },
    });
  } catch (error: unknown) {
    return Response.json(
      { error: (error as Error).message },
      { status: 500 },
    );
  }
}
