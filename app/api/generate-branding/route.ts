import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

export const maxDuration = 60;

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  "You are an expert frontend developer who writes atmospheric, tactile HTML/CSS. " +
  "You output ONLY a raw <style> block immediately followed by a root <div>. " +
  "No <!DOCTYPE>, no <html>, no <body> tags. No markdown fences. No code comments. No explanation text before or after the HTML. " +
  "Your work is known for organic texture, cinematic light, and precise typography. " +
  "You never produce geometric patterns or decorative shapes.";

// ─── Hard exclusion blocks ─────────────────────────────────────────────────────

const BACKGROUND_EXCLUSIONS = `CRITICAL — do NOT use any of the following:
clip-path polygon shapes, chevrons, diagonal stripe patterns, hexagonal or triangular grids, sharp geometric divisions, CSS border tricks to create shapes, repeating geometric patterns, or any visual element that reads as intentional geometry.
Do NOT create a flat base color with a pattern overlaid.
Do NOT make the center area bright or saturated — POS UI buttons must be readable over it.
Do NOT use rgba(0,0,0,...) values for bloom divs — blooms must use the specified brand colors.
The result must look like light and atmosphere, not a design pattern.`;

const SIDEBAR_EXCLUSIONS = `CRITICAL — do NOT use any of the following:
clip-path polygon shapes, chevrons, diagonal stripe patterns, hexagonal or triangular grids, sharp geometric divisions, border tricks to create shapes, repeating geometric patterns.
Do NOT make the sidebar feel like a different scene from the background — same light source, same atmosphere, same material world.
The visual texture must feel like a vertical wall, fabric panel, or architectural surface — not an abstract gradient composition.`;

// ─── Token → CSS directive translator ────────────────────────────────────────

interface CSSDirectives {
  turbulenceSettings: {
    baseFreq: string;
    octaves: number;
    opacity: number;
    blendMode: "overlay" | "soft-light" | "multiply";
  };
  bloomA: { size: number; top: string; left: string; opacitySuffix: string };
  bloomB: { size: number; bottom: string; right: string; opacitySuffix: string };
  bloomC: { size: number; topPct: string; left: string; opacitySuffix: string };
  bloomD: { size: number; top: string; right: string; opacitySuffix: string };
  vignetteStrength: number;
  centerClearStrength: number;
  asymmetric: boolean;
}

