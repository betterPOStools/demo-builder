export const maxDuration = 60;

async function downloadToDataUri(imageUrl: string): Promise<string> {
  const res = await fetch(imageUrl, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Image download failed: HTTP ${res.status}`);
  const arrayBuffer = await res.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString("base64");
  const contentType = res.headers.get("content-type") || "image/webp";
  return `data:${contentType};base64,${base64}`;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as {
      imageDataUri: string;
      prompt: string;
      strength?: number;
    };
    const { imageDataUri, prompt } = body;
    const strength = typeof body.strength === "number" ? body.strength : 0.75;

    if (!imageDataUri?.startsWith("data:")) {
      return Response.json(
        { error: "imageDataUri must be a data: URI" },
        { status: 400 },
      );
    }
    if (!prompt?.trim()) {
      return Response.json({ error: "prompt required" }, { status: 400 });
    }

    const falKey = process.env.FAL_KEY;
    if (!falKey) {
      return Response.json(
        { error: "FAL_KEY missing on server" },
        { status: 500 },
      );
    }

    const res = await fetch("https://fal.run/fal-ai/flux/dev/image-to-image", {
      method: "POST",
      headers: {
        Authorization: `Key ${falKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        image_url: imageDataUri,
        prompt,
        strength,
        num_inference_steps: 30,
        guidance_scale: 3.5,
        num_images: 1,
      }),
      signal: AbortSignal.timeout(55000),
    });
    if (!res.ok) {
      const text = await res.text();
      return Response.json(
        { error: `fal ${res.status}: ${text.slice(0, 200)}` },
        { status: 502 },
      );
    }
    const data = (await res.json()) as { images?: { url: string }[] };
    const imageUrl = data.images?.[0]?.url;
    if (!imageUrl) {
      return Response.json({ error: "no image returned" }, { status: 502 });
    }

    return Response.json({ dataUri: await downloadToDataUri(imageUrl) });
  } catch (err) {
    return Response.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}
