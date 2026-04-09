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
      const titleCharLen = displayTitle?.length ?? 0;
      const titleFontSize = titleCharLen > 14 ? 36 : titleCharLen > 10 ? 44 : 56;

      const titleInstruction = displayTitle
        ? `SIDEBAR TITLE: Render "${displayTitle}" as large display text in the left 360px zone.
- Choose a Google Font that matches the cuisine/vibe and @import it
- Font size: ${titleFontSize}px, bold or display weight — MUST fit on ONE LINE, no wrapping
- Add white-space: nowrap and max-width: 340px; overflow: hidden to the title element
- Position: lower-third — bottom edge of text must be at least 48px from the bottom of the canvas
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

AESTHETIC DIRECTION:
Clean, minimal, professional — cinematic depth-of-field background. Soft, ambient, diffused lighting.
No sharp focal subjects. No clutter. Premium design aesthetic.

COMPOSITION:
- LEFT 360px (sidebar): richer color story — soft color blooms, gentle depth, more saturated palette
- RIGHT 1024px (POS main area): darker, low-contrast, uncluttered CENTER — POS buttons live here.
  Color interest stays at the right edge, fading toward the center.
- Seam at x=360 must be INVISIBLE — gradients flow naturally across it

TECHNIQUE — simulate soft depth-of-field with stacked radial gradients:
- Base: full-width atmospheric directional gradient from the cuisine's signature colors
- Color blooms: large oversized radial gradients (400–800px) at corners and edges, 30–60% opacity
  Concentrate bold blooms in the LEFT zone; echo them softly at the right edge
- Center of RIGHT zone: subtle dark radial overlay to keep it low-contrast for UI readability
- Vignette: inset box-shadow on root for cinematic framing

DESIGN:
- Root: <div class="u-root"> — width:1384px; height:716px; overflow:hidden; position:relative
- NO hard clip-path polygon shapes; use radial gradients and border-radius:50% blobs only
- 6–10 child divs: base gradient + color bloom divs + center-clear overlay + vignette
- What you generate is exactly what renders — no additional dimming applied at runtime

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
      const titleCharLen = displayTitle?.length ?? 0;
      const titleFontSize = titleCharLen > 14 ? 36 : titleCharLen > 10 ? 44 : 56;

      const titleInstruction = displayTitle
        ? `TITLE TEXT: Render "${displayTitle}" in the sidebar.
- @import the chosen Google Font and apply it to the title element
- Font size: ${titleFontSize}px, bold or display weight — MUST fit on ONE LINE, no wrapping
- Add white-space: nowrap to the title element so it never wraps
- Width constraint: max-width: 340px; overflow: hidden on the title element
- Position: lower-third — bottom edge of text must be at least 48px from the bottom of the canvas
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
    const backgroundPrompt = `You are an expert CSS visual designer. Create a soft, cinematic background for a restaurant POS terminal's main screen.

${context}

CANVAS: exactly 1024px wide × 716px tall. Rasterized to PNG by html2canvas.

OUTPUT: Return a <style> block followed immediately by a single root <div>. No JSON, no markdown — raw HTML only.

CSS CONSTRAINTS:
- NO ::before / ::after — html2canvas limitation
- NO clip-path polygons with sharp edges
- Radial gradients, box-shadow, border-radius, opacity all work

AESTHETIC DIRECTION:
Clean, minimal, professional — visually appealing but never competing with the POS UI that sits on top.
Think: premium hotel lobby, upscale restaurant ambiance, cinematic depth-of-field background photo.
Soft, ambient, diffused lighting. Gentle gradients. No sharp focal subject. No clutter.

COMPOSITION (critical — POS menu buttons and item cards overlay the center):
- CENTER: Dark, low-contrast, uncluttered. Muted tones so UI text is readable. No shapes here.
- EDGES & CORNERS: Slightly richer with soft color blooms, gentle depth — visual interest lives at the periphery.
- OVERALL: A soft radial vignette that darkens the center slightly while edges carry the color story.

TECHNIQUE — simulate shallow depth-of-field using stacked radial gradients:
- Base: a rich atmospheric directional gradient across the full canvas anchored to the cuisine's color identity
  Examples: deep ocean teal → midnight navy for seafood; charred mahogany → ember brown for BBQ;
  espresso → dark rosewood for Italian; desert sand → deep terracotta for Mexican
- Color blooms: 3–5 large oversized radial gradients (500–900px) positioned at corners and edges,
  NOT in the center. Use the cuisine's signature accent colors at 30–60% opacity — soft and diffused.
- Center clearing: a subtle dark radial gradient (transparent center → slight darkening) over the middle
  to keep it clean and low-contrast for UI readability.
- Depth vignette: inset box-shadow on root (rgba(0,0,0,0.45), 80–120px blur) for cinematic framing.

DESIGN:
- Root: <div class="bg-root"> — width:1024px; height:716px; overflow:hidden; position:relative
- NO text of any kind, no logos, no geometric hard shapes in center
- 5–8 child divs total: base gradient div + color bloom divs + center-clear div + vignette
- Each bloom div: position:absolute; border-radius:50%; background: radial-gradient(...)
- The result should feel like a blurred, atmospheric photo — soft, premium, inviting`;


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
