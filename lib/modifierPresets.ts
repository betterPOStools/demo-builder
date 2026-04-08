// Common modifier template presets for quick setup

export interface ModifierPreset {
  name: string;
  description: string;
  sections: {
    name: string;
    minSelections: number;
    maxSelections: number;
    modifiers: { name: string; price: number; isDefault?: boolean }[];
  }[];
}

export const MODIFIER_PRESETS: Record<string, ModifierPreset> = {
  pizza_toppings: {
    name: "Pizza Toppings",
    description: "Standard pizza topping options",
    sections: [
      {
        name: "Crust",
        minSelections: 1,
        maxSelections: 1,
        modifiers: [
          { name: "Hand Tossed", price: 0, isDefault: true },
          { name: "Thin Crust", price: 0 },
          { name: "Deep Dish", price: 2.00 },
          { name: "Stuffed Crust", price: 2.50 },
          { name: "Gluten Free", price: 3.00 },
        ],
      },
      {
        name: "Extra Toppings",
        minSelections: 0,
        maxSelections: 10,
        modifiers: [
          { name: "Pepperoni", price: 1.50 },
          { name: "Sausage", price: 1.50 },
          { name: "Mushrooms", price: 1.00 },
          { name: "Onions", price: 1.00 },
          { name: "Green Peppers", price: 1.00 },
          { name: "Black Olives", price: 1.00 },
          { name: "Bacon", price: 2.00 },
          { name: "Extra Cheese", price: 1.50 },
          { name: "Jalapeños", price: 1.00 },
          { name: "Pineapple", price: 1.00 },
        ],
      },
    ],
  },

  sandwich_toppings: {
    name: "Sandwich Toppings",
    description: "Sub/sandwich add-ons and extras",
    sections: [
      {
        name: "Bread",
        minSelections: 1,
        maxSelections: 1,
        modifiers: [
          { name: "White", price: 0, isDefault: true },
          { name: "Wheat", price: 0 },
          { name: "Sourdough", price: 0 },
          { name: "Rye", price: 0 },
          { name: "Wrap", price: 0 },
          { name: "Gluten Free Bread", price: 1.50 },
        ],
      },
      {
        name: "Toppings",
        minSelections: 0,
        maxSelections: 10,
        modifiers: [
          { name: "Lettuce", price: 0 },
          { name: "Tomato", price: 0 },
          { name: "Onion", price: 0 },
          { name: "Pickles", price: 0 },
          { name: "Jalapeños", price: 0 },
          { name: "Banana Peppers", price: 0 },
          { name: "Avocado", price: 1.50 },
          { name: "Bacon", price: 2.00 },
          { name: "Extra Cheese", price: 1.00 },
        ],
      },
      {
        name: "Sauce",
        minSelections: 0,
        maxSelections: 2,
        modifiers: [
          { name: "Mayo", price: 0 },
          { name: "Mustard", price: 0 },
          { name: "Ranch", price: 0 },
          { name: "Chipotle Mayo", price: 0 },
          { name: "Oil & Vinegar", price: 0 },
          { name: "Hot Sauce", price: 0 },
        ],
      },
    ],
  },

  meat_temperature: {
    name: "Meat Temperature",
    description: "Steak/burger cook temperature",
    sections: [
      {
        name: "Temperature",
        minSelections: 1,
        maxSelections: 1,
        modifiers: [
          { name: "Rare", price: 0 },
          { name: "Medium Rare", price: 0, isDefault: true },
          { name: "Medium", price: 0 },
          { name: "Medium Well", price: 0 },
          { name: "Well Done", price: 0 },
        ],
      },
    ],
  },

  drink_sizes: {
    name: "Drink Sizes",
    description: "Small/Medium/Large sizing",
    sections: [
      {
        name: "Size",
        minSelections: 1,
        maxSelections: 1,
        modifiers: [
          { name: "Small", price: 0, isDefault: true },
          { name: "Medium", price: 0.50 },
          { name: "Large", price: 1.00 },
          { name: "Extra Large", price: 1.50 },
        ],
      },
    ],
  },

  salad_options: {
    name: "Salad Options",
    description: "Dressing and protein add-ons",
    sections: [
      {
        name: "Dressing",
        minSelections: 1,
        maxSelections: 1,
        modifiers: [
          { name: "Ranch", price: 0, isDefault: true },
          { name: "Caesar", price: 0 },
          { name: "Balsamic Vinaigrette", price: 0 },
          { name: "Italian", price: 0 },
          { name: "Blue Cheese", price: 0 },
          { name: "No Dressing", price: 0 },
        ],
      },
      {
        name: "Add Protein",
        minSelections: 0,
        maxSelections: 1,
        modifiers: [
          { name: "Grilled Chicken", price: 3.50 },
          { name: "Grilled Shrimp", price: 5.00 },
          { name: "Steak", price: 5.50 },
          { name: "Salmon", price: 6.00 },
        ],
      },
    ],
  },

  breakfast_eggs: {
    name: "Egg Preparation",
    description: "How eggs should be cooked",
    sections: [
      {
        name: "Egg Style",
        minSelections: 1,
        maxSelections: 1,
        modifiers: [
          { name: "Scrambled", price: 0, isDefault: true },
          { name: "Over Easy", price: 0 },
          { name: "Over Medium", price: 0 },
          { name: "Over Hard", price: 0 },
          { name: "Sunny Side Up", price: 0 },
          { name: "Poached", price: 0 },
        ],
      },
    ],
  },

  sides: {
    name: "Side Options",
    description: "Choice of side dish",
    sections: [
      {
        name: "Choose a Side",
        minSelections: 1,
        maxSelections: 1,
        modifiers: [
          { name: "French Fries", price: 0, isDefault: true },
          { name: "Sweet Potato Fries", price: 1.00 },
          { name: "Onion Rings", price: 1.50 },
          { name: "Coleslaw", price: 0 },
          { name: "Side Salad", price: 0.50 },
          { name: "Mac & Cheese", price: 1.50 },
          { name: "Soup of the Day", price: 1.00 },
        ],
      },
    ],
  },

  bar_mixers: {
    name: "Bar Mixers",
    description: "Cocktail mixer and garnish options",
    sections: [
      {
        name: "Mixer",
        minSelections: 0,
        maxSelections: 2,
        modifiers: [
          { name: "Coke", price: 0 },
          { name: "Sprite", price: 0 },
          { name: "Tonic Water", price: 0 },
          { name: "Soda Water", price: 0 },
          { name: "Ginger Ale", price: 0 },
          { name: "Orange Juice", price: 0 },
          { name: "Cranberry Juice", price: 0 },
          { name: "Pineapple Juice", price: 0 },
        ],
      },
      {
        name: "Garnish",
        minSelections: 0,
        maxSelections: 2,
        modifiers: [
          { name: "Lime", price: 0 },
          { name: "Lemon", price: 0 },
          { name: "Orange", price: 0 },
          { name: "Cherry", price: 0 },
          { name: "Olive", price: 0 },
        ],
      },
    ],
  },
};

export const PRESET_LIST = Object.entries(MODIFIER_PRESETS).map(
  ([key, preset]) => ({
    key,
    name: preset.name,
    description: preset.description,
  }),
);