function tokensToCSSDirectives(
  t: Record<string, unknown>,
  primary: string,
  secondary: string,
  accent: string,
): CSSDirectives {
  const textureWords = [
    ...((t.textureWords as string[] | undefined) ?? []),
    ...((t.textures    as string[] | undefined) ?? []),
  ]
    .join(" ")
    .toLowerCase();

  const lightingDesc = (
    (t.lightingDescription as string | undefined) ?? ""
  ).toLowerCase();

  const moods = [
    ...((t.mood         as string[] | undefined) ?? []),
    ...((t.visual_style as string[] | undefined) ?? []),
  ]
    .join(" ")
    .toLowerCase();

  const imagery = ((t.imagery_keywords as string[] | undefined) ?? [])
    .join(" ")
    .toLowerCase();

  const allContext = `${textureWords} ${lightingDesc} ${moods} ${imagery}`;

  // ── Turbulence: surface words → noise frequency ────────────────────────────
  let turbulenceSettings: CSSDirectives["turbulenceSettings"];

  if (/stone|rock|concrete|plaster|brick|mortar|terracotta|limestone|cast/.test(textureWords)) {
    turbulenceSettings = { baseFreq: "0.65 0.65", octaves: 4, opacity: 0.09, blendMode: "overlay" };
  } else if (/cedar|oak|plank|wood|grain|barn|pine|timber|reclaimed|dock/.test(textureWords)) {
    turbulenceSettings = { baseFreq: "0.02 0.15", octaves: 3, opacity: 0.07, blendMode: "overlay" };
  } else if (/linen|woven|canvas|burlap|fabric|cotton|cloth|sailcloth/.test(textureWords)) {
    turbulenceSettings = { baseFreq: "0.04 0.20", octaves: 3, opacity: 0.06, blendMode: "soft-light" };
  } else if (/metal|steel|chrome|brushed|copper|iron|brass|wrought/.test(textureWords)) {
    turbulenceSettings = { baseFreq: "0.90 0.90", octaves: 2, opacity: 0.05, blendMode: "soft-light" };
  } else if (/leather|suede|hide|skin|hide/.test(textureWords)) {
    turbulenceSettings = { baseFreq: "0.35 0.35", octaves: 3, opacity: 0.07, blendMode: "multiply" };
  } else if (/rope|shell|coral|sand|driftwood|sea|oyster/.test(textureWords)) {
    turbulenceSettings = { baseFreq: "0.05 0.12", octaves: 3, opacity: 0.07, blendMode: "overlay" };
  } else if (/smoke|haze|fog|mist|cloud|vapor/.test(allContext)) {
    turbulenceSettings = { baseFreq: "0.015 0.015", octaves: 4, opacity: 0.08, blendMode: "overlay" };
  } else {
    turbulenceSettings = { baseFreq: "0.65 0.65", octaves: 4, opacity: 0.07, blendMode: "overlay" };
  }

  // ── Bloom layout: lighting description → positions ────────────────────────
  let bloomA = { size: 700, top: "-200px", left: "-180px", opacitySuffix: "55" };
  let bloomB = { size: 650, bottom: "-200px", right: "-160px", opacitySuffix: "2e" };
  let bloomC = { size: 520, topPct: "35%",   left: "-200px", opacitySuffix: "44" };
  let bloomD = { size: 380, top: "-100px",   right: "-100px", opacitySuffix: "1a" };
  let vignetteStrength  = 0.62;
  let centerClearStrength = 0.45;
  let asymmetric = false;

  if (/golden hour|late afternoon|sunset|raking|low angle|warm shadow/.test(lightingDesc)) {
    bloomA = { size: 780, top: "-240px", left: "-200px", opacitySuffix: "66" };
    bloomB = { size: 520, bottom: "-150px", right: "-130px", opacitySuffix: "22" };
    bloomC = { size: 560, topPct: "28%",   left: "-220px", opacitySuffix: "50" };
    bloomD = { size: 300, top: "-80px",    right: "-80px",  opacitySuffix: "14" };
    vignetteStrength = 0.58;
    asymmetric = true;
  } else if (/lantern|downlight|overhead|ceiling|spotlit|drop/.test(lightingDesc)) {
    bloomA = { size: 650, top: "-180px", left: "-100px", opacitySuffix: "4a" };
    bloomB = { size: 500, bottom: "-180px", right: "-120px", opacitySuffix: "22" };
    bloomC = { size: 480, topPct: "20%",   left: "-160px", opacitySuffix: "3a" };
    bloomD = { size: 350, top: "-120px",   right: "-120px", opacitySuffix: "20" };
    vignetteStrength = 0.68;
    centerClearStrength = 0.50;
  } else if (/neon|glow|electric|backlit|bar light/.test(lightingDesc + moods)) {
    bloomA = { size: 720, top: "-200px", left: "-180px", opacitySuffix: "60" };
    bloomB = { size: 680, bottom: "-200px", right: "-160px", opacitySuffix: "44" };
    bloomC = { size: 550, topPct: "35%",   left: "-210px", opacitySuffix: "55" };
    bloomD = { size: 420, top: "-110px",   right: "-110px", opacitySuffix: "30" };
    vignetteStrength = 0.55;
    asymmetric = true;
  } else if (/dim|candle|intimate|moody|low light/.test(lightingDesc)) {
    bloomA = { size: 600, top: "-150px", left: "-150px", opacitySuffix: "40" };
    bloomB = { size: 580, bottom: "-150px", right: "-150px", opacitySuffix: "20" };
    bloomC = { size: 450, topPct: "40%",   left: "-180px", opacitySuffix: "30" };
    bloomD = { size: 300, top: "-80px",    right: "-80px",  opacitySuffix: "10" };
    vignetteStrength = 0.72;
    centerClearStrength = 0.52;
  } else if (/morning|sunrise|diffused|soft ambient|overcast/.test(lightingDesc)) {
    bloomA = { size: 680, top: "-180px", left: "-160px", opacitySuffix: "48" };
    bloomB = { size: 600, bottom: "-170px", right: "-140px", opacitySuffix: "30" };
    bloomC = { size: 500, topPct: "38%",   left: "-180px", opacitySuffix: "3c" };
    bloomD = { size: 400, top: "-100px",   right: "-100px", opacitySuffix: "20" };
    vignetteStrength = 0.55;
  }

  // ── Mood overrides: chips → contrast + opacity ────────────────────────────
  if (/dramatic|intense|powerful/.test(moods)) {
    vignetteStrength      = Math.min(vignetteStrength + 0.12, 0.80);
    centerClearStrength   = Math.min(centerClearStrength + 0.06, 0.56);
    asymmetric = true;
  } else if (/minimal|clean|modern|sleek/.test(moods)) {
    turbulenceSettings.opacity = Math.max(turbulenceSettings.opacity - 0.02, 0.03);
    vignetteStrength = Math.max(vignetteStrength - 0.12, 0.38);
  } else if (/luxury|premium|elegant|refined/.test(moods)) {
    vignetteStrength = Math.min(vignetteStrength + 0.06, 0.72);
  } else if (/energetic|vibrant|lively|expressive/.test(moods)) {
    bloomA.opacitySuffix = "66";
    bloomC.opacitySuffix = "55";
    asymmetric = true;
  } else if (/soft|gentle|calm|serene/.test(moods)) {
    vignetteStrength    = Math.max(vignetteStrength - 0.15, 0.35);
    turbulenceSettings.opacity = Math.max(turbulenceSettings.opacity - 0.02, 0.03);
  }

  // suppress unused-var warning — primary/secondary/accent are available for callers
  void primary; void secondary; void accent;

  return {
    turbulenceSettings,
    bloomA,
    bloomB,
    bloomC,
    bloomD,
    vignetteStrength,
    centerClearStrength,
    asymmetric,
  };
}

