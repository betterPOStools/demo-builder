"use client";

import { useState } from "react";
import { Plus, Trash2, MapPin } from "lucide-react";
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
import { Separator } from "@/components/ui/separator";
import { useStore } from "@/store";
import { isLightColor } from "@/lib/utils";
import { LAYOUT_PRESETS } from "@/lib/sql/layout";
import type { RoomNode } from "@/lib/types";

const PRESET_LIST = Object.entries(LAYOUT_PRESETS).map(([key, p]) => ({
  key,
  name: p.name,
  description: p.description,
}));

function TableGrid({ room }: { room: RoomNode }) {
  if (room.tables.length === 0) return null;

  const fg = isLightColor(room.color) ? "#1e293b" : "#ffffff";
  // Determine grid cols: sqrt-based, max 6
  const cols = Math.min(6, Math.ceil(Math.sqrt(room.tables.length)));

  return (
    <div className="mt-2 rounded-lg border border-slate-700/50 bg-slate-900/50 p-2">
      <div className="mb-1.5 text-[10px] font-medium text-slate-500">
        Floor Plan
      </div>
      <div
        className="grid gap-1"
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
      >
        {room.tables.map((t) => (
          <div
            key={t.id}
            className="flex flex-col items-center justify-center rounded px-1 py-1.5"
            style={{ backgroundColor: room.color, color: fg }}
          >
            <span className="text-[9px] font-bold leading-tight">
              {t.name}
            </span>
            <span className="text-[8px] opacity-70">
              {t.seats} {t.isBarStool ? "stools" : "seats"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function LayoutEditor() {
  const rooms = useStore((s) => s.rooms);
  const loadRoomsFromPreset = useStore((s) => s.loadRoomsFromPreset);
  const addRoom = useStore((s) => s.addRoom);
  const updateRoom = useStore((s) => s.updateRoom);
  const deleteRoom = useStore((s) => s.deleteRoom);
  const addTable = useStore((s) => s.addTable);
  const updateTable = useStore((s) => s.updateTable);
  const deleteTable = useStore((s) => s.deleteTable);

  const [newRoomName, setNewRoomName] = useState("");
  const [newTableInputs, setNewTableInputs] = useState<
    Record<string, { name: string; seats: string }>
  >({});

  function handlePresetChange(presetKey: string) {
    loadRoomsFromPreset(presetKey);
  }

  function handleAddRoom() {
    if (!newRoomName.trim()) return;
    addRoom(newRoomName.trim(), "#fffdcc");
    setNewRoomName("");
  }

  function handleAddTable(roomId: string) {
    const input = newTableInputs[roomId];
    if (!input?.name.trim()) return;
    addTable(roomId, input.name.trim(), parseInt(input.seats) || 4);
    setNewTableInputs((prev) => ({
      ...prev,
      [roomId]: { name: "", seats: "4" },
    }));
  }

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

      {/* Rooms */}
      {rooms.map((room) => (
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
          <CardContent className="space-y-2">
            {room.tables.length > 0 && (
              <div className="space-y-1">
                {room.tables.map((table) => (
                  <div
                    key={table.id}
                    className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-slate-800/50"
                  >
                    <Input
                      value={table.name}
                      onChange={(e) =>
                        updateTable(room.id, table.id, {
                          name: e.target.value,
                        })
                      }
                      className="h-7 w-20 text-xs"
                    />
                    <Input
                      type="number"
                      value={table.seats}
                      onChange={(e) =>
                        updateTable(room.id, table.id, {
                          seats: parseInt(e.target.value) || 1,
                        })
                      }
                      className="h-7 w-16 text-xs"
                      min={1}
                    />
                    <span className="text-xs text-slate-500">seats</span>
                    <div className="flex items-center gap-1">
                      <Checkbox
                        id={`bar-${table.id}`}
                        checked={table.isBarStool}
                        onCheckedChange={(v) =>
                          updateTable(room.id, table.id, {
                            isBarStool: !!v,
                          })
                        }
                      />
                      <Label
                        htmlFor={`bar-${table.id}`}
                        className="text-xs text-slate-500"
                      >
                        Bar stool
                      </Label>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="ml-auto h-6 w-6 text-slate-600 hover:text-red-400"
                      onClick={() => deleteTable(room.id, table.id)}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                ))}
              </div>
            )}

            <Separator />

            <div className="flex items-center gap-2">
              <Input
                placeholder="Table name"
                value={newTableInputs[room.id]?.name ?? ""}
                onChange={(e) =>
                  setNewTableInputs((prev) => ({
                    ...prev,
                    [room.id]: {
                      ...prev[room.id],
                      name: e.target.value,
                      seats: prev[room.id]?.seats ?? "4",
                    },
                  }))
                }
                className="h-7 w-24 text-xs"
                onKeyDown={(e) =>
                  e.key === "Enter" && handleAddTable(room.id)
                }
              />
              <Input
                type="number"
                placeholder="Seats"
                value={newTableInputs[room.id]?.seats ?? "4"}
                onChange={(e) =>
                  setNewTableInputs((prev) => ({
                    ...prev,
                    [room.id]: {
                      ...prev[room.id],
                      name: prev[room.id]?.name ?? "",
                      seats: e.target.value,
                    },
                  }))
                }
                className="h-7 w-16 text-xs"
                min={1}
              />
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={() => handleAddTable(room.id)}
              >
                <Plus className="mr-1 h-3 w-3" /> Add Table
              </Button>
            </div>

            <TableGrid room={room} />
          </CardContent>
        </Card>
      ))}

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
