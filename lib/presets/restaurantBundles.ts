// Pre-built restaurant bundles for quick-start demos.
// Each bundle defines groups with items, modifier template keys, and a layout preset key.

import type { CategoryName } from "@/lib/types";

interface BundleItem {
  name: string;
  price: number;
  printAt?: number;
  isBarItem?: boolean;
}

interface BundleGroup {
  name: string;
  category: CategoryName;
  items: BundleItem[];
}

export interface RestaurantBundle {
  key: string;
  name: string;
  description: string;
  icon: string;
  restaurantType: string;
  groups: BundleGroup[];
  templateKeys: string[];
  layoutPresetKey: string;
}

export const RESTAURANT_BUNDLES: RestaurantBundle[] = [
  {
    key: "pizza_shop",
    name: "Pizza Shop",
    description: "Pizzas, appetizers, salads, drinks, and desserts",
    icon: "🍕",
    restaurantType: "pizza",
    groups: [
      {
        name: "Pizzas",
        category: "Food",
        items: [
          { name: "Cheese Pizza", price: 12.99 },
          { name: "Pepperoni Pizza", price: 14.99 },
          { name: "Margherita Pizza", price: 13.99 },
          { name: "BBQ Chicken Pizza", price: 15.99 },
          { name: "Hawaiian Pizza", price: 14.99 },
          { name: "Veggie Supreme", price: 14.99 },
          { name: "Meat Lovers Pizza", price: 16.99 },
          { name: "White Pizza", price: 13.99 },
        ],
      },
      {
        name: "Appetizers",
        category: "Food",
        items: [
          { name: "Garlic Bread", price: 5.99 },
          { name: "Mozzarella Sticks", price: 7.99 },
          { name: "Bruschetta", price: 8.99 },
          { name: "Fried Calamari", price: 9.99 },
          { name: "Wings (6pc)", price: 8.99 },
        ],
      },
      {
        name: "Salads",
        category: "Food",
        items: [
          { name: "Caesar Salad", price: 9.99 },
          { name: "Garden Salad", price: 7.99 },
          { name: "Greek Salad", price: 10.99 },
          { name: "Caprese Salad", price: 10.99 },
        ],
      },
      {
        name: "Drinks",
        category: "Beverages",
        items: [
          { name: "Fountain Drink", price: 2.99 },
          { name: "Iced Tea", price: 2.99 },
          { name: "Lemonade", price: 3.49 },
          { name: "Bottled Water", price: 1.99 },
          { name: "Italian Soda", price: 3.99 },
        ],
      },
      {
        name: "Desserts",
        category: "Food",
        items: [
          { name: "Tiramisu", price: 7.99 },
          { name: "Cannoli", price: 5.99 },
          { name: "Gelato", price: 5.99 },
          { name: "Chocolate Cake", price: 6.99 },
        ],
      },
    ],
    templateKeys: ["pizza_modifiers", "drink_modifiers"],
    layoutPresetKey: "small_restaurant",
  },

  {
    key: "bar_grill",
    name: "Bar & Grill",
    description: "Burgers, wings, sandwiches, draft beer, and cocktails",
    icon: "🍔",
    restaurantType: "bar_grill",
    groups: [
      {
        name: "Burgers",
        category: "Food",
        items: [
          { name: "Classic Burger", price: 12.99, printAt: 1 },
          { name: "Bacon Cheeseburger", price: 14.99, printAt: 1 },
          { name: "Mushroom Swiss Burger", price: 14.99, printAt: 1 },
          { name: "BBQ Burger", price: 13.99, printAt: 1 },
          { name: "Turkey Burger", price: 13.99, printAt: 1 },
          { name: "Veggie Burger", price: 12.99, printAt: 1 },
        ],
      },
      {
        name: "Wings",
        category: "Food",
        items: [
          { name: "Buffalo Wings (6pc)", price: 9.99, printAt: 1 },
          { name: "Buffalo Wings (12pc)", price: 16.99, printAt: 1 },
          { name: "BBQ Wings (6pc)", price: 9.99, printAt: 1 },
          { name: "Garlic Parmesan Wings", price: 10.99, printAt: 1 },
          { name: "Honey Sriracha Wings", price: 10.99, printAt: 1 },
        ],
      },
      {
        name: "Sandwiches",
        category: "Food",
        items: [
          { name: "Club Sandwich", price: 11.99, printAt: 1 },
          { name: "Philly Cheesesteak", price: 13.99, printAt: 1 },
          { name: "Chicken Sandwich", price: 12.99, printAt: 1 },
          { name: "BLT", price: 10.99, printAt: 1 },
          { name: "Reuben", price: 12.99, printAt: 1 },
        ],
      },
      {
        name: "Bar Appetizers",
        category: "Food",
        items: [
          { name: "Loaded Nachos", price: 10.99, printAt: 1 },
          { name: "Onion Rings", price: 7.99, printAt: 1 },
          { name: "Quesadilla", price: 9.99, printAt: 1 },
          { name: "Sliders (3pc)", price: 11.99, printAt: 1 },
        ],
      },
      {
        name: "Draft Beer",
        category: "Bar",
        items: [
          { name: "Bud Light", price: 5.0, printAt: 4, isBarItem: true },
          { name: "Miller Lite", price: 5.0, printAt: 4, isBarItem: true },
          { name: "IPA", price: 7.0, printAt: 4, isBarItem: true },
          { name: "Amber Ale", price: 7.0, printAt: 4, isBarItem: true },
          { name: "Stout", price: 7.5, printAt: 4, isBarItem: true },
          { name: "Wheat Beer", price: 6.5, printAt: 4, isBarItem: true },
        ],
      },
      {
        name: "Cocktails",
        category: "Bar",
        items: [
          { name: "Margarita", price: 10.0, printAt: 4, isBarItem: true },
          { name: "Old Fashioned", price: 12.0, printAt: 4, isBarItem: true },
          { name: "Moscow Mule", price: 11.0, printAt: 4, isBarItem: true },
          { name: "Long Island", price: 12.0, printAt: 4, isBarItem: true },
          { name: "Mojito", price: 11.0, printAt: 4, isBarItem: true },
          { name: "Whiskey Sour", price: 10.0, printAt: 4, isBarItem: true },
        ],
      },
    ],
    templateKeys: ["burger_modifiers", "drink_modifiers"],
    layoutPresetKey: "bar_focused",
  },

  {
    key: "fine_dining",
    name: "Fine Dining",
    description: "Starters, entrees, steaks, seafood, desserts, and wine",
    icon: "🥩",
    restaurantType: "fine_dining",
    groups: [
      {
        name: "Starters",
        category: "Food",
        items: [
          { name: "Lobster Bisque", price: 14.0 },
          { name: "Beef Carpaccio", price: 16.0 },
          { name: "Tuna Tartare", price: 18.0 },
          { name: "Caesar Salad", price: 12.0 },
          { name: "Burrata", price: 15.0 },
        ],
      },
      {
        name: "Entrees",
        category: "Food",
        items: [
          { name: "Pan-Seared Salmon", price: 32.0 },
          { name: "Rack of Lamb", price: 38.0 },
          { name: "Duck Breast", price: 34.0 },
          { name: "Truffle Risotto", price: 28.0 },
          { name: "Chicken Marsala", price: 26.0 },
        ],
      },
      {
        name: "Steaks",
        category: "Food",
        items: [
          { name: "Filet Mignon 8oz", price: 48.0 },
          { name: "NY Strip 12oz", price: 44.0 },
          { name: "Ribeye 14oz", price: 52.0 },
          { name: "Wagyu 6oz", price: 85.0 },
          { name: "Tomahawk 32oz", price: 95.0 },
        ],
      },
      {
        name: "Seafood",
        category: "Food",
        items: [
          { name: "Lobster Tail", price: 45.0 },
          { name: "Chilean Sea Bass", price: 38.0 },
          { name: "Grilled Branzino", price: 34.0 },
          { name: "Shrimp Scampi", price: 28.0 },
        ],
      },
      {
        name: "Desserts",
        category: "Food",
        items: [
          { name: "Creme Brulee", price: 12.0 },
          { name: "Chocolate Souffle", price: 14.0 },
          { name: "Tiramisu", price: 12.0 },
          { name: "Cheese Board", price: 18.0 },
        ],
      },
      {
        name: "Wine",
        category: "Bar",
        items: [
          { name: "House Red (glass)", price: 12.0, printAt: 4, isBarItem: true },
          { name: "House White (glass)", price: 12.0, printAt: 4, isBarItem: true },
          { name: "Pinot Noir", price: 15.0, printAt: 4, isBarItem: true },
          { name: "Cabernet Sauvignon", price: 16.0, printAt: 4, isBarItem: true },
          { name: "Chardonnay", price: 14.0, printAt: 4, isBarItem: true },
          { name: "Prosecco (glass)", price: 14.0, printAt: 4, isBarItem: true },
        ],
      },
    ],
    templateKeys: ["steak_modifiers", "drink_modifiers"],
    layoutPresetKey: "fine_dining",
  },

  {
    key: "cafe",
    name: "Cafe",
    description: "Hot drinks, cold drinks, pastries, sandwiches, and salads",
    icon: "☕",
    restaurantType: "cafe",
    groups: [
      {
        name: "Hot Drinks",
        category: "Beverages",
        items: [
          { name: "Espresso", price: 3.5 },
          { name: "Americano", price: 4.0 },
          { name: "Cappuccino", price: 5.0 },
          { name: "Latte", price: 5.5 },
          { name: "Mocha", price: 5.5 },
          { name: "Hot Chocolate", price: 4.5 },
          { name: "Chai Latte", price: 5.0 },
          { name: "Green Tea", price: 3.5 },
        ],
      },
      {
        name: "Cold Drinks",
        category: "Beverages",
        items: [
          { name: "Iced Coffee", price: 4.5 },
          { name: "Iced Latte", price: 5.5 },
          { name: "Cold Brew", price: 5.0 },
          { name: "Iced Matcha", price: 5.5 },
          { name: "Fruit Smoothie", price: 6.5 },
          { name: "Fresh Lemonade", price: 4.0 },
        ],
      },
      {
        name: "Pastries",
        category: "Food",
        items: [
          { name: "Croissant", price: 3.5 },
          { name: "Blueberry Muffin", price: 3.99 },
          { name: "Cinnamon Roll", price: 4.5 },
          { name: "Scone", price: 3.5 },
          { name: "Banana Bread", price: 3.99 },
          { name: "Cookie", price: 2.5 },
        ],
      },
      {
        name: "Sandwiches",
        category: "Food",
        items: [
          { name: "Turkey Avocado", price: 10.99 },
          { name: "Caprese Panini", price: 9.99 },
          { name: "Chicken Pesto", price: 10.99 },
          { name: "BLT Croissant", price: 9.99 },
          { name: "Veggie Wrap", price: 8.99 },
        ],
      },
      {
        name: "Salads",
        category: "Food",
        items: [
          { name: "Kale Caesar", price: 10.99 },
          { name: "Mediterranean Bowl", price: 11.99 },
          { name: "Cobb Salad", price: 11.99 },
          { name: "Quinoa Bowl", price: 10.99 },
        ],
      },
    ],
    templateKeys: ["drink_modifiers"],
    layoutPresetKey: "fast_casual",
  },

  {
    key: "fast_casual",
    name: "Fast Casual",
    description: "Sandwiches, wraps, bowls, sides, and drinks",
    icon: "🥪",
    restaurantType: "fast_casual",
    groups: [
      {
        name: "Sandwiches",
        category: "Food",
        items: [
          { name: "Italian Sub", price: 10.99 },
          { name: "Turkey Club", price: 10.99 },
          { name: "Roast Beef & Cheddar", price: 11.99 },
          { name: "Chicken Parmesan Sub", price: 11.99 },
          { name: "Meatball Sub", price: 10.99 },
          { name: "Veggie Deluxe", price: 9.99 },
        ],
      },
      {
        name: "Wraps",
        category: "Food",
        items: [
          { name: "Chicken Caesar Wrap", price: 10.99 },
          { name: "Buffalo Chicken Wrap", price: 10.99 },
          { name: "Mediterranean Wrap", price: 9.99 },
          { name: "Southwest Wrap", price: 10.99 },
        ],
      },
      {
        name: "Bowls",
        category: "Food",
        items: [
          { name: "Chicken Rice Bowl", price: 11.99 },
          { name: "Poke Bowl", price: 13.99 },
          { name: "Burrito Bowl", price: 11.99 },
          { name: "Teriyaki Bowl", price: 11.99 },
          { name: "Falafel Bowl", price: 10.99 },
        ],
      },
      {
        name: "Sides",
        category: "Food",
        items: [
          { name: "French Fries", price: 3.99 },
          { name: "Sweet Potato Fries", price: 4.99 },
          { name: "Chips & Salsa", price: 3.99 },
          { name: "Side Salad", price: 4.99 },
          { name: "Soup of the Day", price: 5.99 },
        ],
      },
      {
        name: "Drinks",
        category: "Beverages",
        items: [
          { name: "Fountain Drink", price: 2.49 },
          { name: "Bottled Water", price: 1.99 },
          { name: "Fresh Juice", price: 4.99 },
          { name: "Iced Tea", price: 2.49 },
          { name: "Smoothie", price: 5.99 },
        ],
      },
    ],
    templateKeys: ["sandwich_modifiers", "drink_modifiers"],
    layoutPresetKey: "fast_casual",
  },

  {
    key: "breakfast_diner",
    name: "Breakfast Diner",
    description: "Egg plates, pancakes, omelets, sides, and beverages",
    icon: "🍳",
    restaurantType: "breakfast",
    groups: [
      {
        name: "Egg Plates",
        category: "Food",
        items: [
          { name: "2 Eggs Any Style", price: 8.99 },
          { name: "Eggs Benedict", price: 12.99 },
          { name: "Huevos Rancheros", price: 11.99 },
          { name: "Steak & Eggs", price: 15.99 },
          { name: "Country Breakfast", price: 11.99 },
        ],
      },
      {
        name: "Pancakes & Waffles",
        category: "Food",
        items: [
          { name: "Buttermilk Pancakes", price: 9.99 },
          { name: "Blueberry Pancakes", price: 10.99 },
          { name: "Belgian Waffle", price: 10.99 },
          { name: "French Toast", price: 10.99 },
          { name: "Chocolate Chip Pancakes", price: 10.99 },
        ],
      },
      {
        name: "Omelets",
        category: "Food",
        items: [
          { name: "Western Omelet", price: 11.99 },
          { name: "Veggie Omelet", price: 10.99 },
          { name: "Cheese Omelet", price: 9.99 },
          { name: "Meat Lovers Omelet", price: 12.99 },
          { name: "Spinach Feta Omelet", price: 11.99 },
        ],
      },
      {
        name: "Sides",
        category: "Food",
        items: [
          { name: "Bacon (3 strips)", price: 3.99 },
          { name: "Sausage Links (3)", price: 3.99 },
          { name: "Hash Browns", price: 3.49 },
          { name: "Toast", price: 2.49 },
          { name: "Fresh Fruit Cup", price: 4.99 },
          { name: "Biscuits & Gravy", price: 5.99 },
        ],
      },
      {
        name: "Beverages",
        category: "Beverages",
        items: [
          { name: "Coffee", price: 2.99 },
          { name: "Decaf Coffee", price: 2.99 },
          { name: "Hot Tea", price: 2.99 },
          { name: "Orange Juice", price: 3.99 },
          { name: "Apple Juice", price: 3.99 },
          { name: "Milk", price: 2.99 },
          { name: "Chocolate Milk", price: 3.49 },
        ],
      },
    ],
    templateKeys: ["breakfast_modifiers"],
    layoutPresetKey: "small_restaurant",
  },
];
