// Ported from pos-scaffold/app/core/deployer.py
// Full menu deployment SQL generator.

import { newUuid, nowStr, esc, price, priceOrNull, generateTemplateSql } from "./generator";
import { generateRoomSql, generateTableSql } from "./layout";
import type { RoomDef, TableDef } from "./layout";
import type { ParsedItem, ParsedModifierTemplate, GroupMeta } from "./designParser";

function deriveDestPath(imageUrl: string, name: string): string {
  try {
    const pathname = new URL(imageUrl).pathname;
    const filename = pathname.split("/").pop();
    if (filename) return filename;
  } catch {
    // invalid URL
  }
  const safe = name.replace(/[^a-zA-Z0-9_\-]/g, "_");
  return `${safe}.png`;
}

export interface PendingImageTransfer {
  type: "item" | "group" | "branding";
  name: string;
  entityId: string | undefined;
  imageUrl: string;  // HTTP URL or data: URI
  destPath: string;
}

export interface DeploymentResult {
  sql: string;
  stats: {
    categories: number;
    groups: number;
    menuItems: number;
    printers: number;
    modifierTemplates: number;
    rooms: number;
    tables: number;
    pendingImageTransfers: number;
  };
  groupIds: Record<string, string>;
  categoryIds: Record<string, string>;
  itemIds: Record<string, string>;
  pendingImageTransfers: PendingImageTransfer[];
}

