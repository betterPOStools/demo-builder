// Ported from template-builder/src/lib/menuImport.ts
// Converts 20-column MenuRow[] into ImportedMenuItem[]

import type { CategoryName, ImportedMenuItem } from "@/lib/types";
import type { MenuRow } from "@/lib/types";

function toNumber(val: string | number): number {
  if (typeof val === "number") return val;
  const n = parseFloat(val);
  return isNaN(n) ? 0 : n;
}

function toBool(val: string | boolean | undefined | null): boolean {
  if (typeof val === "boolean") return val;
  if (typeof val !== "string") return false;
  return val.toUpperCase() === "TRUE";
}

function toCategory(val: string): CategoryName {
  const normalized = val.trim();
  if (normalized === "Food" || normalized === "Beverages" || normalized === "Bar") {
    return normalized;
  }
  const lower = normalized.toLowerCase();
  if (lower.includes("bev") || lower.includes("drink")) return "Beverages";
  if (lower.includes("bar")) return "Bar";
  return "Food";
}

function parseMenuRow(row: MenuRow): ImportedMenuItem {
  return {
    name: row["Menu Item Full Name"],
    group: row["Menu Item Group"],
    category: toCategory(row["Menu Item Category"]),
    defaultPrice: toNumber(row["Default Price"]),
    dineInPrice: toNumber(row["Dine In Price"]),
    barPrice: toNumber(row["Bar Price"]),
    pickUpPrice: toNumber(row["Pick Up Price"]),
    takeOutPrice: toNumber(row["Take Out Price"]),
    deliveryPrice: toNumber(row["Delivery Price"]),
    isOpenPrice: toBool(row["Open Price Item"]),
    printAt: toNumber(row["POS Orders Print At"]),
    tax1: toBool(row["Tax 1"]),
    tax2: toBool(row["Tax 2"]),
    tax3: toBool(row["Tax 3"]),
    isBarItem: toBool(row["This Is A Bar Item"]),
    isWeighted: toBool(row["This Is A Weighted Item"]),
    tare: toNumber(row["Tare"]),
    barcode: row["Barcode"] || null,
    isFolder: toBool(row["Item Folder"]),
    belongsToFolder: row["Belongs To Item Folder"] || null,
  };
}

export function parseMenuRows(rows: MenuRow[]): ImportedMenuItem[] {
  return rows
    .filter((row) => row["Menu Item Full Name"]?.trim())
    .map(parseMenuRow);
}
