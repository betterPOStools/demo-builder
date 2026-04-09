const STOP_WORDS = new Set([
  "a", "an", "the", "with", "and", "or", "of", "in", "on", "at", "for",
  "to", "from", "style", "served", "our", "house", "fresh", "crispy",
  "grilled", "fried", "baked", "classic",
]);

/**
 * Extracts normalized concept tags from item name, group name, and restaurant type.
 * Used for smart library matching when auto-assigning images to items.
 */
export function extractConceptTags(
  itemName: string,
  groupName?: string,
  restaurantType?: string,
): string[] {
  const raw = [itemName, groupName, restaurantType]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
  return [...new Set(raw)];
}

/**
 * Infers a broad food category from the group name.
 */
export function extractFoodCategory(groupName?: string): string {
  const g = (groupName || "").toLowerCase();
  if (/drink|beverage|bar|beer|wine|cocktail|juice|soda/.test(g)) return "drink";
  if (/dessert|sweet|cake|ice cream|pastry/.test(g)) return "dessert";
  if (/appetizer|starter|snack|side/.test(g)) return "side";
  if (/breakfast|brunch|morning/.test(g)) return "breakfast";
  return "entree";
}
