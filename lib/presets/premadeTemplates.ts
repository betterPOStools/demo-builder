// Ported from template-builder/src/lib/presets/premadeTemplates.ts
import type { ModifierTemplateNode, ModifierSectionNode, ModifierNode } from "@/lib/types";

function mod(
  name: string,
  price: number,
  flags: {
    isPizzaCrust?: boolean;
    isPizzaTopping?: boolean;
    isBarMixer?: boolean;
    isBarDrink?: boolean;
    isDefault?: boolean;
  } = {},
): Omit<ModifierNode, "id" | "sortOrder"> {
  return {
    name,
    price,
    isDefault: flags.isDefault ?? false,
    imageAssetId: null,
    posImagePath: null,
    isPizzaCrust: flags.isPizzaCrust ?? false,
    isPizzaTopping: flags.isPizzaTopping ?? false,
    isBarMixer: flags.isBarMixer ?? false,
    isBarDrink: flags.isBarDrink ?? false,
  };
}

function section(
  name: string,
  min: number,
  max: number,
  modifiers: Omit<ModifierNode, "id" | "sortOrder">[],
): Omit<ModifierSectionNode, "id"> {
  return {
    name,
    sortOrder: 0,
    minSelections: min,
    maxSelections: max,
    gridColumns: 6,
    modifiers: modifiers.map((m, i) => ({ ...m, id: "", sortOrder: i })),
  };
}

function template(
  name: string,
  sections: Omit<ModifierSectionNode, "id">[],
): ModifierTemplateNode {
  return {
    id: "",
    name,
    source: "preset",
    restaurantType: null,
    sections: sections.map((s, i) => ({ ...s, id: "", sortOrder: i })),
  };
}

export const PREMADE_TEMPLATES: Record<string, ModifierTemplateNode> = {
  burger_modifiers: template("Burger Modifiers", [
    section("Temperature", 1, 1, [
      mod("Rare", 0),
      mod("Medium Rare", 0),
      mod("Medium", 0),
      mod("Medium Well", 0),
      mod("Well Done", 0),
    ]),
    section("Toppings", 0, 10, [
      mod("Lettuce", 0),
      mod("Tomato", 0),
      mod("Onion", 0),
      mod("Pickles", 0),
      mod("Jalapenos", 0.5),
      mod("Bacon", 1.5),
      mod("Avocado", 1.5),
      mod("Mushrooms", 0.75),
    ]),
    section("Cheese", 0, 2, [
      mod("American Cheese", 0),
      mod("Cheddar Cheese", 0),
      mod("Swiss Cheese", 0),
      mod("Pepper Jack", 0),
      mod("Blue Cheese", 0.5),
    ]),
  ]),

  steak_modifiers: template("Steak Modifiers", [
    section("Temperature", 1, 1, [
      mod("Rare", 0),
      mod("Medium Rare", 0),
      mod("Medium", 0),
      mod("Medium Well", 0),
      mod("Well Done", 0),
    ]),
    section("Sauce", 0, 1, [
      mod("No Sauce", 0),
      mod("Peppercorn Sauce", 0),
      mod("Mushroom Sauce", 0),
      mod("Bearnaise Sauce", 0),
      mod("A1 Sauce", 0),
    ]),
    section("Side", 1, 2, [
      mod("Baked Potato", 0),
      mod("Mashed Potato", 0),
      mod("French Fries", 0),
      mod("Steamed Vegetables", 0),
      mod("Side Salad", 0),
      mod("Onion Rings", 1.5),
    ]),
  ]),

  pizza_modifiers: template("Pizza Modifiers", [
    section("Crust", 1, 1, [
      mod("Thin Crust", 0, { isPizzaCrust: true }),
      mod("Regular Crust", 0, { isPizzaCrust: true }),
      mod("Thick Crust", 0, { isPizzaCrust: true }),
      mod("Stuffed Crust", 2.0, { isPizzaCrust: true }),
      mod("Gluten Free Crust", 3.0, { isPizzaCrust: true }),
    ]),
    section("Sauce", 1, 1, [
      mod("Marinara Sauce", 0),
      mod("White Sauce", 0),
      mod("BBQ Sauce", 0),
      mod("Pesto Sauce", 0.5),
      mod("No Sauce", 0),
    ]),
    section("Toppings", 0, 15, [
      mod("Pepperoni", 1.5, { isPizzaTopping: true }),
      mod("Sausage", 1.5, { isPizzaTopping: true }),
      mod("Mushrooms", 1.0, { isPizzaTopping: true }),
      mod("Green Peppers", 1.0, { isPizzaTopping: true }),
      mod("Onions", 1.0, { isPizzaTopping: true }),
      mod("Black Olives", 1.0, { isPizzaTopping: true }),
      mod("Ham", 1.5, { isPizzaTopping: true }),
      mod("Pineapple", 1.0, { isPizzaTopping: true }),
      mod("Bacon", 2.0, { isPizzaTopping: true }),
      mod("Extra Cheese", 1.5, { isPizzaTopping: true }),
    ]),
  ]),

  drink_modifiers: template("Drink Modifiers", [
    section("Mixer", 0, 2, [
      mod("Coca Cola", 0, { isBarMixer: true }),
      mod("Sprite", 0, { isBarMixer: true }),
      mod("Ginger Ale", 0, { isBarMixer: true }),
      mod("Tonic Water", 0, { isBarMixer: true }),
      mod("Club Soda", 0, { isBarMixer: true }),
      mod("Orange Juice", 0, { isBarMixer: true }),
      mod("Cranberry Juice", 0, { isBarMixer: true }),
      mod("Red Bull", 3.0, { isBarMixer: true }),
    ]),
    section("Preparation", 0, 3, [
      mod("On The Rocks", 0),
      mod("Neat", 0),
      mod("Straight Up", 0),
      mod("Blended", 0),
      mod("With Salt", 0),
      mod("With Sugar", 0),
    ]),
  ]),

  sandwich_modifiers: template("Sandwich Modifiers", [
    section("Bread", 1, 1, [
      mod("White Bread", 0),
      mod("Wheat Bread", 0),
      mod("Sourdough", 0),
      mod("Rye Bread", 0),
      mod("Ciabatta", 0.5),
      mod("Wrap", 0),
      mod("Gluten Free Bread", 1.5),
    ]),
    section("Extras", 0, 5, [
      mod("Extra Meat", 2.0),
      mod("Extra Cheese", 1.0),
      mod("Avocado", 1.5),
      mod("Bacon", 1.5),
    ]),
    section("Condiments", 0, 5, [
      mod("Mayo", 0),
      mod("Mustard", 0),
      mod("Ketchup", 0),
      mod("Ranch", 0),
      mod("Hot Sauce", 0),
      mod("Oil & Vinegar", 0),
    ]),
  ]),

  breakfast_modifiers: template("Breakfast Modifiers", [
    section("Egg Preparation", 1, 1, [
      mod("Scrambled", 0),
      mod("Over Easy", 0),
      mod("Over Medium", 0),
      mod("Over Hard", 0),
      mod("Sunny Side Up", 0),
      mod("Poached", 0),
    ]),
    section("Toast", 1, 1, [
      mod("White Toast", 0),
      mod("Wheat Toast", 0),
      mod("Rye Toast", 0),
      mod("Sourdough Toast", 0),
      mod("English Muffin", 0),
      mod("No Toast", 0),
    ]),
    section("Breakfast Side", 1, 1, [
      mod("Hash Browns", 0),
      mod("Home Fries", 0),
      mod("Fresh Fruit", 0),
      mod("Grits", 0),
    ]),
  ]),
};
