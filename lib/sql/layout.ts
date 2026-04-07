// Ported from pos-scaffold/app/core/layout.py
// Room & table layout SQL generation for POS dining layout.

import { newUuid, nowStr, esc } from "./generator";

export interface RoomDef {
  name: string;
  color?: string;
  grid_size?: number;
  image_path?: string | null;
  tables: TableDef[];
}

export interface TableDef {
  name: string;
  room_name?: string;
  room_id?: string;
  capacity?: number;
  is_bar_stool?: boolean;
  row_index?: number;
  column_index?: number;
  picture_path?: string | null;
}

export function generateRoomSql(
  rooms: RoomDef[],
): { sql: string; roomIds: Record<string, string> } {
  const ts = nowStr();
  const statements: string[] = [];
  statements.push("-- =============================================");
  statements.push("-- ROOMS");
  statements.push("-- =============================================");

  const roomIds: Record<string, string> = {};

  for (let i = 0; i < rooms.length; i++) {
    const room = rooms[i];
    const rid = newUuid();
    roomIds[room.name] = rid;
    const color = room.color ?? "#fffdcc";
    const gridSize = room.grid_size ?? 1;
    const picSql = room.image_path ? `'${esc(room.image_path)}'` : "NULL";

    statements.push(
      `REPLACE INTO \`rooms\` ` +
        `(\`Id\`, \`Name\`, \`Color\`, \`GridSize\`, \`RowIndex\`, \`ColumnIndex\`, ` +
        `\`IsHidden\`, \`ShowPictureOnlyInOrderEntry\`, \`PicturePath\`, ` +
        `\`CreatedOn\`, \`ModifiedOn\`, \`IsDeleted\`) VALUES (\n` +
        `  '${rid}', '${esc(room.name)}', '${esc(color)}', ${gridSize}, ` +
        `${i}, 0, 0, 0, ${picSql}, '${ts}', '${ts}', 0);`,
    );
  }

  return { sql: statements.join("\n"), roomIds };
}

export function generateTableSql(
  tables: TableDef[],
  roomIds?: Record<string, string>,
): string {
  const ts = nowStr();
  const statements: string[] = [];
  statements.push("-- =============================================");
  statements.push("-- TABLES");
  statements.push("-- =============================================");

  for (const t of tables) {
    const tid = newUuid();
    let roomId = t.room_id;
    if (!roomId && roomIds && t.room_name) {
      roomId = roomIds[t.room_name];
    }

    const roomSql = roomId ? `'${roomId}'` : "NULL";
    const capacity = t.capacity != null ? t.capacity : "NULL";
    const isBar = t.is_bar_stool ? 1 : 0;
    const rowIdx = t.row_index ?? 0;
    const colIdx = t.column_index ?? 0;
    const picSql = t.picture_path ? `'${esc(t.picture_path)}'` : "NULL";

    statements.push(
      `REPLACE INTO \`tables\` ` +
        `(\`Id\`, \`Name\`, \`RoomId\`, \`Capacity\`, \`PicturePath\`, \`IsBarStool\`, ` +
        `\`IsHidden\`, \`RowIndex\`, \`ColumnIndex\`, \`IsTemporary\`, ` +
        `\`CreatedOn\`, \`ModifiedOn\`, \`IsDeleted\`) VALUES (\n` +
        `  '${tid}', '${esc(t.name)}', ${roomSql}, ${capacity}, ${picSql}, ` +
        `${isBar}, 0, ${rowIdx}, ${colIdx}, 0, '${ts}', '${ts}', 0);`,
    );
  }

  return statements.join("\n");
}

