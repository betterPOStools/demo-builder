"use client";

import {
  File,
  Globe,
  X,
  Loader2,
  Check,
  AlertCircle,
  Play,
  GripVertical,
  FileImage,
  FileText as FileTextIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useStore } from "@/store";
import { useExtraction } from "@/lib/extraction/useExtraction";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const statusConfig = {
  pending: { icon: File, color: "text-slate-400", label: "Pending" },
  processing: {
    icon: Loader2,
    color: "text-blue-400",
    label: "Processing...",
  },
  done: { icon: Check, color: "text-green-400", label: "Done" },
  error: { icon: AlertCircle, color: "text-red-400", label: "Error" },
};

function isImageType(type: string): boolean {
  return (
    type.startsWith("image/") ||
    /\.(png|jpe?g|webp|gif|bmp|tiff)$/i.test(type)
  );
}

function isPdfType(type: string): boolean {
  return type === "application/pdf" || type.endsWith(".pdf") || /\.pdf$/i.test(type);
}

function SortableFileRow({
  fileId,
  index,
}: {
  fileId: string;
  index: number;
}) {
  const file = useStore((s) => s.files.find((f) => f.id === fileId));
  const removeFile = useStore((s) => s.removeFile);

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: fileId });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  if (!file) return null;

  const config = statusConfig[file.status];
  const StatusIcon = config.icon;
  const showImage = isImageType(file.type);
  const showPdf = isPdfType(file.type);

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-2 px-3 py-2"
    >
      {/* Drag handle */}
      <button
        {...attributes}
        {...listeners}
        className="cursor-grab rounded p-0.5 text-slate-700 hover:text-slate-400 active:cursor-grabbing"
      >
        <GripVertical className="h-3.5 w-3.5" />
      </button>

      {/* Order number */}
      <span className="w-5 shrink-0 text-center text-[10px] font-medium text-slate-600">
        {index + 1}
      </span>

      {/* Thumbnail */}
      <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded border border-slate-700 bg-slate-900">
        {file.thumbnailUrl ? (
          <img
            src={file.thumbnailUrl}
            alt=""
            className="h-full w-full object-cover"
          />
        ) : showPdf ? (
          <FileTextIcon className="h-5 w-5 text-red-400" />
        ) : showImage ? (
          <FileImage className="h-5 w-5 text-blue-400" />
        ) : file.type === "url" ? (
          <Globe className="h-5 w-5 text-blue-400" />
        ) : (
          <File className="h-5 w-5 text-slate-500" />
        )}
      </div>

      {/* Status icon */}
      <StatusIcon
        className={cn(
          "h-3.5 w-3.5 shrink-0",
          config.color,
          file.status === "processing" && "animate-spin",
        )}
      />

      {/* File info */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm text-slate-200">{file.name}</p>
          {file.type === "url" && (
            <span className="shrink-0 rounded bg-blue-500/20 px-1.5 py-0.5 text-[10px] font-medium text-blue-400">
              URL
            </span>
          )}
        </div>
        <p className="text-xs text-slate-500">
          {file.type === "url" ? "Web page" : formatSize(file.size)}
          {file.error && (
            <span className="ml-2 text-red-400">{file.error}</span>
          )}
        </p>
      </div>

      {/* Remove button */}
      <button
        onClick={() => removeFile(file.id)}
        className="shrink-0 rounded p-1 text-slate-500 hover:bg-slate-700 hover:text-slate-300"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export function FileQueue() {
  const files = useStore((s) => s.files);
  const reorderFiles = useStore((s) => s.reorderFiles);
  const isProcessing = useStore((s) => s.isProcessing);
  const { processFiles } = useExtraction();

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const pendingCount = files.filter((f) => f.status === "pending").length;

  if (files.length === 0) return null;

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = files.findIndex((f) => f.id === active.id);
    const newIndex = files.findIndex((f) => f.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const newOrder = [...files.map((f) => f.id)];
    newOrder.splice(oldIndex, 1);
    newOrder.splice(newIndex, 0, active.id as string);
    reorderFiles(newOrder);
  }

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800/30">
      <div className="flex items-center justify-between border-b border-slate-700 px-4 py-2">
        <div>
          <span className="text-sm font-medium text-slate-300">
            Files ({files.length})
          </span>
          <span className="ml-2 text-[10px] text-slate-600">
            drag to reorder
          </span>
        </div>
        {isProcessing ? (
          <div className="flex items-center gap-2 text-xs text-blue-400">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Processing...
          </div>
        ) : (
          pendingCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 text-xs"
              onClick={processFiles}
            >
              <Play className="h-3 w-3" />
              Process{" "}
              {pendingCount === files.length
                ? "All"
                : `${pendingCount} Pending`}
            </Button>
          )
        )}
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={handleDragEnd}
      >
        <SortableContext
          items={files.map((f) => f.id)}
          strategy={verticalListSortingStrategy}
        >
          <div className="divide-y divide-slate-700/50">
            {files.map((file, index) => (
              <SortableFileRow
                key={file.id}
                fileId={file.id}
                index={index}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  );
}
