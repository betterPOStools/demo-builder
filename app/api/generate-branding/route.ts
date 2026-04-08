import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

export async function POST(request: Request) {
  try {
    const { restaurantName, restaurantType, groups, type, styleHints } =
      (await request.json()) as {
        restaurantName?: string;
        restaurantType?: string;
        groups?: string[];
        type: "sidebar" | "background" | "palette" | "unified";
        styleHints?: string;
      };

    // Extract "Quoted Title" from styleHints → renders as text in sidebar
    const titleMatch = styleHints?.match(/"([^"]+)"/);
    const displayTitle = titleMatch?.[1]?.trim() ?? null;
    const cleanedHints = styleHints
      ?.replace(/"[^"]*"/g, "")
      .replace(/,\s*,/g, ",")
      .trim() || undefined;

    const context = [
      restaurantName && `Restaurant: ${restaurantName}`,
      restaurantType && `Type: ${restaurantType}`,
      groups?.length && `Menu groups: ${groups.join(", ")}`,
      cleanedHints && `Style notes: ${cleanedHints}`,
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

    // --- Unified: one seamless 1384×716 composition (sidebar + background joined) ---
    if (type === "unified") {
      const titleInstruction = displayTitle
        ? `SIDEBAR TITLE: Render "${displayTitle}" as large display text in the left 360px zone.
- Choose a Google Font that matches the cuisine/vibe and @import it
- Font size 52–68px, bold or display weight
- Position: lower-third or vertically centered
- Add text-shadow (2–4px blur, dark) so it reads against any background
- Color: white or a bright accent — must be legible`
        : `NO text, NO words anywhere in the design.`;

      const unifiedPrompt = `You are an expert CSS visual designer. Create a single seamless full-screen background for a restaurant POS terminal.

${context}

CANVAS: exactly 1384px wide × 716px tall. Rasterized to PNG, then split:
- LEFT 360px  → sidebar strip (portrait, decorative chrome)
- RIGHT 1024px → main background (POS buttons and menu items sit on top)

OUTPUT: Return a <style> block followed immediately by a single root <div>. No JSON, no markdown — raw HTML only.

FONTS: You may @import any Google Font. Pick one that fits the cuisine.
Font guide:
- Upscale/fine dining: Playfair Display, Cormorant Garamond
- BBQ/Southern: Oswald, Arvo
- Seafood/Coastal: Raleway, Quicksand
- Italian: Libre Baskerville, Lato
- Mexican/Latin: Montserrat, Nunito
- Bakery/Café: Pacifico, Josefin Sans
- Modern American: Bebas Neue, Roboto Slab

${titleInstruction}

CSS CONSTRAINTS:
- NO ::before / ::after — not reliably captured
- Use child divs for all layers
- Gradients, box-shadow, border-radius, clip-path, transform, opacity all work

DESIGN:
- Root: <div class="u-root"> — width:1384px; height:716px; overflow:hidden; position:relative
- Derive colors boldly from the restaurant type — saturated, vivid, brand-appropriate
- LEFT 360px: rich, saturated showcase zone. Large shapes at 40–70% opacity. This is the visual centerpiece.
- RIGHT 1024px: same color family but much darker and more subdued. POS UI sits on top so keep decorative layers below 15–20% opacity on this side.
- The seam at x=360 must be INVISIBLE — use gradients that flow naturally across it
- A base gradient spanning the full 1384px anchors the composition

STRUCTURE:
1. Full-width base gradient (the foundation)
2. 2–4 bold decorative shapes concentrated in the LEFT zone (circles, diagonal panels, arcs)
3. 1–2 very-low-opacity echo shapes extending into the RIGHT zone for continuity
4. Inset vignette on the right side to keep it dark for POS UI`;

      const msg = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 8192,
        messages: [{ role: "user", content: unifiedPrompt }],
      });

      const text = msg.content[0].type === "text" ? msg.content[0].text : "";
      const stripped = text.replace(/```html?\n?/g, "").replace(/```\n?/g, "").trim();
      const htmlMatch = stripped.match(/(<style>[\s\S]*?<\/style>\s*)?(<div[\s\S]*<\/div>)/);
      if (!htmlMatch) {
        return Response.json({ error: "No HTML found in response", raw: text.slice(0, 500) }, { status: 500 });
      }

      return Response.json({
        html: (htmlMatch[1] ?? "") + htmlMatch[2],
        type: "unified",
        usage: { input_tokens: msg.usage.input_tokens, output_tokens: msg.usage.output_tokens },
      });
    }

    // --- Sidebar ---
    if (type === "sidebar") {
      const titleInstruction = displayTitle
        ? `TITLE TEXT: Render "${displayTitle}" in the sidebar.
- @import the chosen Google Font and apply it to the title element
- Font size 52–68px, bold or display weight
- Position: lower-third (bottom 200px) or vertically centered — whichever suits the composition
- text-shadow: 0 2px 8px rgba(0,0,0,0.6) for legibility
- Color: white or a bright accent color that pops`
        : `NO text, NO words anywhere.`;

      const sidebarPrompt = `You are an expert CSS visual designer. Create a richly layered sidebar banner for a restaurant POS terminal.

${context}

CANVAS: exactly 360px wide × 696px tall. Rasterized to PNG by html2canvas.

OUTPUT: Return a <style> block followed immediately by a single root <div>. No JSON, no markdown — raw HTML only.

FONTS: @import any Google Font appropriate to the cuisine.
Font guide:
- Upscale/fine dining: Playfair Display, Cormorant Garamond
- BBQ/Southern: Oswald, Arvo
- Seafood/Coastal: Raleway, Quicksand
- Italian: Libre Baskerville, Lato
- Mexican/Latin: Montserrat, Nunito
- Bakery/Café: Pacifico, Josefin Sans
- Modern American: Bebas Neue, Roboto Slab

${titleInstruction}

CSS CONSTRAINTS:
- NO ::before / ::after — html2canvas limitation
- Gradients, box-shadow, border-radius, clip-path, transform, opacity all work

DESIGN:
- Root: <div class="sb-root"> — width:360px; height:696px; overflow:hidden; position:relative
- This is a SHOWCASE panel. Be bold, vivid, and cuisine-specific. Think: a brand poster compressed into a vertical strip.
- Derive colors from the restaurant type. Do not default to generic dark blue or purple.
  Examples: deep coral + ocean teal for seafood, charred black + ember orange for BBQ,
  cream + tomato red + basil green for Italian, sand + turquoise for coastal/beach
- 4–6 child divs creating layered depth
- Foreground shapes: large, at 40–70% opacity for visual punch
- Background texture: subtle repeating gradient at 5–10% opacity
- Geometric motifs: large circles (border-radius:50%), diagonal panels (clip-path:polygon()), arcs
- Vertical rhythm flowing top-to-bottom through the narrow column`;

      const msg = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 8192,
        messages: [{ role: "user", content: sidebarPrompt }],
      });

      const text = msg.content[0].type === "text" ? msg.content[0].text : "";
      const stripped = text.replace(/```html?\n?/g, "").replace(/```\n?/g, "").trim();
      const htmlMatch = stripped.match(/(<style>[\s\S]*?<\/style>\s*)?(<div[\s\S]*<\/div>)/);
      if (!htmlMatch) {
        return Response.json({ error: "No HTML found in response", raw: text.slice(0, 500) }, { status: 500 });
      }

      return Response.json({
        html: (htmlMatch[1] ?? "") + htmlMatch[2],
        type: "sidebar",
        usage: { input_tokens: msg.usage.input_tokens, output_tokens: msg.usage.output_tokens },
      });
    }

    // --- Background ---
    const backgroundPrompt = `You are an expert CSS visual designer. Create a richly layered background for a restaurant POS terminal's main screen.

${context}

CANVAS: exactly 1024px wide × 716px tall. Rasterized to PNG by html2canvas.

OUTPUT: Return a <style> block followed immediately by a single root <div>. No JSON, no markdown — raw HTML only.

CSS CONSTRAINTS:
- NO ::before / ::after — html2canvas limitation
- Gradients, box-shadow, border-radius, clip-path, transform, opacity all work

DESIGN:
- Root: <div class="bg-root"> — width:1024px; height:716px; overflow:hidden; position:relative
- POS buttons, item images, and text sit on top of this. Decorative layers should stay below 20% opacity so the UI remains readable.
- Dark base color — very dark variant of the cuisine accent color (not pure #0f172a every time — use a dark teal for seafood, dark charcoal-red for BBQ, dark espresso for Italian, etc.)
- 5–7 child divs at varying low opacities
- Large-scale composition — a few big shapes, not many small ones
- Geometric: large circles, arcs, diagonal panels — all at low opacity
- NO text of any kind
- Inset box-shadow vignette on the root for depth`;

    const msg = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      messages: [{ role: "user", content: backgroundPrompt }],
    });

    const text = msg.content[0].type === "text" ? msg.content[0].text : "";
    const stripped = text.replace(/```html?\n?/g, "").replace(/```\n?/g, "").trim();
    const htmlMatch = stripped.match(/(<style>[\s\S]*?<\/style>\s*)?(<div[\s\S]*<\/div>)/);
    if (!htmlMatch) {
      return Response.json(
        { error: "No HTML found in response", raw: text.slice(0, 500) },
        { status: 500 },
      );
    }

    return Response.json({
      html: (htmlMatch[1] ?? "") + htmlMatch[2],
      type: "background",
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
