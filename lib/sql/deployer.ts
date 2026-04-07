// Ported from pos-scaffold/app/core/deployer.py
// Full menu deployment SQL generator.

import { newUuid, nowStr, esc, price, generateTemplateSql } from "./generator";
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
  type: "item" | "group";
  name: string;
  entityId: string | undefined;
  imageUrl: string;
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
  const templateIds: Record<string, string> = {};

  // ---------------------------------------------------------------
  // 0. Modifier Templates (must exist before items reference them)
  // ---------------------------------------------------------------
  if (modifierTemplates.length > 0) {
    statements.push("-- =============================================");
    statements.push("-- MODIFIER TEMPLATES");
    statements.push("-- =============================================");

    for (const tmpl of modifierTemplates) {
      const result = generateTemplateSql(tmpl.name, tmpl.sections);
      templateIds[tmpl.name] = result.templateId;
      statements.push(result.sql);
    }
  }

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
  // 3. Menu Items + Printer Assignments
  // ---------------------------------------------------------------
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

    // Modifier template
    let modTemplateId = "NULL";
    const assignedTemplate =
      templateAssignments[item.name] ?? templateAssignments[item.group];
    if (assignedTemplate && templateIds[assignedTemplate]) {
      modTemplateId = `'${templateIds[assignedTemplate]}'`;
    }

    const cidSql = cid ? `'${cid}'` : "NULL";
    const barcodeSql = item.barcode ? `'${esc(item.barcode)}'` : "NULL";
    const itemPicSql = item.image_path
      ? `'${esc(item.image_path)}'`
      : item.image_url
        ? `'${esc(deriveDestPath(item.image_url, item.name))}'`
        : "NULL";
    const itemColorSql = item.color ? `'${esc(item.color)}'` : "NULL";

    statements.push(
      `REPLACE INTO \`menuitems\` ` +
        `(\`Id\`, \`Name\`, \`RowIndex\`, \`ColumnIndex\`, \`Index\`, ` +
        `\`MenuGroupId\`, \`MenuCategoryId\`, \`IsHidden\`, \`IsEnabled\`, ` +
        `\`DefaultPrice\`, \`DineInPrice\`, \`BarPrice\`, ` +
        `\`PickUpPrice\`, \`TakeOutPrice\`, \`DeliveryPrice\`, ` +
        `\`IsOpenPriceItem\`, \`ApplyTax1\`, \`ApplyTax2\`, \`ApplyTax3\`, ` +
        `\`IsBarItem\`, \`IsWeightedItem\`, \`Tare\`, \`Barcode\`, ` +
        `\`IsDiscountable\`, \`DefaulModifierType\`, ` +
        `\`MenuModifierTemplateId\`, \`PicturePath\`, \`Color\`, ` +
        `\`CreatedOn\`, \`ModifiedOn\`, \`IsDeleted\`) VALUES (\n` +
        `  '${iid}', '${esc(item.name)}', ${rowIdx}, ${colIdx}, ${itemIndex}, ` +
        `'${gid}', ${cidSql}, 0, 1, ` +
        `${price(item.default_price)}, ${price(item.dine_in_price)}, ${price(item.bar_price)}, ` +
        `${price(item.pick_up_price)}, ${price(item.take_out_price)}, ${price(item.delivery_price)}, ` +
        `${item.is_open_price}, ${item.tax1}, ${item.tax2}, ${item.tax3}, ` +
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
    .filter(
      (item) =>
        templateAssignments[item.name] || templateAssignments[item.group],
    )
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
    const btnBg = branding.buttons_background_color as string | null;
    const btnFg = branding.buttons_font_color as string | null;
    const sidebar = branding.sidebar_picture as string | null;

    const storeRows: [string, string][] = [];
    if (bg && !bg.startsWith("data:")) storeRows.push(["Background", bg]);
    if (btnBg && !btnBg.startsWith("data:"))
      storeRows.push(["ButtonsBackgroundColor", btnBg]);
    if (btnFg && !btnFg.startsWith("data:"))
      storeRows.push(["ButtonsFontColor", btnFg]);

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

    if (sidebar && !sidebar.startsWith("data:")) {
      brandingParts.push("\n-- =============================================");
      brandingParts.push("-- STATION SIDEBAR PICTURE");
      brandingParts.push("-- =============================================");
      brandingParts.push(
        `UPDATE \`stationsettingsvalues\` ssv ` +
          `JOIN \`stationsettingsnames\` ssn ON ssv.NameId = ssn.Id ` +
          `SET ssv.\`Value\` = '${esc(sidebar)}', ssv.\`ModifiedOn\` = '${ts}' ` +
          `WHERE ssn.\`Key\` = 'SidebarPicture' AND ssv.\`IsDeleted\` = 0;`,
      );
    }

    if (brandingParts.length > 0) {
      statements.push("\n" + brandingParts.join("\n"));
    }
  }

  // ---------------------------------------------------------------
  // Collect pending image transfers
  // ---------------------------------------------------------------
  const pendingImageTransfers: PendingImageTransfer[] = [];

  for (const item of items) {
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
      modifierTemplates: modifierTemplates.length,
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
