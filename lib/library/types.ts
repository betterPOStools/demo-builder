export type ImageIntent = "item" | "sidebar" | "background" | "logo-composite";

export type ImageType = ImageIntent;

export interface ImageLibraryRow {
  id: string;
  image_type: ImageType;
  original_intent: ImageIntent;
  storage_path: string;
  template_id: string | null;
  item_name: string | null;
  seamless_pair_id: string | null;
  concept_tags: string[];
  cuisine_type: string | null;
  food_category: string | null;
  restaurant_type: string | null;
  dimensions: { width: number; height: number } | null;
  generated_for: string | null;
  created_at: string;
}

export interface ImageLibraryEntry extends ImageLibraryRow {
  public_url: string;
}

export interface CreateImageLibraryInput {
  image_type: ImageType;
  original_intent: ImageIntent;
  template_id?: string;
  item_name?: string;
  seamless_pair_id?: string;
  concept_tags?: string[];
  cuisine_type?: string;
  food_category?: string;
  restaurant_type?: string;
  dimensions?: { width: number; height: number };
  generated_for?: string;
  data_uri: string;
}

export interface LibrarySearchParams {
  intent?: ImageIntent;
  image_type?: ImageType;
  tags?: string[];
  restaurant_type?: string;
  food_category?: string;
  cuisine_type?: string;
  item_name?: string;
  template_id?: string;
  limit?: number;
}

export const LIBRARY_BUCKET = "image-library";
