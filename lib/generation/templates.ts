// Generation template registry — mirrors lib/presets/typePalettes.ts pattern.
// Each template bundles a model + a prompt-builder approach for one surface.
// Historical variants pulled from git (see HISTORY column) are preserved as
// separate templates so users can compare outputs side by side.

export type GenerationSurface =
  | "background"
  | "sidebar"
  | "seamless"
  | "item"
  | "logo-composite";

export type GenerationModel =
  | "pull-from-library"
  | "claude-haiku"
  | "claude-sonnet"
  | "fal-flux-pro"
  | "fal-flux-schnell"
  | "fal-ideogram-v3"
  | "fal-recraft-v3";

export interface GenerationTemplate {
  id: string;
  label: string;
  description: string;
  surfaces: GenerationSurface[];
  model: GenerationModel;
  // Category used by the horizontal strip selector.
  kind: "library" | "photoreal" | "design" | "illustrative";
  // Feature flag — false when the route refactor hasn't landed the dispatch yet.
  // UI still shows it so the user can see the catalog; generate button disables.
  wired: boolean;
}

export const GENERATION_TEMPLATES: Record<string, GenerationTemplate> = {
  // ─── Pull-from-library (default) ──────────────────────────────────────────
  "pull-from-library": {
    id: "pull-from-library",
    label: "Pull from Library",
    description: "Search the shared library by tags first; generate only on miss.",
    surfaces: ["background", "sidebar", "seamless", "item", "logo-composite"],
    model: "pull-from-library",
    kind: "library",
    wired: true,
  },

  // ─── Photoreal backgrounds/sidebars ───────────────────────────────────────
  "flux-pro-photo": {
    id: "flux-pro-photo",
    label: "FLUX Pro — Cinematic Photo",
    description: "Photorealistic restaurant interior, moody lighting, shallow depth.",
    surfaces: ["background", "sidebar"],
    model: "fal-flux-pro",
    kind: "photoreal",
    wired: true,
  },
  "flux-seamless-photo": {
    id: "flux-seamless-photo",
    label: "FLUX Seamless Photo",
    description: "Single 1384×716 photo split into matched sidebar + background.",
    surfaces: ["seamless"],
    model: "fal-flux-pro",
    kind: "photoreal",
    wired: true,
  },
  "flux-logo-composite": {
    id: "flux-logo-composite",
    label: "FLUX Logo Composite",
    description: "FLUX-generated scene with your logo composited onto the sidebar.",
    surfaces: ["logo-composite"],
    model: "fal-flux-pro",
    kind: "photoreal",
    wired: true,
  },

  // ─── Design / abstract ────────────────────────────────────────────────────
  "ideogram-v3-typographic-quote": {
    id: "ideogram-v3-typographic-quote",
    label: "Ideogram — Typographic Quote",
    description: "Bold typography with readable text, ideal when style hints include \"quoted copy\".",
    surfaces: ["sidebar"],
    model: "fal-ideogram-v3",
    kind: "design",
    wired: true,
  },
  "ideogram-v3-design-poster": {
    id: "ideogram-v3-design-poster",
    label: "Ideogram — Design Poster",
    description: "Flat vector poster, bold shapes and colors, non-photoreal.",
    surfaces: ["background", "sidebar"],
    model: "fal-ideogram-v3",
    kind: "design",
    wired: true,
  },
  "sonnet-token-directives-css": {
    id: "sonnet-token-directives-css",
    label: "Sonnet — CSS/HTML Collage",
    description: "Claude Sonnet generates an HTML/CSS scene with turbulence + blooms.",
    surfaces: ["background", "sidebar"],
    model: "claude-sonnet",
    kind: "design",
    wired: true,
  },
  "sonnet-unified-css": {
    id: "sonnet-unified-css",
    label: "Sonnet — Seamless CSS",
    description: "Single Sonnet CSS render, then split into sidebar + background.",
    surfaces: ["seamless"],
    model: "claude-sonnet",
    kind: "design",
    wired: true,
  },
  "flux-risograph": {
    id: "flux-risograph",
    label: "FLUX — Risograph",
    description: "Grainy 2-color riso print aesthetic, retro and tactile.",
    surfaces: ["background", "sidebar"],
    model: "fal-flux-pro",
    kind: "design",
    wired: true,
  },
  "flux-blobby-gradient": {
    id: "flux-blobby-gradient",
    label: "FLUX — Blobby Gradient",
    description: "Soft abstract blobs and gradients, colorful and playful.",
    surfaces: ["background", "sidebar"],
    model: "fal-flux-pro",
    kind: "design",
    wired: true,
  },
  "flux-maximalist-pattern": {
    id: "flux-maximalist-pattern",
    label: "FLUX — Maximalist Pattern",
    description: "Dense repeating pattern, bold colors, high-energy.",
    surfaces: ["background", "sidebar"],
    model: "fal-flux-pro",
    kind: "design",
    wired: true,
  },

  // ─── Item icons ───────────────────────────────────────────────────────────
  "recraft-digital": {
    id: "recraft-digital",
    label: "Recraft — Digital",
    description: "Digital illustration style icon — clean shading, modern look.",
    surfaces: ["item"],
    model: "fal-recraft-v3",
    kind: "photoreal",
    wired: true,
  },
  "recraft-vector": {
    id: "recraft-vector",
    label: "Recraft — Vector",
    description: "Flat vector icon, SVG-quality lines, brandable.",
    surfaces: ["item"],
    model: "fal-recraft-v3",
    kind: "illustrative",
    wired: true,
  },
  "recraft-flat-sticker": {
    id: "recraft-flat-sticker",
    label: "Recraft — Flat Sticker",
    description: "Flat sticker style with white outline, great for dark backgrounds.",
    surfaces: ["item"],
    model: "fal-recraft-v3",
    kind: "illustrative",
    wired: true,
  },
  "flux-schnell-photo": {
    id: "flux-schnell-photo",
    label: "FLUX Schnell — Photo",
    description: "Photoreal food on clean background, fast generation.",
    surfaces: ["item"],
    model: "fal-flux-schnell",
    kind: "photoreal",
    wired: true,
  },
  "haiku-svg": {
    id: "haiku-svg",
    label: "Haiku — SVG Line Art",
    description: "Claude Haiku writes an SVG icon — transparent bg, infinitely scalable.",
    surfaces: ["item"],
    model: "claude-haiku",
    kind: "illustrative",
    wired: true,
  },
};

export function getTemplatesForSurface(
  surface: GenerationSurface,
): GenerationTemplate[] {
  return Object.values(GENERATION_TEMPLATES).filter((t) =>
    t.surfaces.includes(surface),
  );
}

export function getTemplate(id: string): GenerationTemplate | undefined {
  return GENERATION_TEMPLATES[id];
}

// Default template per surface — what the UI pre-selects.
export const DEFAULT_TEMPLATE_BY_SURFACE: Record<GenerationSurface, string> = {
  background: "pull-from-library",
  sidebar: "pull-from-library",
  seamless: "pull-from-library",
  item: "pull-from-library",
  "logo-composite": "pull-from-library",
};
