// Ported from adv-menu-import/lib/menu/normalizeRows.ts

import { COLUMNS, BOOLEAN_COLS } from "@/lib/types/menu";
import type { MenuRow } from "@/lib/types/menu";

export interface ExtendedMenuRow extends MenuRow {
  "Modifier Template": string | null;
}

export interface NormalizeExtendedResult {
  posRows: MenuRow[];
  extendedRows: ExtendedMenuRow[];
  restaurantType: string;
}

export function normalizeRows(rows: Record<string, unknown>[]): MenuRow[] {
  return rows
    .filter((r) => {
      const name = r["Menu Item Full Name"];
      return name != null && String(name).trim() !== "";
    })
    .map((r) => {
      const out: Record<string, string | number> = {};
      for (const col of COLUMNS) {
        const raw: unknown = r[col] ?? "";
        let val: string | number;
        if (BOOLEAN_COLS.has(col)) {
          val = raw === true || raw === "TRUE" || raw === "true" ? "TRUE" : "FALSE";
        } else {
          val = (raw as string | number) ?? "";
        }
        out[col] = val;
      }
      if (!out["POS Orders Print At"] && out["POS Orders Print At"] !== 0) {
        out["POS Orders Print At"] = 1;
      }
      if (
        out["Default Price"] === "" ||
        out["Default Price"] === null ||
        out["Default Price"] === undefined
      ) {
        out["Default Price"] = 0;
      }
      return out as MenuRow;
    });
}

export function normalizeExtendedRows(
  rawItems: Record<string, unknown>[],
  rawRestaurantType?: string,
): NormalizeExtendedResult {
  const restaurantType = rawRestaurantType || "other";
  const posRows = normalizeRows(rawItems);

  const extendedRows: ExtendedMenuRow[] = rawItems
    .filter((r) => {
      const name = r["Menu Item Full Name"];
      return name != null && String(name).trim() !== "";
    })
    .map((r) => {
      const out: Record<string, string | number> = {};
      for (const col of COLUMNS) {
        const raw: unknown = r[col] ?? "";
        let val: string | number;
        if (BOOLEAN_COLS.has(col)) {
          val = raw === true || raw === "TRUE" || raw === "true" ? "TRUE" : "FALSE";
        } else {
          val = (raw as string | number) ?? "";
        }
        out[col] = val;
      }
      if (!out["POS Orders Print At"] && out["POS Orders Print At"] !== 0) {
        out["POS Orders Print At"] = 1;
      }
      if (
        out["Default Price"] === "" ||
        out["Default Price"] === null ||
        out["Default Price"] === undefined
      ) {
        out["Default Price"] = 0;
      }
      return {
        ...(out as MenuRow),
        "Modifier Template": (r["Modifier Template"] as string) || null,
      };
    });

  return { posRows, extendedRows, restaurantType };
}