export function generateFullDeployment(opts: {
  items: ParsedItem[];
  groups: Map<string, number>;
  categories: Map<string, number>;
  templateAssignments?: Record<string, string>;
  modifierTemplates?: ParsedModifierTemplate[];
  startItemIndex?: number;
  startGroupIndex?: number;
  groupMeta?: Record<string, GroupMeta>;
  branding?: Record<string, unknown>;
  rooms?: RoomDef[];
}): DeploymentResult {
  const {
    items,
    groups,
    categories,
    templateAssignments = {},
    modifierTemplates = [],
    startItemIndex = 1,
    startGroupIndex = 0,
    groupMeta = {},
    branding,
    rooms = [],
  } = opts;

  const ts = nowStr();
  const statements: string[] = [];

  const groupIds: Record<string, string> = {};
  const catIds: Record<string, string> = {};
  const itemIds: Record<string, string> = {};
  const pendingImageTransfers: PendingImageTransfer[] = [];

  // ---------------------------------------------------------------
  // CLEANUP — Delete existing menu data before inserting new
  // Order matters: children first, parents last (FK constraints)
  // ---------------------------------------------------------------
  statements.push("-- =============================================");
  statements.push("-- CLEANUP EXISTING MENU DATA");
  statements.push("-- (FK checks disabled by deploy agent)");
  statements.push("-- =============================================");
  statements.push("DELETE FROM `menuforcedmodifierlevelmodifiers`;");
  statements.push("DELETE FROM `menuforcedmodifierlevels`;");
  statements.push("DELETE FROM `menumodifiertemplateitemprefixes`;");
  statements.push("DELETE FROM `menuitemprinters`;");
  statements.push("DELETE FROM `menumodifiertemplateitems`;");
  statements.push("DELETE FROM `menumodifiertemplatesections`;");
  statements.push("DELETE FROM `menumodifiertemplates`;");
  statements.push("DELETE FROM `menumodifiers`;");
  statements.push("DELETE FROM `menuitems`;");
  statements.push("DELETE FROM `menugroups`;");
  statements.push("DELETE FROM `menucategories`;");
  statements.push("DELETE FROM `rooms`;");
  statements.push("DELETE FROM `tables`;");

  // ---------------------------------------------------------------
  // 0. Modifier Templates — per-item cloning
  //    POS requires one modifier template per menu item. We clone
  //    each shared template once per assigned item, naming the clone
  //    after the item (e.g., "CHEESEBURGER" template for the
  //    Cheeseburger item). This lets operators customize modifiers
  //    per item later.
  // ---------------------------------------------------------------
  // Build a map: templateName → template definition
  const templateDefMap = new Map<string, ParsedModifierTemplate>();
  for (const tmpl of modifierTemplates) {
    templateDefMap.set(tmpl.name, tmpl);
  }

  // We'll generate per-item templates during item processing (section 3)
  // and store the per-item template ID here: itemName → templateId
  const perItemTemplateIds: Record<string, string> = {};

  // ---------------------------------------------------------------
  // 1. Menu Categories
  // ---------------------------------------------------------------
  statements.push("\n-- =============================================");
  statements.push("-- MENU CATEGORIES");
  statements.push("-- =============================================");

  for (const [catName] of categories) {
    const cid = newUuid();
    catIds[catName] = cid;
    statements.push(
      `REPLACE INTO \`menucategories\` ` +
        `(\`Id\`, \`Name\`, \`IsActive\`, \`CreatedOn\`, \`ModifiedOn\`, \`IsDeleted\`) VALUES (\n` +
        `  '${cid}', '${esc(catName)}', 1, '${ts}', '${ts}', 0);`,
    );
  }

  // ---------------------------------------------------------------
  // 2. Menu Groups
  // ---------------------------------------------------------------
  statements.push("\n-- =============================================");
  statements.push("-- MENU GROUPS");
  statements.push("-- =============================================");

  const defaultGridRows = 6;
  const defaultGridCols = 3;

  let gIdx = startGroupIndex;
  for (const [groupName] of groups) {
    const gid = newUuid();
    groupIds[groupName] = gid;
    const gmeta = groupMeta[groupName] ?? {};
    const gPic = gmeta.image_path
      ? `'${esc(gmeta.image_path)}'`
      : gmeta.image_url
        ? `'${esc(deriveDestPath(gmeta.image_url, groupName))}'`
        : "NULL";
    const gColor = gmeta.color ? `'${esc(gmeta.color)}'` : "NULL";

    statements.push(
      `REPLACE INTO \`menugroups\` ` +
        `(\`Id\`, \`Name\`, \`PageIndex\`, \`Index\`, \`GridRows\`, \`GridColumns\`, ` +
        `\`IsHidden\`, \`ShowOnlyPictureInOrderEntry\`, \`IsBarGroup\`, ` +
        `\`IsDineInAvailable\`, \`IsPickUpAvailable\`, \`IsTakeOutAvailable\`, ` +
        `\`IsBarAvailable\`, \`IsDeliveryAvailable\`, ` +
        `\`IsDineInDefault\`, \`IsPickUpDefault\`, \`IsTakeOutDefault\`, ` +
        `\`IsBarDefault\`, \`IsDeliveryDefault\`, ` +
        `\`PicturePath\`, \`Color\`, ` +
        `\`CreatedOn\`, \`ModifiedOn\`, \`IsDeleted\`, \`AvailableForKiosk\`, \`KioskIndex\`) VALUES (\n` +
        `  '${gid}', '${esc(groupName)}', 1, ${gIdx}, ${defaultGridRows}, ${defaultGridCols}, ` +
        `0, 0, 0, ` +
        `1, 1, 1, 1, 1, ` +
        `0, 0, 0, 0, 0, ` +
        `${gPic}, ${gColor}, ` +
        `'${ts}', '${ts}', 0, 1, ${gIdx});`,
    );
    gIdx++;
  }

  // ---------------------------------------------------------------
  // 3. Per-Item Modifier Templates + Menu Items + Printer Assignments
  //    Generate per-item template clones BEFORE inserting items
  //    so the template IDs are available for the MenuModifierTemplateId column.
  // ---------------------------------------------------------------

  // First pass: generate per-item templates
  const templateStatements: string[] = [];
  const usedTemplateNames = new Set<string>();

  for (const item of items) {
    const assignedTemplateName =
      templateAssignments[item.name] ?? templateAssignments[item.group];
    if (!assignedTemplateName) continue;

    const tmplDef = templateDefMap.get(assignedTemplateName);
    if (!tmplDef) continue;

    // Clone template named after the item (uppercase for POS convention)
    const perItemName = item.name.toUpperCase();
    // Deduplicate — if two items have the same name, only first gets a template
    if (usedTemplateNames.has(perItemName)) continue;
    usedTemplateNames.add(perItemName);

    const result = generateTemplateSql(perItemName, tmplDef.sections);
    perItemTemplateIds[item.name] = result.templateId;
    templateStatements.push(result.sql);
  }

  if (templateStatements.length > 0) {
    statements.push("\n-- =============================================");
    statements.push("-- MODIFIER TEMPLATES (per-item clones)");
    statements.push("-- =============================================");
    statements.push(...templateStatements);
  }

  // Second pass: menu items
  statements.push("\n-- =============================================");
  statements.push("-- MENU ITEMS");
  statements.push("-- =============================================");

  let itemIndex = startItemIndex;
  const groupRowCounter: Record<string, [number, number]> = {};

  for (const item of items) {
    const iid = newUuid();
    itemIds[item.name] = iid;

    const gid = groupIds[item.group] ?? "NULL";
    const cid = catIds[item.category] ?? null;

    // Grid positioning
    if (!groupRowCounter[item.group]) {
      groupRowCounter[item.group] = [0, 0];
    }
    const [rowIdx, colIdx] = groupRowCounter[item.group];
    let nextCol = colIdx + 1;
    let nextRow = rowIdx;
    if (nextCol >= defaultGridCols) {
      nextCol = 0;
      nextRow = rowIdx + 1;
    }
    groupRowCounter[item.group] = [nextRow, nextCol];

    // Per-item modifier template
    const modTemplateId = perItemTemplateIds[item.name]
      ? `'${perItemTemplateIds[item.name]}'`
      : "NULL";

    const cidSql = cid ? `'${cid}'` : "NULL";
    const barcodeSql = item.barcode ? `'${esc(item.barcode)}'` : "NULL";

    // Image path: handle data URIs (AI-generated), regular paths, and Supabase URLs
    let itemPicSql = "NULL";
    if (item.image_path && item.image_path.startsWith("data:")) {
      // AI-generated image stored as data URI — deploy to POS
      const destPath = `Food\\${deriveDestPath("", item.name)}`;
      pendingImageTransfers.push({
        type: "item",
        name: item.name,
        entityId: iid,
        imageUrl: item.image_path,
        destPath,
      });
      itemPicSql = `'${esc(destPath)}'`;
    } else if (item.image_path) {
      itemPicSql = `'${esc(item.image_path)}'`;
    } else if (item.image_url) {
      itemPicSql = `'${esc(deriveDestPath(item.image_url, item.name))}'`;
    }

    const itemColorSql = item.color ? `'${esc(item.color)}'` : "NULL";

    const itemDescSql = item.description ? `'${esc(item.description)}'` : "NULL";

    statements.push(
      `REPLACE INTO \`menuitems\` ` +
        `(\`Id\`, \`Name\`, \`Description\`, \`RowIndex\`, \`ColumnIndex\`, \`Index\`, ` +
        `\`MenuGroupId\`, \`MenuCategoryId\`, \`IsHidden\`, \`IsEnabled\`, ` +
        `\`DefaultPrice\`, \`DineInPrice\`, \`BarPrice\`, ` +
        `\`PickUpPrice\`, \`TakeOutPrice\`, \`DeliveryPrice\`, ` +
        `\`IsOpenPriceItem\`, \`ApplyTax1\`, \`ApplyTax2\`, \`ApplyTax3\`, ` +
        `\`IsBarItem\`, \`IsWeightedItem\`, \`Tare\`, \`Barcode\`, ` +
        `\`IsDiscountable\`, \`DefaulModifierType\`, ` +
        `\`MenuModifierTemplateId\`, \`PicturePath\`, \`Color\`, ` +
        `\`CreatedOn\`, \`ModifiedOn\`, \`IsDeleted\`) VALUES (\n` +
        `  '${iid}', '${esc(item.name)}', ${itemDescSql}, ${rowIdx}, ${colIdx}, ${itemIndex}, ` +
        `'${gid}', ${cidSql}, 0, 1, ` +
        `${price(item.default_price)}, ${priceOrNull(item.dine_in_price)}, ${priceOrNull(item.bar_price)}, ` +
        `${priceOrNull(item.pick_up_price)}, ${priceOrNull(item.take_out_price)}, ${priceOrNull(item.delivery_price)}, ` +
        // AUTO-OPEN: if DefaultPrice is 0/null (AI couldn't extract), force
        // IsOpenPriceItem=1 so the POS prompts the cashier at ring-up instead
        // of charging $0. This overrides the caller's is_open_price flag only
        // in the zero-price case; real prices keep whatever the caller set.
        `${(!item.default_price ? 1 : item.is_open_price)}, ${item.tax1}, ${item.tax2}, ${item.tax3}, ` +
        `${item.is_bar_item}, ${item.is_weighted}, ${price(item.tare)}, ${barcodeSql}, ` +
        `1, 0, ` +
        `${modTemplateId}, ${itemPicSql}, ${itemColorSql}, ` +
        `'${ts}', '${ts}', 0);`,
    );

    // Printer assignment
    const p = item.printers;
    statements.push(
      `REPLACE INTO \`menuitemprinters\` ` +
        `(\`MenuItemId\`, \`PrintOnKitchenPrinter1\`, \`PrintOnKitchenPrinter2\`, ` +
        `\`PrintOnKitchenPrinter3\`, \`PrintOnKitchenPrinter4\`, \`PrintOnKitchenPrinter5\`, ` +
        `\`PrintOnKitchenPrinter6\`, \`PrintOnKitchenPrinter7\`, \`PrintOnKitchenPrinter8\`, ` +
        `\`PrintOnKitchenPrinter9\`, \`PrintOnKitchenPrinter10\`, \`PrintOnBarPrinter\`) VALUES (\n` +
        `  '${iid}', ${p["PrintOnKitchenPrinter1"]}, ${p["PrintOnKitchenPrinter2"]}, ` +
        `${p["PrintOnKitchenPrinter3"]}, ${p["PrintOnKitchenPrinter4"]}, ${p["PrintOnKitchenPrinter5"]}, ` +
        `${p["PrintOnKitchenPrinter6"]}, ${p["PrintOnKitchenPrinter7"]}, ${p["PrintOnKitchenPrinter8"]}, ` +
        `${p["PrintOnKitchenPrinter9"]}, ${p["PrintOnKitchenPrinter10"]}, ${p["PrintOnBarPrinter"]});`,
    );

    itemIndex++;
  }

  // ---------------------------------------------------------------
  // 4. Forced Modifier Levels (3 blank per item with template)
  // ---------------------------------------------------------------
  const itemsWithTemplates = items
    .filter((item) => perItemTemplateIds[item.name])
    .map((item) => itemIds[item.name])
    .filter(Boolean);

  if (itemsWithTemplates.length > 0) {
    statements.push("\n-- =============================================");
    statements.push("-- FORCED MODIFIER LEVELS (3 blank per item)");
    statements.push("-- =============================================");

    for (const itemId of itemsWithTemplates) {
      for (const seq of [1, 2, 3]) {
        const fmlId = newUuid();
        statements.push(
          `REPLACE INTO \`menuforcedmodifierlevels\` ` +
            `(\`Id\`, \`MenuItemId\`, \`SequenceNumber\`, ` +
            `\`CreatedOn\`, \`ModifiedOn\`, \`IsDeleted\`) VALUES (\n` +
            `  '${fmlId}', '${itemId}', ${seq}, ` +
            `'${ts}', '${ts}', 0);`,
        );
      }
    }
  }

  // ---------------------------------------------------------------
  // 5. Rooms & Tables
  // ---------------------------------------------------------------
  let roomCount = 0;
  let tableCount = 0;

  if (rooms.length > 0) {
    statements.push("\n");
    const { sql: roomSql, roomIds } = generateRoomSql(rooms);
    statements.push(roomSql);
    roomCount = rooms.length;

    // Flatten tables from all rooms
    const allTables: TableDef[] = [];
    for (const room of rooms) {
      for (const table of room.tables) {
        allTables.push({ ...table, room_name: room.name });
      }
    }

    if (allTables.length > 0) {
      statements.push("\n" + generateTableSql(allTables, roomIds));
      tableCount = allTables.length;
    }
  }

  // ---------------------------------------------------------------
  // 6. Branding / Store Settings
  // ---------------------------------------------------------------
  if (branding) {
    const brandingParts: string[] = [];
    const bg = branding.background as string | null;
    const bgPicture = branding.background_picture as string | null;
    const btnBg = branding.buttons_background_color as string | null;
    const btnFg = branding.buttons_font_color as string | null;
    const sidebar = branding.sidebar_picture as string | null;

    const storeRows: [string, string][] = [];

    // Background: if a picture is set, deploy the image and use the path as
    // the Background storesetting value. Otherwise use the hex color.
    if (bgPicture) {
      const destPath = "Background\\generated_bg.png";
      pendingImageTransfers.push({
        type: "branding",
        name: "Background Image",
        entityId: undefined,
        imageUrl: bgPicture,
        destPath,
      });
      storeRows.push(["Background", destPath]);
    } else if (bg) {
      storeRows.push(["Background", bg]);
    }

    if (btnBg) storeRows.push(["ButtonsBackgroundColor", btnBg]);
    if (btnFg) storeRows.push(["ButtonsFontColor", btnFg]);

    if (storeRows.length > 0) {
      brandingParts.push("-- =============================================");
      brandingParts.push("-- STORE BRANDING SETTINGS");
      brandingParts.push("-- =============================================");
      for (const [key, val] of storeRows) {
        brandingParts.push(
          `UPDATE \`storesettings\` SET \`Value\` = '${esc(val)}', ` +
            `\`ModifiedOn\` = '${ts}' WHERE \`Key\` = '${esc(key)}' AND \`IsDeleted\` = 0;`,
        );
      }
    }

    // Sidebar: deploy the image and use the path
    if (sidebar) {
      const sidebarPath = sidebar.startsWith("data:")
        ? "Sidebar\\generated_sidebar.png"
        : sidebar;

      if (sidebar.startsWith("data:")) {
        pendingImageTransfers.push({
          type: "branding",
          name: "Sidebar Image",
          entityId: undefined,
          imageUrl: sidebar,
          destPath: sidebarPath,
        });
      }

      brandingParts.push("\n-- =============================================");
      brandingParts.push("-- STATION SIDEBAR PICTURE");
      brandingParts.push("-- =============================================");
      brandingParts.push(
        `UPDATE \`stationsettingsvalues\` ssv ` +
          `JOIN \`stationsettingsnames\` ssn ON ssv.NameId = ssn.Id ` +
          `SET ssv.\`Value\` = '${esc(sidebarPath)}', ssv.\`ModifiedOn\` = '${ts}' ` +
          `WHERE ssn.\`Key\` = 'SidebarPicture' AND ssv.\`IsDeleted\` = 0;`,
      );
    }

    if (brandingParts.length > 0) {
      statements.push("\n" + brandingParts.join("\n"));
    }
  }

  // ---------------------------------------------------------------
  // Collect pending image transfers (item + group images)
  // ---------------------------------------------------------------
  for (const item of items) {
    // Skip items with data URI image_path — already added during item SQL generation
    if (item.image_path?.startsWith("data:")) continue;
    if (item.image_url) {
      pendingImageTransfers.push({
        type: "item",
        name: item.name,
        entityId: itemIds[item.name],
        imageUrl: item.image_url,
        destPath: item.image_path || deriveDestPath(item.image_url, item.name),
      });
    }
  }

  for (const [groupName, gmeta] of Object.entries(groupMeta)) {
    if (gmeta.image_url) {
      pendingImageTransfers.push({
        type: "group",
        name: groupName,
        entityId: groupIds[groupName],
        imageUrl: gmeta.image_url,
        destPath:
          gmeta.image_path || deriveDestPath(gmeta.image_url, groupName),
      });
    }
  }

  return {
    sql: statements.join("\n"),
    stats: {
      categories: categories.size,
      groups: groups.size,
      menuItems: items.length,
      printers: items.length,
      modifierTemplates: usedTemplateNames.size,
      rooms: roomCount,
      tables: tableCount,
      pendingImageTransfers: pendingImageTransfers.length,
    },
    groupIds,
    categoryIds: catIds,
    itemIds,
    pendingImageTransfers,
  };
}
