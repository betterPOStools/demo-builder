export const maxDuration = 60;

interface CompareResult {
  source: "replicate" | "fal" | "unsplash";
  label: string;
  dataUri: string | null;
  error?: string;
}

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

async function fetchReplicate(
  keywords: string[],
  backgroundPrompt: string | undefined,
  width: number,
  height: number,
): Promise<CompareResult> {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) {
    return {
      source: "replicate",
      label: "Replicate (FLUX)",
      dataUri: null,
      error: "Add REPLICATE_API_TOKEN to Vercel env vars",
    };
  }
  try {
    const prompt = backgroundPrompt || keywords.join(", ");
    const res = await fetch(
      "https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions",
      {
        method: "POST",
        headers: {
          Authorization: `Token ${token}`,
          "Content-Type": "application/json",
          Prefer: "wait",
        },
        body: JSON.stringify({
          input: { prompt, width, height, num_outputs: 1 },
        }),
      },
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = (await res.json()) as { output?: string[] };
    const imageUrl = data.output?.[0];
    if (!imageUrl) throw new Error("No output URL in Replicate response");
    const imgRes = await fetch(imageUrl);
    const arrayBuffer = await imgRes.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString("base64");
    const contentType = imgRes.headers.get("content-type") || "image/webp";
    return {
      source: "replicate",
      label: "Replicate (FLUX)",
      dataUri: `data:${contentType};base64,${base64}`,
    };
  } catch (e) {
    return {
      source: "replicate",
      label: "Replicate (FLUX)",
      dataUri: null,
      error: (e as Error).message,
    };
  }
}

async function fetchFal(
  keywords: string[],
  backgroundPrompt: string | undefined,
  width: number,
  height: number,
): Promise<CompareResult> {
  const falKey = process.env.FAL_KEY;
  if (!falKey) {
    return {
      source: "fal",
      label: "fal.ai (FLUX)",
      dataUri: null,
      error: "Add FAL_KEY to Vercel env vars",
    };
  }
  try {
    const prompt = backgroundPrompt || keywords.join(", ");
    const res = await fetch("https://fal.run/fal-ai/flux/schnell", {
      method: "POST",
      headers: {
        Authorization: `Key ${falKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt,
        image_size: { width, height },
        num_inference_steps: 4,
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = (await res.json()) as { images?: { url: string }[] };
    const imageUrl = data.images?.[0]?.url;
    if (!imageUrl) throw new Error("No image URL in fal.ai response");
    const imgRes = await fetch(imageUrl);
    const arrayBuffer = await imgRes.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString("base64");
    const contentType = imgRes.headers.get("content-type") || "image/webp";
    return {
      source: "fal",
      label: "fal.ai (FLUX)",
      dataUri: `data:${contentType};base64,${base64}`,
    };
  } catch (e) {
    return {
      source: "fal",
      label: "fal.ai (FLUX)",
      dataUri: null,
      error: (e as Error).message,
    };
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      keywords: string[];
      backgroundPrompt?: string;
      sidebarPrompt?: string;
      width: number;
      height: number;
    };
    const { keywords, backgroundPrompt, sidebarPrompt, width, height } = body;

    // Use sidebarPrompt as the prompt for sidebar-sized requests
    // (caller decides which prompt to pass; we accept both but use backgroundPrompt as primary)
    const prompt = backgroundPrompt ?? sidebarPrompt;

    const settled = await Promise.allSettled([
      fetchReplicate(keywords, prompt, width, height),
      fetchFal(keywords, prompt, width, height),
      fetchUnsplash(keywords, width, height),
    ]);

    const results: CompareResult[] = settled.map((s) =>
      s.status === "fulfilled"
        ? s.value
        : {
            source: "unsplash" as const,
            label: "Unknown",
            dataUri: null,
            error: (s.reason as Error).message,
          },
    );

    return Response.json({ results });
  } catch (err: unknown) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}
