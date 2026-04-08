import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

export async function POST(request: Request) {
  try {
    const { restaurantName, restaurantType, groups, type, styleHints } =
      (await request.json()) as {
        restaurantName?: string;
        restaurantType?: string;
        groups?: string[];
        type: "sidebar" | "background" | "palette";
        styleHints?: string;
      };

    const context = [
      restaurantName && `Restaurant: ${restaurantName}`,
      restaurantType && `Type: ${restaurantType}`,
      groups?.length && `Menu groups: ${groups.join(", ")}`,
      styleHints && `Style notes: ${styleHints}`,
    ]
      .filter(Boolean)
      .join("\n");

    // --- Palette: return JSON color recommendations ---
    if (type === "palette") {
      const msg = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1024,
        messages: [
          {
            role: "user",
            content: `You are a restaurant branding expert. Based on the following restaurant info, recommend a color palette for their POS (point of sale) terminal.

${context}

Return a JSON object with these exact keys:
- background: dark hex color for the main POS background (must be very dark, e.g. #0f172a, #1a1a2e)
- buttons_background_color: hex color for service buttons (Dine In, Pick Up, Take Out, Bar, Delivery) — should be vibrant and match the restaurant's vibe
- buttons_font_color: hex color for button text — must contrast well with buttons_background_color

Rules:
- Background MUST be very dark (luminance < 15%) — POS terminals need dark backgrounds for readability
- Button color should evoke the cuisine/brand (e.g. red for BBQ/pizza, green for healthy/organic, warm amber for bakery)
- If style notes mention specific colors or moods, prioritize those
- Return ONLY valid JSON, no markdown or explanation.`,
          },
        ],
      });

      const text = msg.content[0].type === "text" ? msg.content[0].text : "";
      let palette;
      try {
        const jsonStr = text.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
        palette = JSON.parse(jsonStr);
      } catch {
        return Response.json(
          { error: "Failed to parse palette", raw: text },
          { status: 500 },
        );
      }

      return Response.json({
        palette,
        type: "palette",
        usage: {
          input_tokens: msg.usage.input_tokens,
          output_tokens: msg.usage.output_tokens,
        },
      });
    }

    // --- HTML/CSS generation (sidebar or background) ---
    // We generate styled HTML that the client renders to a canvas and rasterizes to PNG.
    const prompt =
      type === "sidebar"
        ? `Create an HTML snippet for a POS sidebar banner. It will be rendered at exactly 70px wide × 600px tall and rasterized to PNG.

${context}

Requirements:
- Return a single <div> with inline styles only (no external CSS, no <style> tags, no classes)
- The div must have: width:70px; height:600px; overflow:hidden;
- Use CSS gradients, geometric shapes (nested divs with border-radius, transforms), and layered effects
- Dark theme: deep navy, charcoal, or rich dark color as the base
- Subtle food/culinary motifs relevant to the restaurant type — abstract shapes, not literal pictures
- Colors should feel branded and premium
- NO text, NO words, NO labels
- Use only inline CSS — position:absolute elements inside are fine
- Make it visually interesting with layered gradients, shapes, or patterns

Return ONLY the HTML div element, no explanation, no markdown fences.`
        : `Create an HTML snippet for a POS main screen background. It will be rendered at exactly 800px wide × 600px tall and rasterized to PNG.

${context}

Requirements:
- Return a single <div> with inline styles only (no external CSS, no <style> tags, no classes)
- The div must have: width:800px; height:600px; overflow:hidden; position:relative;
- Very subtle, low-contrast design — POS buttons and text must stay readable over this
- Dark base color (#0f172a, #0d1117, or similar very dark color)
- Abstract geometric patterns, subtle food/culinary motifs at very low opacity (5–15%)
- Use CSS shapes, gradients, and layered divs for visual interest
- Professional, modern restaurant aesthetic
- NO text, NO words

Return ONLY the HTML div element, no explanation, no markdown fences.`;

    const msg = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    });

    const text =
      msg.content[0].type === "text" ? msg.content[0].text : "";

    // Extract the div from response
    const htmlMatch = text.match(/<div[\s\S]*<\/div>/);
    if (!htmlMatch) {
      return Response.json(
        { error: "No HTML found in response", raw: text.slice(0, 500) },
        { status: 500 },
      );
    }

    return Response.json({
      html: htmlMatch[0],
      type,
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
