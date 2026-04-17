"use client";

import { useEffect, useRef, useState } from "react";

const TARGET_W = 360;
const TARGET_H = 696;
const ASPECT = TARGET_W / TARGET_H;

interface Props {
  src: string;
  onCrop: (dataUri: string) => void;
  onCancel: () => void;
}

type Rect = { x: number; y: number; w: number; h: number };

type DragState = {
  mode: "pan" | "resize";
  anchorX: number;
  anchorY: number;
  startRect: Rect;
};

export function SidebarCropTool({ src, onCrop, onCancel }: Props) {
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  const VIEW_MAX_W = 560;
  const VIEW_MAX_H = 640;
  const viewScale = imgSize
    ? Math.min(VIEW_MAX_W / imgSize.w, VIEW_MAX_H / imgSize.h, 1)
    : 1;
  const viewW = imgSize ? imgSize.w * viewScale : 0;
  const viewH = imgSize ? imgSize.h * viewScale : 0;

  useEffect(() => {
    if (!imgSize) return;
    const { w, h } = imgSize;
    let rw: number;
    let rh: number;
    if (w / h > ASPECT) {
      rh = h;
      rw = h * ASPECT;
    } else {
      rw = w;
      rh = w / ASPECT;
    }
    setRect({ x: (w - rw) / 2, y: (h - rh) / 2, w: rw, h: rh });
  }, [imgSize]);

  function beginDrag(mode: "pan" | "resize", e: React.PointerEvent) {
    if (!rect) return;
    e.preventDefault();
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    setDrag({
      mode,
      anchorX: e.clientX,
      anchorY: e.clientY,
      startRect: { ...rect },
    });
  }

  useEffect(() => {
    if (!drag || !imgSize) return;
    const { startRect, anchorX, anchorY, mode } = drag;
    function onMove(e: PointerEvent) {
      const dx = (e.clientX - anchorX) / viewScale;
      const dy = (e.clientY - anchorY) / viewScale;
      if (mode === "pan") {
        const nx = clamp(startRect.x + dx, 0, imgSize!.w - startRect.w);
        const ny = clamp(startRect.y + dy, 0, imgSize!.h - startRect.h);
        setRect({ ...startRect, x: nx, y: ny });
      } else {
        // Resize from bottom-right corner, anchored at top-left, aspect locked.
        // Use max of dx and dy*ASPECT so diagonal drags feel natural.
        const drive = Math.max(dx, dy * ASPECT);
        let nw = Math.max(40, startRect.w + drive);
        let nh = nw / ASPECT;
        if (startRect.x + nw > imgSize!.w) {
          nw = imgSize!.w - startRect.x;
          nh = nw / ASPECT;
        }
        if (startRect.y + nh > imgSize!.h) {
          nh = imgSize!.h - startRect.y;
          nw = nh * ASPECT;
        }
        setRect({ ...startRect, w: nw, h: nh });
      }
    }
    function onUp() {
      setDrag(null);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [drag, viewScale, imgSize]);

  function apply() {
    if (!imgRef.current || !rect) return;
    const canvas = document.createElement("canvas");
    canvas.width = TARGET_W;
    canvas.height = TARGET_H;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(
      imgRef.current,
      rect.x,
      rect.y,
      rect.w,
      rect.h,
      0,
      0,
      TARGET_W,
      TARGET_H,
    );
    onCrop(canvas.toDataURL("image/png"));
  }

  const r = rect && imgSize
    ? {
        x: rect.x * viewScale,
        y: rect.y * viewScale,
        w: rect.w * viewScale,
        h: rect.h * viewScale,
      }
    : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
      onClick={onCancel}
    >
      <div
        className="max-h-full overflow-auto rounded-lg bg-slate-900 p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-2 flex items-center justify-between gap-4">
          <div className="text-sm text-slate-200">
            Crop sidebar — aspect locked 360×696
          </div>
          <div className="text-[10px] text-slate-500">
            {rect
              ? `${Math.round(rect.w)}×${Math.round(rect.h)} → 360×696`
              : "loading..."}
          </div>
        </div>
        <div
          className="relative mx-auto touch-none select-none overscroll-contain"
          style={{ width: viewW || 200, height: viewH || 200 }}
        >
          <img
            ref={imgRef}
            src={src}
            alt=""
            draggable={false}
            onLoad={(e) => {
              const i = e.currentTarget;
              setImgSize({ w: i.naturalWidth, h: i.naturalHeight });
            }}
            className="block h-full w-full"
          />
          {r && imgSize && (
            <>
              <div
                className="pointer-events-none absolute bg-black/55"
                style={{ left: 0, top: 0, width: viewW, height: r.y }}
              />
              <div
                className="pointer-events-none absolute bg-black/55"
                style={{
                  left: 0,
                  top: r.y + r.h,
                  width: viewW,
                  height: viewH - (r.y + r.h),
                }}
              />
              <div
                className="pointer-events-none absolute bg-black/55"
                style={{ left: 0, top: r.y, width: r.x, height: r.h }}
              />
              <div
                className="pointer-events-none absolute bg-black/55"
                style={{
                  left: r.x + r.w,
                  top: r.y,
                  width: viewW - (r.x + r.w),
                  height: r.h,
                }}
              />
              <div
                className="absolute cursor-move touch-none border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,0.6)]"
                style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
                onPointerDown={(e) => beginDrag("pan", e)}
              >
                <div
                  className="absolute -bottom-1.5 -right-1.5 h-5 w-5 cursor-nwse-resize touch-none rounded-sm border border-slate-900 bg-white"
                  onPointerDown={(e) => beginDrag("resize", e)}
                />
              </div>
            </>
          )}
        </div>
        <div className="mt-3 flex items-center justify-between">
          <div className="text-[10px] text-slate-500">
            Drag to pan · corner to resize · aspect locked
          </div>
          <div className="flex gap-2">
            <button
              onClick={onCancel}
              className="rounded px-3 py-1 text-xs text-slate-400 hover:text-slate-200"
            >
              Cancel
            </button>
            <button
              onClick={apply}
              disabled={!rect}
              className="rounded bg-green-600 px-3 py-1 text-xs font-medium text-white hover:bg-green-500 disabled:opacity-50"
            >
              Apply crop
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}
