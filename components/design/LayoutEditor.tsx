"use client";

import { useState, useCallback } from "react";
import { Plus, Trash2, MapPin, Armchair, Beer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useStore } from "@/store";
import { isLightColor } from "@/lib/utils";
import { LAYOUT_PRESETS } from "@/lib/sql/layout";
import type { RoomNode, TableNode } from "@/lib/types";

const GRID_SIZE = 8;

const PRESET_LIST = Object.entries(LAYOUT_PRESETS).map(([key, p]) => ({
  key,
  name: p.name,
  description: p.description,
}));

// ---------- Table Grid (8x8 interactive grid) ----------

function TableGridEditor({
  room,
  onPlaceTable,
  onSelectTable,
  onMoveTable,
  selectedTableId,
}: {
  room: RoomNode;
  onPlaceTable: (row: number, col: number) => void;
  onSelectTable: (tableId: string | null) => void;
  onMoveTable: (tableId: string, row: number, col: number) => void;
  selectedTableId: string | null;
}) {
  const [dragTableId, setDragTableId] = useState<string | null>(null);

  const fg = isLightColor(room.color) ? "#1e293b" : "#ffffff";

  // Build lookup: "row,col" → table
  const cellMap = new Map<string, TableNode>();
  for (const t of room.tables) {
    cellMap.set(`${t.rowIndex},${t.columnIndex}`, t);
  }

  function handleCellClick(row: number, col: number) {
    const key = `${row},${col}`;
    const existing = cellMap.get(key);
    if (existing) {
      onSelectTable(
        selectedTableId === existing.id ? null : existing.id,
      );
    } else {
      onPlaceTable(row, col);
    }
  }

  function handleDragStart(e: React.DragEvent, tableId: string) {
    setDragTableId(tableId);
    e.dataTransfer.effectAllowed = "move";
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }

  function handleDrop(e: React.DragEvent, row: number, col: number) {
    e.preventDefault();
    if (!dragTableId) return;

    const key = `${row},${col}`;
    const existing = cellMap.get(key);
    // Only drop on empty cells or same cell
    if (!existing || existing.id === dragTableId) {
      onMoveTable(dragTableId, row, col);
    }
    setDragTableId(null);
  }

  return (
    <div className="rounded-lg border border-slate-700/50 bg-slate-900/60 p-2">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[10px] font-medium text-slate-500">
          Floor Plan — click empty cell to place, drag to move
        </span>
        <span className="text-[10px] text-slate-600">
          {room.tables.length} tables
        </span>
      </div>
      <div
        className="grid gap-px"
        style={{ gridTemplateColumns: `repeat(${GRID_SIZE}, 1fr)` }}
      >
        {Array.from({ length: GRID_SIZE * GRID_SIZE }, (_, i) => {
          const row = Math.floor(i / GRID_SIZE);
          const col = i % GRID_SIZE;
          const key = `${row},${col}`;
          const table = cellMap.get(key);
          const isSelected = table?.id === selectedTableId;

          if (table) {
            return (
              <div
                key={key}
                draggable
                onDragStart={(e) => handleDragStart(e, table.id)}
                onDragOver={handleDragOver}
                onDrop={(e) => handleDrop(e, row, col)}
                onClick={() => handleCellClick(row, col)}
                className="flex h-10 cursor-grab flex-col items-center justify-center rounded transition-all active:cursor-grabbing"
                style={{
                  backgroundColor: room.color,
                  color: fg,
                  outline: isSelected
                    ? "2px solid #3b82f6"
                    : "1px solid rgba(255,255,255,0.1)",
                  outlineOffset: isSelected ? "-1px" : "0",
                }}
              >
                {table.isBarStool ? (
                  <Beer
                    className="h-3 w-3"
                    style={{ color: fg }}
                  />
                ) : (
                  <Armchair
                    className="h-3 w-3"
                    style={{ color: fg }}
                  />
                )}
                <span className="text-[8px] font-bold leading-none">
                  {table.name}
                </span>
                <span className="text-[7px] opacity-60">
                  {table.seats}
                </span>
              </div>
            );
          }

          return (
            <div
              key={key}
              onClick={() => handleCellClick(row, col)}
              onDragOver={handleDragOver}
              onDrop={(e) => handleDrop(e, row, col)}
              className="flex h-10 cursor-pointer items-center justify-center rounded border border-dashed border-slate-700/30 transition-colors hover:border-slate-600 hover:bg-slate-800/50"
            >
              <span className="text-[8px] text-slate-700">
                {row},{col}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------- Table Detail Panel ----------

function TableDetail({
  table,
  roomId,
}: {
  table: TableNode;
  roomId: string;
}) {
  const updateTable = useStore((s) => s.updateTable);
  const deleteTable = useStore((s) => s.deleteTable);

  return (
    <div className="flex items-center gap-2 rounded-md border border-blue-500/30 bg-slate-800/60 px-3 py-2">
      <Input
        value={table.name}
        onChange={(e) =>
          updateTable(roomId, table.id, { name: e.target.value })
        }
        className="h-7 w-20 text-xs"
      />
      <Input
        type="number"
        value={table.seats}
        onChange={(e) =>
          updateTable(roomId, table.id, {
            seats: parseInt(e.target.value) || 1,
          })
        }
        className="h-7 w-14 text-xs"
        min={1}
      />
      <span className="text-[10px] text-slate-500">seats</span>
      <div className="flex items-center gap-1">
        <Checkbox
          id={`bar-${table.id}`}
          checked={table.isBarStool}
          onCheckedChange={(v) =>
            updateTable(roomId, table.id, { isBarStool: !!v })
          }
        />
        <Label htmlFor={`bar-${table.id}`} className="text-[10px] text-slate-500">
          Bar stool
        </Label>
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="ml-auto h-6 w-6 text-slate-500 hover:text-red-400"
        onClick={() => deleteTable(roomId, table.id)}
      >
        <Trash2 className="h-3 w-3" />
      </Button>
    </div>
  );
}

// ---------- Main LayoutEditor ----------

export function LayoutEditor() {
  const rooms = useStore((s) => s.rooms);
  const loadRoomsFromPreset = useStore((s) => s.loadRoomsFromPreset);
  const addRoom = useStore((s) => s.addRoom);
  const updateRoom = useStore((s) => s.updateRoom);
  const deleteRoom = useStore((s) => s.deleteRoom);
  const addTable = useStore((s) => s.addTable);
  const updateTable = useStore((s) => s.updateTable);

  const [newRoomName, setNewRoomName] = useState("");
  const [selectedTables, setSelectedTables] = useState<
    Record<string, string | null>
  >({});
  const [nextTableNum, setNextTableNum] = useState<Record<string, number>>({});

  function handlePresetChange(presetKey: string) {
    loadRoomsFromPreset(presetKey);
    setSelectedTables({});
  }

  function handleAddRoom() {
    if (!newRoomName.trim()) return;
    addRoom(newRoomName.trim(), "#fffdcc");
    setNewRoomName("");
  }

  const handlePlaceTable = useCallback(
    (roomId: string, row: number, col: number) => {
      const num = (nextTableNum[roomId] ?? rooms.find(r => r.id === roomId)?.tables.length ?? 0) + 1;
      const name = `T${num}`;
      addTable(roomId, name, 4);

      // Update the newly added table's position
      // addTable creates with rowIndex=0, columnIndex=0, so we need to update
      setTimeout(() => {
        const room = useStore.getState().rooms.find((r) => r.id === roomId);
        if (!room) return;
        const lastTable = room.tables[room.tables.length - 1];
        if (lastTable) {
          updateTable(roomId, lastTable.id, {
            rowIndex: row,
            columnIndex: col,
          });
        }
      }, 0);

      setNextTableNum((prev) => ({ ...prev, [roomId]: num }));
    },
    [addTable, updateTable, nextTableNum, rooms],
  );

  const handleMoveTable = useCallback(
    (roomId: string, tableId: string, row: number, col: number) => {
      updateTable(roomId, tableId, { rowIndex: row, columnIndex: col });
    },
    [updateTable],
  );

  const totalTables = rooms.reduce((sum, r) => sum + r.tables.length, 0);

  return (
    <div className="space-y-4">
      {/* Preset Selector */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <MapPin className="h-4 w-4 text-emerald-400" />
            Room & Table Layout
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <Label>Load from preset</Label>
            <Select onValueChange={handlePresetChange}>
              <SelectTrigger className="w-64">
                <SelectValue placeholder="Choose a preset layout..." />
              </SelectTrigger>
              <SelectContent>
                {PRESET_LIST.map((p) => (
                  <SelectItem key={p.key} value={p.key}>
                    {p.name} — {p.description}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {rooms.length > 0 && (
            <div className="text-xs text-slate-500">
              {rooms.length} rooms, {totalTables} tables
            </div>
          )}
        </CardContent>
      </Card>

      {/* Rooms with Grid Editors */}
      {rooms.map((room) => {
        const selectedTableId = selectedTables[room.id] ?? null;
        const selectedTable = selectedTableId
          ? room.tables.find((t) => t.id === selectedTableId) ?? null
          : null;

        return (
          <Card key={room.id}>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <input
                    type="color"
                    value={room.color}
                    onChange={(e) =>
                      updateRoom(room.id, { color: e.target.value })
                    }
                    className="h-6 w-6 cursor-pointer rounded border-0"
                  />
                  <Input
                    value={room.name}
                    onChange={(e) =>
                      updateRoom(room.id, { name: e.target.value })
                    }
                    className="h-8 w-48 text-sm font-medium"
                  />
                  <span className="text-xs text-slate-500">
                    {room.tables.length} tables
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-slate-500 hover:text-red-400"
                  onClick={() => deleteRoom(room.id)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <TableGridEditor
                room={room}
                selectedTableId={selectedTableId}
                onPlaceTable={(row, col) =>
                  handlePlaceTable(room.id, row, col)
                }
                onSelectTable={(id) =>
                  setSelectedTables((prev) => ({
                    ...prev,
                    [room.id]: id,
                  }))
                }
                onMoveTable={(tableId, row, col) =>
                  handleMoveTable(room.id, tableId, row, col)
                }
              />

              {/* Selected table detail editor */}
              {selectedTable && (
                <TableDetail table={selectedTable} roomId={room.id} />
              )}
            </CardContent>
          </Card>
        );
      })}

      {/* Add Room */}
      <div className="flex items-center gap-2">
        <Input
          placeholder="New room name"
          value={newRoomName}
          onChange={(e) => setNewRoomName(e.target.value)}
          className="h-8 w-48 text-sm"
          onKeyDown={(e) => e.key === "Enter" && handleAddRoom()}
        />
        <Button
          variant="outline"
          size="sm"
          onClick={handleAddRoom}
          disabled={!newRoomName.trim()}
        >
          <Plus className="mr-1 h-3 w-3" /> Add Room
        </Button>
      </div>
    </div>
  );
}
