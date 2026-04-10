"use client";

import type { PendingImageTransfer } from "@/lib/types";

/**
 * Re-encodes a data URI as JPEG at the given quality (0–1).
 * Non-data-URI values are returned unchanged.
 * Falls back to the original if anything goes wrong.
 */
async function compressDataUri(dataUri: string, quality: number): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = img.width;
        canvas.height = img.height;
        canvas.getContext("2d")!.drawImage(img, 0, 0);
        resolve(canvas.toDataURL("image/jpeg", quality));
      } catch {
        resolve(dataUri);
      }
    };
    img.onerror = () => resolve(dataUri);
    img.src = dataUri;
  });
}

/**
 * Compress all data URI image_urls in a PendingImageTransfer array to JPEG
 * before sending to Supabase. Typically shrinks 1–3 MB PNGs to ~60–120 KB.
 */
export async function compressPendingImages(
  images: PendingImageTransfer[],
  quality = 0.75,
): Promise<PendingImageTransfer[]> {
  return Promise.all(
    images.map(async (img) => {
      const url = img.image_url;
      if (!url?.startsWith("data:")) return img;
      const compressed = await compressDataUri(url, quality);
      return { ...img, image_url: compressed };
    }),
  );
}