// Premade room/table layouts
export const LAYOUT_PRESETS: Record<string, { name: string; description: string; rooms: RoomDef[] }> = {
  small_restaurant: {
    name: "Small Restaurant",
    description: "12 tables: dining room (8 tables) + bar area (4 stools)",
    rooms: [
      {
        name: "Dining Room", color: "#fffdcc", tables: [
          { name: "T1", capacity: 2, row_index: 0, column_index: 0 },
          { name: "T2", capacity: 2, row_index: 0, column_index: 1 },
          { name: "T3", capacity: 4, row_index: 0, column_index: 2 },
          { name: "T4", capacity: 4, row_index: 1, column_index: 0 },
          { name: "T5", capacity: 4, row_index: 1, column_index: 1 },
          { name: "T6", capacity: 6, row_index: 1, column_index: 2 },
          { name: "B1", capacity: 4, row_index: 2, column_index: 0 },
          { name: "B2", capacity: 4, row_index: 2, column_index: 1 },
        ],
      },
      {
        name: "Bar Area", color: "#ffd4cc", tables: [
          { name: "S1", capacity: 1, is_bar_stool: true, row_index: 0, column_index: 0 },
          { name: "S2", capacity: 1, is_bar_stool: true, row_index: 0, column_index: 1 },
          { name: "S3", capacity: 1, is_bar_stool: true, row_index: 0, column_index: 2 },
          { name: "S4", capacity: 1, is_bar_stool: true, row_index: 0, column_index: 3 },
        ],
      },
    ],
  },
  medium_restaurant: {
    name: "Medium Restaurant",
    description: "28 tables: dining (14) + bar (8) + patio (6)",
    rooms: [
      {
        name: "Dining Room", color: "#fffdcc", tables: [
          { name: "A1", capacity: 2, row_index: 0, column_index: 0 },
          { name: "A2", capacity: 2, row_index: 0, column_index: 1 },
          { name: "A3", capacity: 4, row_index: 0, column_index: 2 },
          { name: "A4", capacity: 4, row_index: 0, column_index: 3 },
          { name: "B1", capacity: 4, row_index: 1, column_index: 0 },
          { name: "B2", capacity: 4, row_index: 1, column_index: 1 },
          { name: "B3", capacity: 6, row_index: 1, column_index: 2 },
          { name: "B4", capacity: 6, row_index: 1, column_index: 3 },
          { name: "C1", capacity: 4, row_index: 2, column_index: 0 },
          { name: "C2", capacity: 4, row_index: 2, column_index: 1 },
          { name: "C3", capacity: 2, row_index: 2, column_index: 2 },
          { name: "C4", capacity: 2, row_index: 2, column_index: 3 },
          { name: "BOOTH1", capacity: 4, row_index: 3, column_index: 0 },
          { name: "BOOTH2", capacity: 6, row_index: 3, column_index: 1 },
        ],
      },
      {
        name: "Bar Area", color: "#ffd4cc", tables: [
          { name: "HT1", capacity: 4, row_index: 0, column_index: 0 },
          { name: "HT2", capacity: 4, row_index: 0, column_index: 1 },
          { name: "S1", capacity: 1, is_bar_stool: true, row_index: 1, column_index: 0 },
          { name: "S2", capacity: 1, is_bar_stool: true, row_index: 1, column_index: 1 },
          { name: "S3", capacity: 1, is_bar_stool: true, row_index: 1, column_index: 2 },
          { name: "S4", capacity: 1, is_bar_stool: true, row_index: 1, column_index: 3 },
          { name: "S5", capacity: 1, is_bar_stool: true, row_index: 1, column_index: 4 },
          { name: "S6", capacity: 1, is_bar_stool: true, row_index: 1, column_index: 5 },
        ],
      },
      {
        name: "Patio", color: "#d4ffcc", tables: [
          { name: "P1", capacity: 4, row_index: 0, column_index: 0 },
          { name: "P2", capacity: 4, row_index: 0, column_index: 1 },
          { name: "P3", capacity: 4, row_index: 0, column_index: 2 },
          { name: "P4", capacity: 2, row_index: 1, column_index: 0 },
          { name: "P5", capacity: 2, row_index: 1, column_index: 1 },
          { name: "P6", capacity: 6, row_index: 1, column_index: 2 },
        ],
      },
    ],
  },
  bar_focused: {
    name: "Bar & Lounge",
    description: "20 seats: bar counter (10 stools) + high tops (6) + booths (4)",
    rooms: [
      {
        name: "Bar", color: "#ffd4cc", tables: [
          { name: "S1", capacity: 1, is_bar_stool: true, row_index: 0, column_index: 0 },
          { name: "S2", capacity: 1, is_bar_stool: true, row_index: 0, column_index: 1 },
          { name: "S3", capacity: 1, is_bar_stool: true, row_index: 0, column_index: 2 },
          { name: "S4", capacity: 1, is_bar_stool: true, row_index: 0, column_index: 3 },
          { name: "S5", capacity: 1, is_bar_stool: true, row_index: 0, column_index: 4 },
          { name: "S6", capacity: 1, is_bar_stool: true, row_index: 1, column_index: 0 },
          { name: "S7", capacity: 1, is_bar_stool: true, row_index: 1, column_index: 1 },
          { name: "S8", capacity: 1, is_bar_stool: true, row_index: 1, column_index: 2 },
          { name: "S9", capacity: 1, is_bar_stool: true, row_index: 1, column_index: 3 },
          { name: "S10", capacity: 1, is_bar_stool: true, row_index: 1, column_index: 4 },
        ],
      },
      {
        name: "Lounge", color: "#cce0ff", tables: [
          { name: "HT1", capacity: 4, row_index: 0, column_index: 0 },
          { name: "HT2", capacity: 4, row_index: 0, column_index: 1 },
          { name: "HT3", capacity: 4, row_index: 0, column_index: 2 },
          { name: "HT4", capacity: 2, row_index: 1, column_index: 0 },
          { name: "HT5", capacity: 2, row_index: 1, column_index: 1 },
          { name: "HT6", capacity: 2, row_index: 1, column_index: 2 },
          { name: "BOOTH1", capacity: 4, row_index: 2, column_index: 0 },
          { name: "BOOTH2", capacity: 4, row_index: 2, column_index: 1 },
          { name: "BOOTH3", capacity: 6, row_index: 2, column_index: 2 },
          { name: "BOOTH4", capacity: 6, row_index: 2, column_index: 3 },
        ],
      },
    ],
  },
  fine_dining: {
    name: "Fine Dining",
    description: "15 tables: main dining (10) + private room (5)",
    rooms: [
      {
        name: "Main Dining", color: "#e8d5b7", tables: [
          { name: "1", capacity: 2, row_index: 0, column_index: 0 },
          { name: "2", capacity: 2, row_index: 0, column_index: 1 },
          { name: "3", capacity: 2, row_index: 0, column_index: 2 },
          { name: "4", capacity: 4, row_index: 1, column_index: 0 },
          { name: "5", capacity: 4, row_index: 1, column_index: 1 },
          { name: "6", capacity: 4, row_index: 1, column_index: 2 },
          { name: "7", capacity: 4, row_index: 2, column_index: 0 },
          { name: "8", capacity: 6, row_index: 2, column_index: 1 },
          { name: "9", capacity: 6, row_index: 2, column_index: 2 },
          { name: "10", capacity: 8, row_index: 3, column_index: 0 },
        ],
      },
      {
        name: "Private Room", color: "#d5c4a1", tables: [
          { name: "PR1", capacity: 6, row_index: 0, column_index: 0 },
          { name: "PR2", capacity: 6, row_index: 0, column_index: 1 },
          { name: "PR3", capacity: 8, row_index: 1, column_index: 0 },
          { name: "PR4", capacity: 8, row_index: 1, column_index: 1 },
          { name: "PR5", capacity: 10, row_index: 2, column_index: 0 },
        ],
      },
    ],
  },
  fast_casual: {
    name: "Fast Casual",
    description: "8 tables: counter (2 high tops) + dining (6)",
    rooms: [
      {
        name: "Counter Area", color: "#ffd4cc", tables: [
          { name: "HT1", capacity: 2, row_index: 0, column_index: 0 },
          { name: "HT2", capacity: 2, row_index: 0, column_index: 1 },
        ],
      },
      {
        name: "Dining", color: "#fffdcc", tables: [
          { name: "T1", capacity: 2, row_index: 0, column_index: 0 },
          { name: "T2", capacity: 2, row_index: 0, column_index: 1 },
          { name: "T3", capacity: 4, row_index: 0, column_index: 2 },
          { name: "T4", capacity: 4, row_index: 1, column_index: 0 },
          { name: "T5", capacity: 4, row_index: 1, column_index: 1 },
          { name: "T6", capacity: 6, row_index: 1, column_index: 2 },
        ],
      },
    ],
  },
  food_truck: {
    name: "Food Truck / Takeout Only",
    description: "No tables — counter/takeout only",
    rooms: [
      {
        name: "Counter", color: "#ffd4cc", tables: [
          { name: "PICKUP1", capacity: 1, row_index: 0, column_index: 0 },
          { name: "PICKUP2", capacity: 1, row_index: 0, column_index: 1 },
        ],
      },
    ],
  },
};
