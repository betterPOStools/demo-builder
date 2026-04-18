import { buildFluxPrompt } from "@/lib/generation/promptBuilders";

export const maxDuration = 60;

interface CompareResult {
  source: "fal" | "ideogram" | "unsplash";
  label: string;
  dataUri: string | null;
  error?: string;
}

// ─── Unsplash ─────────────────────────────────────────────────────────────────

async function fetchUnsplash(
  keywords: string[],
  width: number,
  height: number,
): Promise<CompareResult> {
  try {
    const query = keywords.slice(0, 3).join(",").replace(/ /g, "+");
    const url = `https://source.unsplash.com/featured/${width}x${height}/?${query}`;
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const arrayBuffer = await res.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString("base64");
    const contentType = res.headers.get("content-type") || "image/jpeg";
    return {
      source: "unsplash",
      label: "Unsplash",
      dataUri: `data:${contentType};base64,${base64}`,
    };
  } catch (e) {
    return {
      source: "unsplash",
      label: "Unsplash",
      dataUri: null,
      error: (e as Error).message,
    };
  }
}

// ─── fal.ai — shared image download helper ────────────────────────────────────

async function downloadToDataUri(imageUrl: string): Promise<string> {
  const res = await fetch(imageUrl, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Image download failed: HTTP ${res.status}`);
  const arrayBuffer = await res.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString("base64");
  const contentType = res.headers.get("content-type") || "image/webp";
  return `data:${contentType};base64,${base64}`;
}

// ─── fal.ai — Ideogram V3 DESIGN poster ──────────────────────────────────────

async function fetchIdeogramDesign(
  prompt: string,
  width: number,
  height: number,
): Promise<CompareResult> {
  const falKey = process.env.FAL_KEY;
  if (!falKey) {
    return {
      source: "ideogram",
      label: "fal.ai (Ideogram V3 Design)",
      dataUri: null,
      error: "Add FAL_KEY to Vercel env vars",
    };
  }
  try {
    const aspectRatio = width >= height ? "16:9" : "1:2";
    const res = await fetch("https://fal.run/fal-ai/ideogram/v3", {
      method: "POST",
      headers: {
        Authorization: `Key ${falKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt,
        aspect_ratio: aspectRatio,
        rendering_speed: "QUALITY",
        style_type: "DESIGN",
      }),
      signal: AbortSignal.timeout(55000),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = (await res.json()) as { images?: { url: string }[] };
    const imageUrl = data.images?.[0]?.url;
    if (!imageUrl) throw new Error("No image URL in Ideogram V3 response");
    return {
      source: "ideogram",
      label: "fal.ai (Ideogram V3 Design)",
      dataUri: await downloadToDataUri(imageUrl),
    };
  } catch (e) {
    return {
      source: "ideogram",
      label: "fal.ai (Ideogram V3 Design)",
      dataUri: null,
      error: (e as Error).message,
    };
  }
}

// ─── fal.ai — FLUX Pro background ────────────────────────────────────────────

