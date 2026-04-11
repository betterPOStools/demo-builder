import sharp from "sharp";

export const maxDuration = 60;

const SIDEBAR_W = 360;
const SIDEBAR_H = 696;

// ─── Types ───────────────────────────────────────────────────────────────────

interface RequestBody {
  logoUrl?: string;
  logoBase64?: string; // raw base64 string or full data URI
  logoMimeType?: string;
  brandTokens?: Record<string, unknown>;
  stylePrompt?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function stripDataUriPrefix(input: string): { base64: string; mime: string | null } {
  const m = /^data:([^;,]+);base64,(.*)$/i.exec(input);
  if (m) return { base64: m[2], mime: m[1] };
  return { base64: input, mime: null };
}

function toDataUri(base64: string, mime: string | null | undefined): string {
  return `data:${mime || "image/jpeg"};base64,${base64}`;
}

async function fetchAsDataUri(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Logo fetch failed: HTTP ${res.status}`);
  const contentType = res.headers.get("content-type")?.split(";")[0] || "image/jpeg";
  const buf = Buffer.from(await res.arrayBuffer());
  return `data:${contentType};base64,${buf.toString("base64")}`;
}

function buildLogoSidebarPrompt(
  brandTokens: Record<string, unknown> | undefined,
  stylePrompt: string | undefined,
): string {
  const TAIL =
    ", narrow vertical portrait, atmospheric, no text, no labels, " +
    "the logo's colors and shapes as the visual DNA of the composition";

  if (stylePrompt?.trim()) return stylePrompt.trim() + TAIL;

  if (brandTokens) {
    const lighting = (brandTokens.lightingDescription as string | undefined) ?? "";
    const textures = (brandTokens.textureWords as string[] | undefined)?.slice(0, 3) ?? [];
    const mood = (brandTokens.mood as string[] | undefined)?.slice(0, 3) ?? [];
    const parts = [
      lighting,
      "Narrow vertical architectural surface inspired by the brand's visual identity",
      textures.join(", "),
      mood.join(", "),
      "The logo's forms and palette define the color story",
      "Atmospheric depth, cinematic, no text, no words, no labels, portrait orientation",
    ].filter((p) => p.trim().length > 0);
    return parts.join(". ") + ".";
  }

  return (
    "Atmospheric brand sidebar, narrow vertical portrait, cinematic " +
    "lighting, the logo's visual character expressed as texture and " +
    "light, no text, no labels"
  );
}

// ─── fal.ai — Step 1: background removal (non-fatal) ─────────────────────────

async function falRembg(
  logoDataUri: string,
  falKey: string,
): Promise<string | null> {
  try {
    const res = await fetch("https://fal.run/fal-ai/imageutils/rembg", {
      method: "POST",
      headers: {
        Authorization: `Key ${falKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ image_url: logoDataUri }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      const text = await res.text();
      console.warn(`[logo-sidebar] rembg HTTP ${res.status}: ${text.slice(0, 200)}`);
      return null;
    }
    const data = (await res.json()) as { image?: { url?: string } };
    const imageUrl = data.image?.url;
    if (!imageUrl) {
      console.warn("[logo-sidebar] rembg returned no image URL");
      return null;
    }
    const imgRes = await fetch(imageUrl, { signal: AbortSignal.timeout(15000) });
    if (!imgRes.ok) throw new Error(`rembg download HTTP ${imgRes.status}`);
    const buf = Buffer.from(await imgRes.arrayBuffer());
    return `data:image/png;base64,${buf.toString("base64")}`;
  } catch (e) {
    console.warn("[logo-sidebar] rembg threw:", (e as Error).message);
    return null;
  }
}

// ─── fal.ai — Step 2: FLUX Pro atmospheric background ────────────────────────

async function falFluxBackground(
  prompt: string,
  falKey: string,
): Promise<Buffer> {
  const res = await fetch("https://fal.run/fal-ai/flux-pro/v1.1", {
    method: "POST",
    headers: {
      Authorization: `Key ${falKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prompt,
      image_size: { width: SIDEBAR_W, height: SIDEBAR_H },
      num_inference_steps: 28,
      guidance_scale: 3.5,
      num_images: 1,
      safety_tolerance: "5",
    }),
    signal: AbortSignal.timeout(55000),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`FLUX Pro HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as { images?: { url: string }[] };
  const imageUrl = data.images?.[0]?.url;
  if (!imageUrl) throw new Error("No image URL in FLUX Pro response");

  const imgRes = await fetch(imageUrl, { signal: AbortSignal.timeout(15000) });
  if (!imgRes.ok) throw new Error(`Background download HTTP ${imgRes.status}`);
  return Buffer.from(await imgRes.arrayBuffer());
}

// ─── Step 3: sharp composite ──────────────────────────────────────────────────

async function compositeLogoOnBackground(
  bgBuffer: Buffer,
  cleanLogoDataUri: string,
): Promise<string> {
  const { base64 } = stripDataUriPrefix(cleanLogoDataUri);
  const logoBuffer = Buffer.from(base64, "base64");

  // Resize logo to 70% of sidebar width, preserving aspect ratio
  const logoWidth = Math.round(SIDEBAR_W * 0.7); // 252px
  const resizedLogo = await sharp(logoBuffer)
    .resize(logoWidth, null, { fit: "inside", withoutEnlargement: false })
    .png()
    .toBuffer();

  const logoMeta = await sharp(resizedLogo).metadata();
  const logoH = logoMeta.height ?? 120;
  const logoW = logoMeta.width ?? logoWidth;

  // Horizontally centered, vertically at 25% down the sidebar
  const leftOffset = Math.round((SIDEBAR_W - logoW) / 2);
  const topOffset = Math.max(20, Math.round(SIDEBAR_H * 0.25 - logoH / 2));

  const composited = await sharp(bgBuffer)
    .resize(SIDEBAR_W, SIDEBAR_H)
    .composite([{ input: resizedLogo, left: leftOffset, top: topOffset, blend: "over" }])
    .png()
    .toBuffer();

  return `data:image/png;base64,${composited.toString("base64")}`;
}

// ─── Route ───────────────────────────────────────────────────────────────────

export async function POST(request: Request) {
  const falKey = process.env.FAL_KEY;
  if (!falKey) {
    return Response.json({ error: "FAL_KEY not set" }, { status: 400 });
  }

  let body: RequestBody;
  try {
    body = (await request.json()) as RequestBody;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { logoUrl, logoBase64, logoMimeType, brandTokens, stylePrompt } = body;

  let logoDataUri: string;
  try {
    if (logoBase64) {
      const { base64, mime } = stripDataUriPrefix(logoBase64);
      logoDataUri = toDataUri(base64, logoMimeType || mime || "image/jpeg");
    } else if (logoUrl) {
      logoDataUri = await fetchAsDataUri(logoUrl);
    } else {
      return Response.json({ error: "Provide logoUrl or logoBase64" }, { status: 400 });
    }
  } catch (e) {
    return Response.json({ error: `Logo load failed: ${(e as Error).message}` }, { status: 400 });
  }

  try {
    const rembgResult = await falRembg(logoDataUri, falKey);
    const cleanLogoDataUri = rembgResult ?? logoDataUri;

    const prompt = buildLogoSidebarPrompt(brandTokens, stylePrompt);
    const bgBuffer = await falFluxBackground(prompt, falKey);

    const dataUri = await compositeLogoOnBackground(bgBuffer, cleanLogoDataUri);

    return Response.json({
      dataUri,
      source: "fal-composite" as const,
      cleanLogoDataUri,
    });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
