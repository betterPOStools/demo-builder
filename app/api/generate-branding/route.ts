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
    // Ask for raw HTML (style block + div) — no JSON wrapper to avoid CSS escaping issues.
    const prompt =
      type === "sidebar"
        ? `You are an expert CSS visual designer. Create a richly layered sidebar banner for a restaurant POS terminal.

${context}

CANVAS: exactly 360px wide × 696px tall. Will be rasterized to PNG by html2canvas.

OUTPUT: Return a <style> block followed immediately by a single root <div>. No JSON, no markdown, no explanation — raw HTML only.

CSS CONSTRAINTS (html2canvas):
- No @import, no external url() — system fonts only (Georgia, Arial, Helvetica, Verdana)
- Gradients, box-shadow, border-radius, clip-path, transform, opacity all work
- NO ::before / ::after — html2canvas does not reliably capture pseudo-elements

DESIGN:
- Root: <div class="sb-root"> with CSS: width:360px; height:696px; overflow:hidden; position:relative; background: <dark base color>
- Dark, rich base — deep navy, charcoal, dark burgundy, espresso
- 4–6 child divs creating layered depth: gradient fills, glows, geometric shapes, diagonal cuts
- Accent color tied to cuisine vibe (amber for Italian, deep red for steakhouse, teal for seafood)
- Vertical rhythm top-to-bottom through the narrow column
- Abstract motifs: circles (border-radius:50%), diagonal panels (clip-path:polygon()), arcs — no literal images
- NO text, NO words

TECHNIQUES:
- radial-gradient glows off-center
- repeating-linear-gradient diagonal stripes at 3–8% opacity
- clip-path:polygon() for angled panels
- box-shadow with large blur for halos
- Overlapping circles at low opacity (10–25%)

Example structure:
<style>
.sb-root { width:360px; height:696px; overflow:hidden; position:relative; background:linear-gradient(180deg,#0f172a,#1e1b4b); }
.sb-glow { position:absolute; width:400px; height:400px; border-radius:50%; background:radial-gradient(circle,rgba(99,102,241,0.18),transparent 70%); top:-80px; left:-80px; }
/* more rules... */
</style>
<div class="sb-root">
  <div class="sb-glow"></div>
  <!-- more layers -->
</div>`
        : `You are an expert CSS visual designer. Create a richly layered background for a restaurant POS terminal's main screen.

${context}

CANVAS: exactly 1024px wide × 716px tall. Will be rasterized to PNG by html2canvas.

OUTPUT: Return a <style> block followed immediately by a single root <div>. No JSON, no markdown, no explanation — raw HTML only.

CSS CONSTRAINTS (html2canvas):
- No @import, no external url() — system fonts only
- Gradients, box-shadow, border-radius, clip-path, transform, opacity all work
- NO ::before / ::after — html2canvas does not reliably capture pseudo-elements

DESIGN:
- Root: <div class="bg-root"> with CSS: width:1024px; height:716px; overflow:hidden; position:relative; background: <very dark base>
- VERY SUBTLE — POS buttons and text sit on top. Decorative layers max 8–12% opacity.
- Dark base: #0f172a, #0d1117, or similar
- 6–8 child divs at varying low opacities for richness
- Large-scale composition — few big shapes, not many small ones
- Geometric: circles, arcs, diagonal panels, overlapping rings
- NO text of any kind

TECHNIQUES:
- Large radial-gradient "light source" off one corner (opacity 0.06–0.10)
- Diagonal panels via clip-path:polygon() at 2–4% opacity
- Overlapping large circles with gradient fills at very low opacity
- repeating-linear-gradient fine texture at 2–3% opacity
- Inset box-shadow vignette on the root div

Example structure:
<style>
.bg-root { width:1024px; height:716px; overflow:hidden; position:relative; background:#0f172a; box-shadow:inset 0 0 120px rgba(0,0,0,0.6); }
.bg-glow { position:absolute; width:800px; height:800px; border-radius:50%; background:radial-gradient(circle,rgba(99,102,241,0.07),transparent 65%); top:-200px; right:-200px; }
/* more rules... */
</style>
<div class="bg-root">
  <div class="bg-glow"></div>
  <!-- more layers -->
</div>`;

    const msg = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      messages: [{ role: "user", content: prompt }],
    });

    const text =
      msg.content[0].type === "text" ? msg.content[0].text : "";

    // Strip markdown fences if present, then extract <style>...<div>...</div>
    const stripped = text.replace(/```html?\n?/g, "").replace(/```\n?/g, "").trim();
    const htmlMatch = stripped.match(/(<style>[\s\S]*?<\/style>\s*)?(<div[\s\S]*<\/div>)/);
    if (!htmlMatch) {
      return Response.json(
        { error: "No HTML found in response", raw: text.slice(0, 500) },
        { status: 500 },
      );
    }

    const combined = (htmlMatch[1] ?? "") + htmlMatch[2];

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