async function fetchFalBackground(
  prompt: string,
  width: number,
  height: number,
  negativePrompt?: string,
): Promise<CompareResult> {
  const falKey = process.env.FAL_KEY;
  if (!falKey) {
    return {
      source: "fal",
      label: "fal.ai (FLUX Pro)",
      dataUri: null,
      error: "Add FAL_KEY to Vercel env vars",
    };
  }
  try {
    const res = await fetch("https://fal.run/fal-ai/flux-pro/v1.1", {
      method: "POST",
      headers: {
        Authorization: `Key ${falKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt,
        ...(negativePrompt ? { negative_prompt: negativePrompt } : {}),
        image_size: { width, height },
        num_inference_steps: 28,
        guidance_scale: 3.5,
        num_images: 1,
        safety_tolerance: "5",
      }),
      signal: AbortSignal.timeout(55000),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = (await res.json()) as { images?: { url: string }[] };
    const imageUrl = data.images?.[0]?.url;
    if (!imageUrl) throw new Error("No image URL in fal.ai FLUX Pro response");
    return {
      source: "fal",
      label: "fal.ai (FLUX Pro)",
      dataUri: await downloadToDataUri(imageUrl),
    };
  } catch (e) {
    return {
      source: "fal",
      label: "fal.ai (FLUX Pro)",
      dataUri: null,
      error: (e as Error).message,
    };
  }
}

// ─── fal.ai — sidebar (Ideogram V3 with text, FLUX Pro without) ───────────────

async function fetchFalSidebar(
  prompt: string,
  width: number,
  height: number,
  hasQuoteText: boolean,
): Promise<CompareResult> {
  const falKey = process.env.FAL_KEY;
  if (!falKey) {
    return {
      source: hasQuoteText ? "ideogram" : "fal",
      label: hasQuoteText ? "fal.ai (Ideogram V3)" : "fal.ai (FLUX Pro)",
      dataUri: null,
      error: "Add FAL_KEY to Vercel env vars",
    };
  }

  if (hasQuoteText) {
    // Ideogram V3 — renders text accurately in images
    try {
      const res = await fetch("https://fal.run/fal-ai/ideogram/v3", {
        method: "POST",
        headers: {
          Authorization: `Key ${falKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt,
          aspect_ratio: "1:2",
          rendering_speed: "QUALITY",
          style_type: "REALISTIC",
        }),
        signal: AbortSignal.timeout(55000),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      const data = (await res.json()) as { images?: { url: string }[] };
      const imageUrl = data.images?.[0]?.url;
      if (!imageUrl) throw new Error("No image URL in Ideogram V3 response");
      return {
        source: "ideogram",
        label: "fal.ai (Ideogram V3)",
        dataUri: await downloadToDataUri(imageUrl),
      };
    } catch (e) {
      return {
        source: "ideogram",
        label: "fal.ai (Ideogram V3)",
        dataUri: null,
        error: (e as Error).message,
      };
    }
  } else {
    // No text — use FLUX Pro at sidebar dimensions
    try {
      const res = await fetch("https://fal.run/fal-ai/flux-pro/v1.1", {
        method: "POST",
        headers: {
          Authorization: `Key ${falKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt,
          image_size: { width, height },
          num_inference_steps: 28,
          guidance_scale: 3.5,
          num_images: 1,
          safety_tolerance: "5",
        }),
        signal: AbortSignal.timeout(55000),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      const data = (await res.json()) as { images?: { url: string }[] };
      const imageUrl = data.images?.[0]?.url;
      if (!imageUrl) throw new Error("No image URL in fal.ai FLUX Pro response");
      return {
        source: "fal",
        label: "fal.ai (FLUX Pro)",
        dataUri: await downloadToDataUri(imageUrl),
      };
    } catch (e) {
      return {
        source: "fal",
        label: "fal.ai (FLUX Pro)",
        dataUri: null,
        error: (e as Error).message,
      };
    }
  }
}

// ─── Route ────────────────────────────────────────────────────────────────────

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      keywords: string[];
      backgroundPrompt?: string;
      sidebarPrompt?: string;
      assetType: "background" | "sidebar" | "seamless";
      hasQuoteText?: boolean;
      quoteText?: string;
      brandTokens?: Record<string, unknown>;
      width: number;
      height: number;
      templateId?: string;
    };
    const {
      keywords,
      backgroundPrompt,
      sidebarPrompt,
      assetType,
      hasQuoteText = false,
      quoteText,
      brandTokens,
      width,
      height,
      templateId,
    } = body;

    const bgPromptBase = buildFluxPrompt(
      templateId,
      (brandTokens?.flux_scene_prompt as string | undefined) ||
        backgroundPrompt ||
        keywords.join(", "),
    );

    let falResult: Promise<CompareResult>;

    if (templateId === "ideogram-v3-design-poster") {
      // Design poster template routes to Ideogram V3 DESIGN regardless of surface.
      const posterPrompt =
        assetType === "background"
          ? `${bgPromptBase} Compose with the main subject and focal interest in the right 70% of the frame — the leftmost 30% will be covered by a sidebar panel.`
          : bgPromptBase;
      falResult = fetchIdeogramDesign(posterPrompt, width, height);
    } else if (assetType === "seamless") {
      // Plain background — no focal point or composition hints. The sidebar
      // overlay is cropped from this same image client-side via splitFromDataUri.
      falResult = fetchFalBackground(
        bgPromptBase,
        width,
        height,
        brandTokens?.negative_prompt as string | undefined,
      );
    } else if (assetType === "background") {
      const bgPromptFinal =
        `${bgPromptBase} Compose with the main subject and focal interest in the right 70% of the frame — the leftmost 30% will be covered by a sidebar panel.`;
      falResult = fetchFalBackground(
        bgPromptFinal,
        width,
        height,
        brandTokens?.negative_prompt as string | undefined,
      );
    } else {
      // sidebar
      const sidebarFluxPrompt = buildFluxPrompt(
        templateId,
        (brandTokens?.flux_sidebar_prompt as string | undefined) ||
          sidebarPrompt ||
          keywords.join(", "),
      );
      falResult = fetchFalSidebar(
        hasQuoteText
          ? ((brandTokens?.ideogram_sidebar_prompt as string | undefined)
              ? (brandTokens!.ideogram_sidebar_prompt as string).replace(
                  "[QUOTE_PLACEHOLDER]",
                  quoteText ?? "",
                )
              : sidebarPrompt || keywords.join(", "))
          : sidebarFluxPrompt,
        width,
        height,
        hasQuoteText,
      );
    }

    const [fal, unsplash] = await Promise.all([
      falResult,
      fetchUnsplash(keywords, width, height),
    ]);

    return Response.json({ results: [fal, unsplash] as CompareResult[] });
  } catch (err: unknown) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}