/** Build the verbatim SVG texture element for a given filter id */
function buildSVGTexture(
  d: Pick<CSSDirectives, "turbulenceSettings">,
  filterId: string,
): string {
  const { baseFreq, octaves, opacity, blendMode } = d.turbulenceSettings;
  return (
    `<svg style="position:absolute;inset:0;width:100%;height:100%;` +
    `opacity:${opacity};mix-blend-mode:${blendMode};pointer-events:none" aria-hidden="true">` +
    `<filter id="${filterId}">` +
    `<feTurbulence type="fractalNoise" baseFrequency="${baseFreq}" ` +
    `numOctaves="${octaves}" stitchTiles="stitch"/>` +
    `<feColorMatrix type="saturate" values="0"/>` +
    `</filter>` +
    `<rect width="100%" height="100%" filter="url(#${filterId})" fill="white"/>` +
    `</svg>`
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function selectFont(t: Record<string, unknown>): {
  family: string;
  weight: string;
  importPath: string;
} {
  const s = [
    ...((t.visual_style as string[] | undefined) ?? []),
    (t.industry as string | undefined) ?? "",
    ...((t.mood as string[] | undefined) ?? []),
  ]
    .join(" ")
    .toLowerCase();

  if (/fine|upscale|elegant|luxury|gastronomic/.test(s))
    return { family: "Cormorant Garamond", weight: "400", importPath: "Cormorant+Garamond:wght@400;600" };
  if (/bbq|southern|smoke|rustic|sports bar/.test(s))
    return { family: "Oswald", weight: "600", importPath: "Oswald:wght@400;600" };
  if (/coastal|seafood|beach|nautical|keys/.test(s))
    return { family: "Raleway", weight: "300", importPath: "Raleway:wght@300;600" };
  if (/italian|bistro|trattoria|mediterranean/.test(s))
    return { family: "Libre Baskerville", weight: "400", importPath: "Libre+Baskerville:wght@400;700" };
  if (/mexican|latin|taqueria|cantina/.test(s))
    return { family: "Montserrat", weight: "600", importPath: "Montserrat:wght@400;600" };
  if (/bakery|cafe|coffee|brunch|pastry/.test(s))
    return { family: "Pacifico", weight: "400", importPath: "Pacifico" };
  if (/asian|japanese|chinese|thai|sushi/.test(s))
    return { family: "Quicksand", weight: "600", importPath: "Quicksand:wght@400;600" };
  return { family: "Playfair Display", weight: "600", importPath: "Playfair+Display:wght@400;600;700" };
}

// ─── Background prompt ────────────────────────────────────────────────────────

function buildBackgroundPrompt(
  t: Record<string, unknown>,
  fallbackContext: string,
): string {
  const p = (t.color_palette as Record<string, string>) ?? {};
  const base      = p.background || "#0d1b2a";
  const primary   = p.primary    || "#1a4d6e";
  const secondary = p.secondary  || "#2a6080";
  const accent    = p.accent     || "#e8a838";

  const textureWords        = (t.textureWords        as string[] | undefined) ?? [];
  const lightingDescription = (t.lightingDescription as string  | undefined) ?? "";
  const imagery = (t.imagery_keywords as string[] | undefined) ?? [];
  const mood    = (t.mood            as string[] | undefined) ?? [];

  const texturePhrase = textureWords.length > 0
    ? textureWords.slice(0, 3).join(", ")
    : fallbackContext || "aged wood, rough plaster, deep shadow in the corners";
  const lightPhrase  = lightingDescription || "Soft ambient light diffused at the edges, pooling into darkness at the center.";
  const sceneLine    = [...mood.slice(0, 2), ...imagery.slice(0, 2)].filter(Boolean).join(". ");

  const d   = tokensToCSSDirectives(t, primary, secondary, accent);
  const svg = buildSVGTexture(d, "bg-tex");
  const vig = d.vignetteStrength.toFixed(2);
  const cco = d.centerClearStrength.toFixed(2);
  const asymNote = d.asymmetric
    ? "\nCOMPOSITION: ASYMMETRIC — weight the visual mass to the left side; do not center the light."
    : "";

  return `${lightPhrase} Surfaces: ${texturePhrase}. ${sceneLine}${asymNote}

CANVAS: 1024px wide × 716px tall. POS terminal main screen — UI buttons overlay the center zone.

OUTPUT: A <style> block followed immediately by one root <div class="bg-root">. Nothing else.

TECHNIQUE — implement every layer in order:

1. Base gradient <div class="bg-base">: background: linear-gradient(160deg, ${base} 0%, ${secondary} 55%, ${primary} 100%); position:absolute; inset:0

2. Atmospheric bloom layers — exactly 4 child <div>s, each position:absolute; border-radius:50%; pointer-events:none; mix-blend-mode:screen:
   • bloom-a (top-left, ${d.bloomA.size}px): background: radial-gradient(ellipse at center, ${primary}${d.bloomA.opacitySuffix} 0%, transparent 65%); width:${d.bloomA.size}px; height:${d.bloomA.size}px; top:${d.bloomA.top}; left:${d.bloomA.left}
   • bloom-b (bottom-right, ${d.bloomB.size}px): background: radial-gradient(ellipse at center, ${accent}${d.bloomB.opacitySuffix} 0%, transparent 60%); width:${d.bloomB.size}px; height:${d.bloomB.size}px; bottom:${d.bloomB.bottom}; right:${d.bloomB.right}
   • bloom-c (mid-left edge, ${d.bloomC.size}px): background: radial-gradient(ellipse at center, ${secondary}${d.bloomC.opacitySuffix} 0%, transparent 55%); width:${d.bloomC.size}px; height:${d.bloomC.size}px; top:${d.bloomC.topPct}; left:${d.bloomC.left}
   • bloom-d (top-right corner, ${d.bloomD.size}px): background: radial-gradient(ellipse at center, ${accent}${d.bloomD.opacitySuffix} 0%, transparent 50%); width:${d.bloomD.size}px; height:${d.bloomD.size}px; top:${d.bloomD.top}; right:${d.bloomD.right}

3. Center-clear overlay <div class="bg-center-clear">: background: radial-gradient(ellipse 60% 55% at 50% 50%, rgba(0,0,0,${cco}) 0%, transparent 70%); position:absolute; inset:0

4. Vignette <div class="bg-vignette">: background: radial-gradient(ellipse at center, transparent 38%, rgba(0,0,0,${vig}) 100%); position:absolute; inset:0

5. SVG texture layer — copy this element VERBATIM as the last child of bg-root (before the closing tag):
${svg}

ROOT: <div class="bg-root" style="width:1024px;height:716px;overflow:hidden;position:relative;background:${base}">

COLORS:
• ${base} — dominant dark base, canvas background property
• ${primary} at the opacity suffix shown in step 2 bloom-a
• ${secondary} for gradient transitions only
• ${accent} — small warm bloom at bloom-b and bloom-d only, opacity suffix as shown above — do not scatter it

${BACKGROUND_EXCLUSIONS}`;
}

// ─── Sidebar prompt ───────────────────────────────────────────────────────────

function buildSidebarPrompt(
  t: Record<string, unknown>,
  displayTitle: string | null,
  fallbackContext: string,
): string {
  const p = (t.color_palette as Record<string, string>) ?? {};
  const base      = p.background || "#0d1b2a";
  const primary   = p.primary    || "#1a4d6e";
  const secondary = p.secondary  || "#2a6080";
  const accent    = p.accent     || "#e8a838";

  const textureWords        = (t.textureWords        as string[] | undefined) ?? [];
  const lightingDescription = (t.lightingDescription as string  | undefined) ?? "";
  const mood = (t.mood as string[] | undefined) ?? [];

  const texturePhrase = textureWords.length > 0
    ? textureWords.slice(0, 3).join(", ")
    : fallbackContext || "aged wood, linen, rough plaster";
  const lightPhrase  = lightingDescription || "Warm light descending from above, shadow pooling at the base.";
  const moodPhrase   = mood.slice(0, 2).filter(Boolean).join(", ");

  const d   = tokensToCSSDirectives(t, primary, secondary, accent);
  const svg = buildSVGTexture(d, "sb-tex");
  const vig = d.vignetteStrength.toFixed(2);

  // Scale bloom sizes down ~65% for the narrow sidebar canvas
  const topSize = Math.round(d.bloomA.size * 0.72);
  const midSize = Math.round(d.bloomC.size * 0.78);
  const botSize = Math.round(d.bloomB.size * 0.70);

  const font = selectFont(t);

  const typographyBlock = displayTitle
    ? `
TYPOGRAPHY LAYER — render this exact text:
"${displayTitle}"

Treatment — BAND mode:
A <div class="sb-band"> wraps the text. Styles: background: rgba(0,0,0,0.55); padding: 1.8rem 1.5rem; position: absolute; left: 0; right: 0; bottom: 22%; display: flex; flex-direction: column; align-items: center; gap: 0.4rem; position: relative inside the absolute container.

@import this font at the top of the <style> block:
@import url('https://fonts.googleapis.com/css2?family=${font.importPath}&display=swap');

Quote text <p class="sb-quote">:
font-family: '${font.family}', serif; font-size: clamp(1rem, 2.8vw, 1.4rem); font-weight: ${font.weight}; line-height: 1.55; color: #ffffff; text-align: center; max-width: 300px; word-wrap: break-word; white-space: normal; margin: 0

Decorative opening mark <span class="sb-deco" aria-hidden="true">:
content: "\u201C"; font-size: 3.2rem; opacity: 0.2; color: ${accent}; font-family: Georgia, serif; line-height: 0.8; display: block; text-align: center; margin-bottom: 0.3rem
`
    : `NO text, NO words, NO numbers, NO labels anywhere in the design.`;

  return `${lightPhrase} A narrow vertical architectural surface: ${texturePhrase}. ${moodPhrase}.

CANVAS: 360px wide × 696px tall. Narrow portrait — sidebar panel for a POS terminal.

OUTPUT: A <style> block followed immediately by one root <div class="sb-root">. Nothing else.

TECHNIQUE — implement every layer in order:

1. Base gradient <div class="sb-base">: background: linear-gradient(180deg, ${primary} 0%, ${base} 48%, ${secondary} 100%); position:absolute; inset:0

2. Atmospheric bloom layers — 3 oversized <div>s that intentionally overflow the narrow canvas (expected and correct):
   • bloom-top (${topSize}px circle): background: radial-gradient(ellipse at center, ${primary}${d.bloomA.opacitySuffix} 0%, transparent 58%); width:${topSize}px; height:${topSize}px; top:-120px; left:-70px; position:absolute; border-radius:50%; pointer-events:none; mix-blend-mode:screen
   • bloom-mid (${midSize}px circle): background: radial-gradient(ellipse at center, ${accent}${d.bloomC.opacitySuffix} 0%, transparent 52%); width:${midSize}px; height:${midSize}px; top:38%; left:-160px; position:absolute; border-radius:50%; pointer-events:none; mix-blend-mode:screen
   • bloom-bot (${botSize}px circle): background: radial-gradient(ellipse at center, ${secondary}${d.bloomB.opacitySuffix} 0%, transparent 56%); width:${botSize}px; height:${botSize}px; bottom:-130px; right:-160px; position:absolute; border-radius:50%; pointer-events:none; mix-blend-mode:screen

3. Edge vignette <div class="sb-vignette-h">: background: linear-gradient(90deg, rgba(0,0,0,0.5) 0%, transparent 32%, transparent 68%, rgba(0,0,0,0.5) 100%); position:absolute; inset:0

4. Vertical vignette <div class="sb-vignette-v">: background: linear-gradient(180deg, rgba(0,0,0,0.28) 0%, transparent 22%, transparent 78%, rgba(0,0,0,${vig}) 100%); position:absolute; inset:0

5. SVG texture layer — copy this element VERBATIM as the last child of sb-root (before the closing tag):
${svg}

ROOT: <div class="sb-root" style="width:360px;height:696px;overflow:hidden;position:relative;background:${base}">

COLORS: Same light source as the background — primary bloom from top-left. ${accent} at mid-left edge only (bloom-mid). ${primary} dominates the upper zone.

${typographyBlock}

${SIDEBAR_EXCLUSIONS}`;
}

// ─── Unified prompt (sidebar + background as one 1384×716 canvas) ─────────────

function buildUnifiedPrompt(
  t: Record<string, unknown>,
  displayTitle: string | null,
  fallbackContext: string,
): string {
  const p = (t.color_palette as Record<string, string>) ?? {};
  const base      = p.background || "#0d1b2a";
  const primary   = p.primary    || "#1a4d6e";
  const secondary = p.secondary  || "#2a6080";
  const accent    = p.accent     || "#e8a838";

  const textureWords       = (t.textureWords        as string[] | undefined) ?? [];
  const lightingDescription = (t.lightingDescription as string  | undefined) ?? "";
  const mood    = (t.mood            as string[] | undefined) ?? [];
  const imagery = (t.imagery_keywords as string[] | undefined) ?? [];

  const texturePhrase = textureWords.length > 0
    ? textureWords.slice(0, 3).join(", ")
    : fallbackContext || "aged wood, rough plaster, deep shadow";
  const lightPhrase  = lightingDescription || "Directional ambient light from the upper-left, fading into deep shadow at the right and center.";
  const sceneLine    = [...mood.slice(0, 2), ...imagery.slice(0, 2)].filter(Boolean).join(". ");

  const font = selectFont(t);

  const typographyBlock = displayTitle
    ? `
SIDEBAR TYPOGRAPHY (left 360px zone only):
Display this exact text in the left zone:
"${displayTitle}"

@import at top of <style>: @import url('https://fonts.googleapis.com/css2?family=${font.importPath}&display=swap');

Treatment — BAND: A <div class="u-band"> positioned absolute in the left zone: left:0; width:360px; bottom:22%; background: rgba(0,0,0,0.52); padding: 1.8rem 1.5rem; display:flex; flex-direction:column; align-items:center; gap:0.4rem

Quote <p>: font-family:'${font.family}',serif; font-size:clamp(1rem,2.6vw,1.35rem); font-weight:${font.weight}; line-height:1.55; color:#fff; text-align:center; max-width:300px; word-wrap:break-word; white-space:normal; margin:0

Deco mark <span>: display:block; font-size:3rem; opacity:0.2; color:${accent}; font-family:Georgia,serif; line-height:0.8; text-align:center; margin-bottom:0.3rem
`
    : `NO text, NO words, NO numbers anywhere in the design.`;

  const d   = tokensToCSSDirectives(t, primary, secondary, accent);
  const svg = buildSVGTexture(d, "u-tex");
  const vig = d.vignetteStrength.toFixed(2);
  const cco = d.centerClearStrength.toFixed(2);
  const asymNote = d.asymmetric
    ? "\nCOMPOSITION: ASYMMETRIC — weight visual mass to the left side; do not center the light."
    : "";

  // Scale up unified blooms ~115% of background (wider canvas)
  const uA = Math.round(d.bloomA.size * 1.14);
  const uB = Math.round(d.bloomB.size * 1.08);
  const uC = Math.round(d.bloomC.size * 1.15);
  const uD = Math.round(d.bloomD.size * 1.30);

  return `${lightPhrase} Surfaces: ${texturePhrase}. ${sceneLine}${asymNote}

CANVAS: exactly 1384px wide × 716px tall. Rasterized to PNG, then split:
• LEFT 360px  → sidebar strip (portrait decorative panel)
• RIGHT 1024px → main POS background (UI buttons sit on top of the center-right zone)
The seam at x=360 must be invisible — atmosphere flows continuously across it.

OUTPUT: A <style> block followed immediately by one root <div class="u-root">. Nothing else.

TECHNIQUE — one shared scene, two zones:

1. Base gradient <div class="u-base">: background: linear-gradient(110deg, ${primary} 0%, ${base} 38%, ${secondary} 70%, ${base} 100%); position:absolute; inset:0

2. Shared atmosphere — 5 large bloom <div>s, position:absolute; border-radius:50%; pointer-events:none; mix-blend-mode:screen:
   • u-bloom-a (top-left, ${uA}px): background: radial-gradient(ellipse at center, ${primary}${d.bloomA.opacitySuffix} 0%, transparent 60%); width:${uA}px; height:${uA}px; top:-220px; left:-200px
   • u-bloom-b (bottom-right, ${uB}px): background: radial-gradient(ellipse at center, ${accent}${d.bloomB.opacitySuffix} 0%, transparent 58%); width:${uB}px; height:${uB}px; bottom:-200px; right:-180px
   • u-bloom-c (mid-left seam, ${uC}px): background: radial-gradient(ellipse at center, ${secondary}${d.bloomC.opacitySuffix} 0%, transparent 55%); width:${uC}px; height:${uC}px; top:30%; left:-80px
   • u-bloom-d (right edge, ${uD}px): background: radial-gradient(ellipse at center, ${accent}${d.bloomD.opacitySuffix} 0%, transparent 52%); width:${uD}px; height:${uD}px; top:10%; right:-160px
   • u-bloom-e (bottom-center, 550px): background: radial-gradient(ellipse at center, ${secondary}33 0%, transparent 60%); width:550px; height:550px; bottom:-180px; left:35%

3. Right-zone center-clear <div class="u-center-clear">: background: radial-gradient(ellipse 55% 50% at 72% 50%, rgba(0,0,0,${cco}) 0%, transparent 72%); position:absolute; inset:0

4. Full vignette <div class="u-vignette">: background: radial-gradient(ellipse at center, transparent 36%, rgba(0,0,0,${vig}) 100%); position:absolute; inset:0

5. SVG texture layer — copy this element VERBATIM as the last child of u-root (before the closing tag):
${svg}

${typographyBlock}

ROOT: <div class="u-root" style="width:1384px;height:716px;overflow:hidden;position:relative;background:${base}">

COLORS:
• ${base} — canvas background, dominant darkness
• ${primary} — left zone and top blooms, opacity suffix "${d.bloomA.opacitySuffix}"
• ${secondary} — mid and bottom transitions
• ${accent} — bottom-right corner only, opacity suffix "${d.bloomB.opacitySuffix}"

${BACKGROUND_EXCLUSIONS}`;
}

// ─── Palette prompt (text only, no HTML output) ───────────────────────────────

function buildPaletteContext(
  t: Record<string, unknown> | null,
  fallbackContext: string,
): string {
  if (t) {
    const p = (t.color_palette as Record<string, string>) ?? {};
    const mood  = (t.mood         as string[] | undefined) ?? [];
    const style = (t.visual_style as string[] | undefined) ?? [];
    return [
      t.brand_name  && `Brand: ${t.brand_name}`,
      t.industry    && `Industry: ${t.industry}`,
      p.primary     && `Reference palette: primary ${p.primary}, secondary ${p.secondary}, accent ${p.accent}`,
      mood.length   && `Mood: ${mood.join(", ")}`,
      style.length  && `Visual style: ${style.join(", ")}`,
    ]
      .filter(Boolean)
      .join("\n");
  }
  return fallbackContext;
}

// ─── Route ────────────────────────────────────────────────────────────────────

export async function POST(request: Request) {
  try {
    const {
      restaurantName,
      restaurantType,
      groups,
      type,
      styleHints,
      brandTokens,
    } = (await request.json()) as {
      restaurantName?: string;
      restaurantType?: string;
      groups?: string[];
      type: "sidebar" | "background" | "palette" | "unified";
      styleHints?: string;
      brandTokens?: Record<string, unknown>;
    };

    // Extract quoted display title from styleHints (e.g. "The Keys Life")
    const titleMatch   = styleHints?.match(/"([^"]+)"/);
    const displayTitle = titleMatch?.[1]?.trim() ?? null;
    const cleanedHints = styleHints
      ?.replace(/"[^"]*"/g, "")
      .replace(/,\s*,/g, ",")
      .trim() || undefined;

    // Fallback context string when no brand tokens are provided
    const fallbackContext = [
      restaurantName && `Restaurant: ${restaurantName}`,
      restaurantType && `Type: ${restaurantType}`,
      groups?.length && `Menu groups: ${groups.join(", ")}`,
      cleanedHints   && `Style notes: ${cleanedHints}`,
    ]
      .filter(Boolean)
      .join("\n");

    // Use brand tokens if provided, otherwise empty object (fallbackContext fills the gap)
    const tokens: Record<string, unknown> = brandTokens ?? {};

    // ── Palette ──────────────────────────────────────────────────────────────
    if (type === "palette") {
      const context = buildPaletteContext(brandTokens ?? null, fallbackContext);
      const msg = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 512,
        messages: [
          {
            role: "user",
            content: `You are a restaurant branding expert. Based on the following restaurant info, recommend a color palette for their POS terminal.

${context}

Return a JSON object with exactly these keys:
- background: very dark hex color (luminance < 15%) for the POS background
- buttons_background_color: vibrant hex matching the brand vibe
- buttons_font_color: hex that contrasts well with buttons_background_color

Rules:
- Background MUST be very dark — POS terminals need dark backgrounds for readability
- Button color should evoke the cuisine/brand identity
- If style notes mention specific colors or moods, prioritize those
- Return ONLY valid JSON, no markdown.`,
          },
        ],
      });

      const text = msg.content[0].type === "text" ? msg.content[0].text : "";
      let palette;
      try {
        palette = JSON.parse(text.replace(/```json?\n?/g, "").replace(/```/g, "").trim());
      } catch {
        return Response.json({ error: "Failed to parse palette", raw: text }, { status: 500 });
      }

      return Response.json({
        palette,
        type: "palette",
        usage: { input_tokens: msg.usage.input_tokens, output_tokens: msg.usage.output_tokens },
      });
    }

    // ── Unified ───────────────────────────────────────────────────────────────
    if (type === "unified") {
      const prompt = buildUnifiedPrompt(tokens, displayTitle, fallbackContext);

      const msg = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 8192,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: prompt }],
      });

      const text    = msg.content[0].type === "text" ? msg.content[0].text : "";
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

    // ── Sidebar ───────────────────────────────────────────────────────────────
    if (type === "sidebar") {
      const prompt = buildSidebarPrompt(tokens, displayTitle, fallbackContext);

      const msg = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 8192,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: prompt }],
      });

      const text     = msg.content[0].type === "text" ? msg.content[0].text : "";
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

    // ── Background (default) ──────────────────────────────────────────────────
    const prompt = buildBackgroundPrompt(tokens, fallbackContext);

    const msg = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
    });

    const text     = msg.content[0].type === "text" ? msg.content[0].text : "";
    const stripped = text.replace(/```html?\n?/g, "").replace(/```\n?/g, "").trim();
    const htmlMatch = stripped.match(/(<style>[\s\S]*?<\/style>\s*)?(<div[\s\S]*<\/div>)/);
    if (!htmlMatch) {
      return Response.json({ error: "No HTML found in response", raw: text.slice(0, 500) }, { status: 500 });
    }

    return Response.json({
      html: (htmlMatch[1] ?? "") + htmlMatch[2],
      type: "background",
      usage: { input_tokens: msg.usage.input_tokens, output_tokens: msg.usage.output_tokens },
    });
  } catch (error: unknown) {
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}
