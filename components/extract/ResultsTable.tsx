"use client";

import { Trash2 } from "lucide-react";
import { useStore } from "@/store";
import { EXTRACTABLE_COLS } from "@/lib/types/menu";

const DISPLAY_COLS = EXTRACTABLE_COLS;

export function ResultsTable() {
  const extractedRows = useStore((s) => s.extractedRows);
  const updateRow = useStore((s) => s.updateRow);
  const deleteRow = useStore((s) => s.deleteRow);

  if (extractedRows.length === 0) return null;

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800/30">
      <div className="flex items-center justify-between border-b border-slate-700 px-4 py-2">
        <span className="text-sm font-medium text-slate-300">
          Extracted Items ({extractedRows.length})
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-700 bg-slate-800/50">
              <th className="w-8 px-2 py-2" />
              {DISPLAY_COLS.map((col) => (
                <th
                  key={col}
                  className="whitespace-nowrap px-3 py-2 text-xs font-medium text-slate-400"
                >
                  {col.replace("Menu Item ", "").replace("Price", "$")}
                </th>
              ))}
              <th className="w-8 px-2 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700/50">
            {extractedRows.map((row, idx) => (
              <tr key={idx} className="hover:bg-slate-800/50">
                <td className="px-2 py-1.5 text-xs text-slate-500">
                  {idx + 1}
                </td>
                {DISPLAY_COLS.map((col) => (
                  <td key={col} className="px-1 py-1">
                    <input
                      type="text"
                      value={row[col] ?? ""}
                      onChange={(e) => updateRow(idx, col, e.target.value)}
                      className="h-7 w-full min-w-[60px] rounded border border-transparent bg-transparent px-2 text-sm text-slate-200 hover:border-slate-600 focus:border-blue-500 focus:bg-slate-800 focus:outline-none"
                    />
                  </td>
                ))}
                <td className="px-2 py-1.5">
                  <button
                    onClick={() => deleteRow(idx)}
                    className="rounded p-1 text-slate-500 hover:bg-red-500/10 hover:text-red-400"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
