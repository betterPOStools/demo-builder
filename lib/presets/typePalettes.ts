// Static button color palettes per restaurant type.
// Used by the batch pipeline so generated demos have a designed color identity
// without requiring an AI call. Rich enough for a sales demo, consistent across runs.
//
// AI-generated branding (html2canvas background/sidebar) is reserved for the
// custom pipeline (lead card "Build Custom Demo" flow).

import type { RestaurantType } from "@/lib/types/batch";

export interface TypePalette {
  buttons_background_color: string;
  buttons_font_color: string;
}

// BUSINESS RULE: Each restaurant type gets a distinct color identity.
// Colors are designed to feel authentic to the cuisine/atmosphere and remain
// readable at the POS screen resolutions (1024×768, 1366×768).
export const RESTAURANT_TYPE_PALETTES: Record<RestaurantType, TypePalette> = {
  pizza:       { buttons_background_color: "#C0392B", buttons_font_color: "#FFFFFF" },
  bar_grill:   { buttons_background_color: "#4A2C0A", buttons_font_color: "#F5E6C8" },
  fine_dining: { buttons_background_color: "#1A1A2E", buttons_font_color: "#D4AF37" },
  cafe:        { buttons_background_color: "#5C3317", buttons_font_color: "#FFF8EE" },
  fast_casual: { buttons_background_color: "#2D6A4F", buttons_font_color: "#FFFFFF" },
  fast_food:   { buttons_background_color: "#CC0000", buttons_font_color: "#FFFFFF" },
  breakfast:   { buttons_background_color: "#B04A14", buttons_font_color: "#FFFFFF" },
  mexican:     { buttons_background_color: "#8B2500", buttons_font_color: "#FFF3CD" },
  asian:       { buttons_background_color: "#1A0A00", buttons_font_color: "#E8C97E" },
  seafood:     { buttons_background_color: "#0D4F6C", buttons_font_color: "#E0F4FF" },
  other:       { buttons_background_color: "#2C2C2C", buttons_font_color: "#FFFFFF" },
};
