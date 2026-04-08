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
    // Rendered client-side via html2canvas — no external fonts or images (CORS blocked).
    // CSS classes via <style> tag work fine; pseudo-elements (::before/::after) work too.
    const prompt =
      type === "sidebar"
        ? `You are an expert CSS visual designer. Create a richly layered sidebar banner for a restaurant POS terminal.

${context}

CANVAS: exactly 360px wide × 696px tall. Will be rasterized to PNG by html2canvas.

OUTPUT FORMAT — return a JSON object with two keys:
{
  "css": "/* all CSS here — use classes, ::before, ::after, complex selectors */",
  "html": "<div class=\\"sb-root\\"><!-- child divs using your classes --></div>"
}

CSS RULES (html2canvas constraints):
- NO external resources — no @import, no url() pointing to fonts or images
- System fonts only if needed: Georgia, Palatino, Arial, Helvetica, Verdana, -apple-system
- CSS gradients, box-shadow, border-radius, clip-path, transform, opacity all work
- ::before and ::after pseudo-elements work — use them for layered effects
- CSS variables (--var) work

DESIGN REQUIREMENTS:
- Root element: .sb-root { width:360px; height:696px; overflow:hidden; position:relative; }
- Dark, rich base — deep navy (#0f172a), charcoal (#1a1a2e), dark burgundy, espresso, etc.
- Build DEPTH with 4–8 layered elements: gradient fills, soft glows, geometric shapes, diagonal cuts
- Accent colors should reflect the cuisine vibe (warm amber for Italian, deep red for steakhouse, teal for seafood, etc.)
- Vertical rhythm — elements should flow top-to-bottom through the narrow column
- Abstract culinary motifs at low opacity: circular shapes like plates, diagonal slashes like knife cuts, arc shapes like bowls — all CSS-only, no literal images
- NO text, NO words, NO labels

TECHNIQUE IDEAS (use several):
- radial-gradient glows positioned off-center
- Thin diagonal stripes via repeating-linear-gradient at very low opacity (3-8%)
- Circle/oval shapes (border-radius:50%) with gradient fills, partially clipped
- clip-path: polygon() for angled cuts and geometric panels
- ::before/::after for layered pseudo-elements that don't require extra markup
- box-shadow with large blur for soft glowing halos

Return ONLY the JSON object, no markdown fences, no explanation.`
        : `You are an expert CSS visual designer. Create a richly layered background for a restaurant POS terminal's main screen.

${context}

CANVAS: exactly 1024px wide × 716px tall. Will be rasterized to PNG by html2canvas.

OUTPUT FORMAT — return a JSON object with two keys:
{
  "css": "/* all CSS here — use classes, ::before, ::after, complex selectors */",
  "html": "<div class=\\"bg-root\\"><!-- child divs using your classes --></div>"
}

CSS RULES (html2canvas constraints):
- NO external resources — no @import, no url() pointing to fonts or images
- System fonts only if any text is needed
- CSS gradients, box-shadow, border-radius, clip-path, transform, opacity all work
- ::before and ::after pseudo-elements work — use them for layered effects
- CSS variables (--var) work

DESIGN REQUIREMENTS:
- Root element: .bg-root { width:1024px; height:716px; overflow:hidden; position:relative; }
- VERY SUBTLE overall — POS menu buttons and text will sit on top. Decorative elements max 8–12% opacity.
- Dark base: #0f172a, #0d1117, #111827, or a dark tinted version appropriate to the cuisine
- Build richness with 6–10 layered elements at varying low opacities
- Large-scale composition — few large shapes rather than many small ones
- Geometric language: circles, arcs, diagonal panels, overlapping rings
- Accent color echoes the restaurant's vibe at very low opacity
- NO text of any kind

TECHNIQUE IDEAS (use most of these):
- A large radial-gradient "light source" off one corner, very subtle (opacity 0.06–0.10)
- Diagonal panel dividers via clip-path: polygon() at 2–4% opacity
- Overlapping large circles (border-radius:50%) with gradient fills, very low opacity
- repeating-linear-gradient for fine diagonal grid or stripe texture at 2–3% opacity
- ::before/::after for extra layers without extra markup
- A soft vignette (inset box-shadow) on the root element

Return ONLY the JSON object, no markdown fences, no explanation.`;

    const msg = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      messages: [{ role: "user", content: prompt }],
    });

    const text =
      msg.content[0].type === "text" ? msg.content[0].text : "";

    // Parse JSON response { css, html }
    let css = "";
    let html = "";
    try {
      const jsonStr = text.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
      const start = jsonStr.indexOf("{");
      const end = jsonStr.lastIndexOf("}");
      const parsed = JSON.parse(jsonStr.slice(start, end + 1));
      css = parsed.css ?? "";
      html = parsed.html ?? "";
    } catch {
      // Fallback: try to extract a raw div if the model ignored the JSON format
      const divMatch = text.match(/<div[\s\S]*<\/div>/);
      if (!divMatch) {
        return Response.json(
          { error: "No HTML found in response", raw: text.slice(0, 500) },
          { status: 500 },
        );
      }
      html = divMatch[0];
    }

    // Combine into a single HTML string: <style> + markup
    const combined = css ? `<style>${css}</style>${html}` : html;

    return Response.json({
      html: combined,
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
