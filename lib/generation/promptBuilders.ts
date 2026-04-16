import type { GenerationSurface } from "./templates";

// Style modifiers applied to a base prompt for FLUX Pro templates that only
// differ by aesthetic (same model, same dimensions, different suffix).
// Non-FLUX templates (Ideogram poster, Sonnet CSS, etc.) need their own
// dispatch path and are not represented here.
const FLUX_STYLE_SUFFIX: Record<string, string> = {
  "flux-pro-photo":
    "Photorealistic, cinematic lighting, shallow depth of field, atmospheric.",
  "flux-risograph":
    "Grainy two-color risograph print aesthetic, retro tactile texture, offset registration, limited palette.",
  "flux-blobby-gradient":
    "Soft abstract organic blobs and gradients, bright playful colors, non-photoreal, clean modern design.",
  "flux-maximalist-pattern":
    "Dense maximalist repeating pattern, bold saturated colors, high-energy, non-photoreal decorative composition.",
};

export function buildFluxPrompt(
  templateId: string | undefined,
  basePrompt: string,
): string {
  if (!templateId) return basePrompt;
  const suffix = FLUX_STYLE_SUFFIX[templateId];
  return suffix ? `${basePrompt}. ${suffix}` : basePrompt;
}

export function surfaceFromAssetType(
  assetType: "background" | "sidebar" | "seamless",
): GenerationSurface {
  return assetType;
}
