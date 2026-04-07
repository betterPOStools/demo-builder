"use client";

import { useState } from "react";
import { Copy, Check, ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

export function SqlPreview({ sql }: { sql: string }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const lineCount = sql.split("\n").length;
  const previewLines = 30;
  const displaySql = isExpanded
    ? sql
    : sql.split("\n").slice(0, previewLines).join("\n") +
      (lineCount > previewLines ? "\n..." : "");

  async function handleCopy() {
    await navigator.clipboard.writeText(sql);
    setCopied(true);
    toast.success("SQL copied to clipboard");
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/50">
      <div className="flex items-center justify-between border-b border-slate-700/50 px-4 py-2">
        <span className="text-sm font-medium text-slate-300">
          Generated SQL ({lineCount} lines)
        </span>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 text-xs"
            onClick={handleCopy}
          >
            {copied ? (
              <Check className="h-3.5 w-3.5 text-green-400" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
            {copied ? "Copied" : "Copy"}
          </Button>
          {lineCount > previewLines && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 text-xs"
              onClick={() => setIsExpanded(!isExpanded)}
            >
              {isExpanded ? (
                <>
                  <ChevronUp className="h-3.5 w-3.5" /> Collapse
                </>
              ) : (
                <>
                  <ChevronDown className="h-3.5 w-3.5" /> Expand
                </>
              )}
            </Button>
          )}
        </div>
      </div>
      <div className="max-h-[500px] overflow-auto p-4">
        <pre className="whitespace-pre text-xs leading-relaxed text-slate-400">
          <code>{displaySql}</code>
        </pre>
      </div>
    </div>
  );
}
