// Ported from pos-scaffold/app/core/generator.py
// SQL generator for POS modifier templates.
//
// MariaDB column types (from live pecandemodb):
//   Prices: decimal(65,30)
//   Datetimes: datetime(6)
//   IDs: char(36)

export function newUuid(): string {
  return crypto.randomUUID();
}

export function nowStr(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.` +
    `${pad(d.getMilliseconds() * 1000, 6)}`
  );
}

export function price(val: number | null | undefined): string {
  return (val ?? 0).toFixed(30);
}

/** Returns SQL NULL for zero/null/undefined — used for per-mode prices
 *  (DineInPrice, BarPrice, etc.) so the POS falls back to DefaultPrice. */
export function priceOrNull(val: number | null | undefined): string {
  return val ? val.toFixed(30) : "NULL";
}

export function esc(value: string | null | undefined): string {
  if (value == null) return "";
  return String(value).replace(/'/g, "''").replace(/\\/g, "\\\\");
}

// ---------------------------------------------------------------------------
// Modifier SQL
// ---------------------------------------------------------------------------

export function generateModifierSql(opts: {
  name: string;
  price?: number;
  isActive?: number;
  isOptional?: number;
  isPizzaTopping?: number;
  isPizzaCrust?: number;
  isBarMixer?: number;
  isBarDrink?: number;
  modifierId?: string;
  imagePath?: string | null;
  color?: string | null;
}): { id: string; sql: string } {
  const mid = opts.modifierId || newUuid();
  const ts = nowStr();
  const picSql = opts.imagePath ? `'${esc(opts.imagePath)}'` : "NULL";
  const colorSql = opts.color ? `'${esc(opts.color)}'` : "NULL";

  return {
    id: mid,
    sql:
      `REPLACE INTO \`menumodifiers\` ` +
      `(\`Id\`, \`Name\`, \`Price\`, \`HalfPrice\`, \`ThirdPrice\`, \`QuarterPrice\`, ` +
      `\`IsPizzaCrust\`, \`IsPizzaTopping\`, \`IsBarMixer\`, \`IsBarDrink\`, ` +
      `\`IsActive\`, \`IsOptional\`, \`PicturePath\`, \`Color\`, ` +
      `\`CreatedOn\`, \`ModifiedOn\`, \`IsDeleted\`) VALUES (\n` +
      `  '${mid}', '${esc(opts.name)}', ` +
      `${price(opts.price ?? 0)}, ${price(0)}, ${price(0)}, ${price(0)}, ` +
      `${opts.isPizzaCrust ?? 0}, ${opts.isPizzaTopping ?? 0}, ${opts.isBarMixer ?? 0}, ${opts.isBarDrink ?? 0}, ` +
      `${opts.isActive ?? 1}, ${opts.isOptional ?? 0}, ${picSql}, ${colorSql}, ` +
      `'${ts}', '${ts}', 0);`,
  };
}

// ---------------------------------------------------------------------------
// Template SQL (template + sections + modifiers + grid items)
// ---------------------------------------------------------------------------

export interface TemplateSection {
  name: string;
  min_selections: number;
  max_selections: number;
  modifiers: TemplateModifier[];
}

export interface TemplateModifier {
  name: string;
  price?: number;
  additional_price?: number;
  preselected?: boolean;
  is_pizza_topping?: boolean;
  is_pizza_crust?: boolean;
  is_bar_mixer?: boolean;
  is_bar_drink?: boolean;
  image_path?: string | null;
  image_url?: string | null;
  color?: string | null;
}

export function generateTemplateSql(
  templateName: string,
  sections: TemplateSection[],
  templateId?: string,
): { templateId: string; sql: string } {
  const tid = templateId || newUuid();
  const ts = nowStr();
  const statements: string[] = [];

  // 1. Create the template
  statements.push(
    `-- Modifier Template: ${templateName}\n` +
      `REPLACE INTO \`menumodifiertemplates\` ` +
      `(\`Id\`, \`Name\`, \`CreatedOn\`, \`ModifiedOn\`, \`IsDeleted\`) VALUES (\n` +
      `  '${tid}', '${esc(templateName)}', '${ts}', '${ts}', 0);`,
  );

  const modifierIds: Record<string, string> = {};
  const MOD_GRID_COLS = 6;

  for (let secIdx = 0; secIdx < sections.length; secIdx++) {
    const section = sections[secIdx];
    const sid = newUuid();

    // 2. Create the section
    statements.push(
      `\n-- Section: ${section.name}\n` +
        `REPLACE INTO \`menumodifiertemplatesections\` ` +
        `(\`Id\`, \`Name\`, \`MinSelections\`, \`MaxSelections\`, \`DefaultView\`, ` +
        `\`RowIndex\`, \`ColumnIndex\`, \`MenuModifierTemplateId\`, ` +
        `\`CreatedOn\`, \`ModifiedOn\`, \`IsDeleted\`) VALUES (\n` +
        `  '${sid}', '${esc(section.name)}', ${section.min_selections}, ${section.max_selections}, 0, ` +
        `${secIdx}, 0, '${tid}', '${ts}', '${ts}', 0);`,
    );

    // 3. Create modifiers and template items
    let modRow = 0;
    let modCol = 0;

    for (const mod of section.modifiers) {
      if (!(mod.name in modifierIds)) {
        const modResult = generateModifierSql({
          name: mod.name,
          price: mod.price ?? 0,
          isPizzaTopping: mod.is_pizza_topping ? 1 : 0,
          isPizzaCrust: mod.is_pizza_crust ? 1 : 0,
          isBarMixer: mod.is_bar_mixer ? 1 : 0,
          isBarDrink: mod.is_bar_drink ? 1 : 0,
          imagePath: mod.image_path,
          color: mod.color,
        });
        modifierIds[mod.name] = modResult.id;
        statements.push(modResult.sql);
      }

      const mid = modifierIds[mod.name];
      const additionalPrice = mod.additional_price ?? 0;
      const itemId = newUuid();
      const preselectedPrefix = mod.preselected ? "1" : "NULL";

      statements.push(
        `REPLACE INTO \`menumodifiertemplateitems\` ` +
          `(\`Id\`, \`RowIndex\`, \`ColumnIndex\`, \`IsHidden\`, ` +
          `\`MenuModifierTemplateSectionId\`, \`MenuModifierId\`, ` +
          `\`AdditionalPrice\`, \`ShowNameOnOrderEntry\`, \`PreselectedPrefix\`, ` +
          `\`CreatedOn\`, \`ModifiedOn\`, \`IsDeleted\`) VALUES (\n` +
          `  '${itemId}', ${modRow}, ${modCol}, 0, ` +
          `'${sid}', '${mid}', ` +
          `${price(additionalPrice)}, 1, ${preselectedPrefix}, ` +
          `'${ts}', '${ts}', 0);`,
      );

      modCol++;
      if (modCol >= MOD_GRID_COLS) {
        modCol = 0;
        modRow++;
      }
    }
  }

  return { templateId: tid, sql: statements.join("\n") };
}
