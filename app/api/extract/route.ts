// Ported from adv-menu-import/app/api/extract-ai/route.ts
// Dual-model extraction: Haiku for text-heavy content, Sonnet for visual/image content.

import Anthropic from "@anthropic-ai/sdk";
import { normalizeRotation, resizeImage } from "@/lib/extraction/imageProcessor";
import { extractPdfText, renderPdfPages } from "@/lib/extraction/pdfProcessor";
import { htmlToText } from "@/lib/extraction/htmlParser";
import { parseMhtml } from "@/lib/extraction/mhtmlParser";
import {
  stripRtf,
  extractDocxText,
  extractPptxText,
} from "@/lib/extraction/docParser";
import { parseAiResponse } from "@/lib/extraction/parseResponse";
import {
  MENU_SYSTEM_PROMPT,
  EXTENDED_MENU_SYSTEM_PROMPT,
} from "@/lib/extraction/prompts";
import { createServerClient } from "@/lib/supabase/server";
// Batch-governor calc-tokens client. Imported by relative path because the
// package has not been published to a registry yet; the source is a sibling
// repo under betterpostools/batch-governor. Single-shot route — no governor
// gating, only calibration feeds the central pricing + reservoir store.
import { CalcTokensClient } from "../../../../../batch-governor/clients/ts/calc-tokens/src/index";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const calcTokens = new CalcTokensClient();

export const maxDuration = 300; // Vercel Fluid Compute

// ---------------------------------------------------------------------------
// Usage logging — writes to demo_builder.usage_logs.
//
// Single-source-of-truth pricing lives in the batch-governor calculator
// service. We fetch the pricing table via the TS calc client instead of
// hand-rolling per-model rates here. After logging we call
// ``calibrateWithActualUsage`` so the governor's reservoir tracks actual
// token distribution for this operation (``menu-extract-{sourceType}``).
// Governor unreachable? We fall through silently — logging must never
// block extraction.
// ---------------------------------------------------------------------------
async function logUsage(params: {
  model: string;
  sourceType: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  rows: number;
  durationMs: number;
  ok: boolean;
  error?: string;
  sessionId?: string;
}) {
  try {
    const supabase = createServerClient();

    // Derive cost from the governor's pricing table. Fall back to zero when
    // the governor is down; usage still lands in usage_logs with cost=0 which
    // the operator can backfill from raw token counts.
    let cost = 0;
    try {
      const pricingTable = await calcTokens.getPricingTable();
      const pricing = pricingTable[params.model];
      if (pricing) {
        cost =
          params.inputTokens * pricing.input_per_token +
          params.outputTokens * pricing.output_per_token +
          (params.cacheReadTokens ?? 0) * pricing.cache_read_per_token;
      }
    } catch {
      // governor unreachable — cost stays 0, actual tokens still logged
    }

    await supabase.from("usage_logs").insert({
      session_id: params.sessionId ?? null,
      model: params.model,
      source_type: params.sourceType,
      input_tokens: params.inputTokens,
      output_tokens: params.outputTokens,
      cache_read_tokens: params.cacheReadTokens ?? 0,
      cost,
    });

    // BUSINESS RULE: every real AI call feeds the calibration reservoir so
    // later projections converge on truth (ADR-001). Fire-and-forget.
    if (params.ok && params.inputTokens > 0) {
      try {
        await calcTokens.calibrateWithActualUsage({
          operation: `menu-extract-${params.sourceType}`,
          model: params.model,
          actual_input: params.inputTokens,
          actual_output: params.outputTokens,
          actual_cost_usd: cost,
        });
      } catch {
        // governor unreachable — calibration skipped silently
      }
    }
  } catch {
    // Never let logging failures break extraction
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function detectFileType(fileName: string, mimeType: string) {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  return {
    ext,
    isMhtml:
      ext === "mhtml" ||
      ext === "mht" ||
      mimeType.includes("multipart/related") ||
      mimeType.includes("message/rfc822"),
    isHtml: ext === "html" || ext === "htm" || mimeType === "text/html",
    isPdf: mimeType === "application/pdf" || ext === "pdf",
    isText:
      ext === "txt" ||
      ext === "json" ||
      mimeType === "text/plain" ||
      mimeType === "application/json",
    isRtf:
      ext === "rtf" ||
      mimeType === "application/rtf" ||
      mimeType === "text/rtf",
    isDocx:
      ext === "docx" ||
      mimeType ===
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    isPptx:
      ext === "pptx" ||
      mimeType ===
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  };
}

function buildResponse(
  result: ReturnType<typeof parseAiResponse>,
  extendedMode: boolean,
  extras: Record<string, unknown> = {},
) {
  const json: Record<string, unknown> = {
    rows: result.rows,
    count: result.rows.length,
    graphics: result.graphics ?? [],
    ...extras,
  };
  if (extendedMode) {
    json.extendedRows = result.extendedRows;
    json.restaurantType = result.restaurantType;
    json.modifierTemplates = result.modifierTemplates;
  }
  return Response.json(json);
}

// ---------------------------------------------------------------------------
// Text extraction via Haiku (cheap, fast)
// ---------------------------------------------------------------------------
async function extractViaText(
  text: string,
  fileName: string,
  label: string,
  systemContent: string | Anthropic.Messages.TextBlockParam[],
  extendedMode: boolean,
  userSuffix: string,
  useCache: boolean,
  t0: number,
  sessionId?: string,
) {
  const stream = client.messages.stream({
    model: "claude-haiku-4-5",
    max_tokens: extendedMode ? 24000 : 16000,
    system: systemContent,
    messages: [
      {
        role: "user",
        content: `Extract all menu items from this ${label} named "${fileName}".\n\n---\n${text}\n---\n\n${userSuffix}`,
      },
    ],
  });
  const response = await stream.finalMessage();
  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text")
    throw new Error("No AI response text");

  const result = parseAiResponse(textBlock.text.trim(), extendedMode);
  await logUsage({
    model: "claude-haiku-4-5",
    sourceType: label,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
    rows: result.rows.length,
    durationMs: Date.now() - t0,
    ok: true,
    sessionId,
  });
  return result;
}

// ---------------------------------------------------------------------------
// Main POST handler
// ---------------------------------------------------------------------------
export async function POST(request: Request) {
  const t0 = Date.now();

  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    if (!file)
      return Response.json({ error: "No file provided" }, { status: 400 });

    const fileName =
      (formData.get("fileName") as string) || file.name || "file";
    const mimeType =
      (formData.get("mimeType") as string) || file.type || "";
    const extendedMode = formData.get("extendedMode") === "true";
    const sessionId = (formData.get("sessionId") as string) || undefined;
    const chunkGroupId =
      (formData.get("chunkGroupId") as string) || null;
    const batchId = (formData.get("batchId") as string) || null;

    let rawBuffer = Buffer.from(new Uint8Array(await file.arrayBuffer()));

    const systemPrompt = extendedMode
      ? EXTENDED_MENU_SYSTEM_PROMPT
      : MENU_SYSTEM_PROMPT;
    const userSuffix = extendedMode
      ? "Return JSON object only."
      : "Return JSON array only.";

    // Only cache system prompt when processing chunks/batches (avoids 1.25x write cost on singles)
    const useCache = !!(chunkGroupId || batchId);
    const systemContent: string | Anthropic.Messages.TextBlockParam[] =
      useCache
        ? [
            {
              type: "text" as const,
              text: systemPrompt,
              cache_control: { type: "ephemeral" as const },
            },
          ]
        : systemPrompt;

    const elapsed = () => `+${Date.now() - t0}ms`;
    console.log(
      `[extract] ${elapsed()} — fileName=${fileName}, mime=${mimeType}, size=${(rawBuffer.length / 1024).toFixed(0)}KB`,
    );

    const ft = detectFileType(fileName, mimeType);

    // Normalize EXIF orientation for images only
    if (
      !ft.isMhtml &&
      !ft.isHtml &&
      !ft.isPdf &&
      !ft.isText &&
      !ft.isRtf &&
      !ft.isDocx &&
      !ft.isPptx
    ) {
      rawBuffer = (await normalizeRotation(rawBuffer)) as typeof rawBuffer;
    }

    // ---- HTML ----
    if (ft.isHtml) {
      const html = rawBuffer.toString("utf-8");
      const pageText = htmlToText(html);
      const result = await extractViaText(
        pageText,
        fileName,
        "saved HTML page",
        systemContent,
        extendedMode,
        userSuffix,
        useCache,
        t0,
        sessionId,
      );
      return buildResponse(result, extendedMode);
    }

    // ---- MHTML ----
    if (ft.isMhtml) {
      const { html } = parseMhtml(rawBuffer);
      const pageText = htmlToText(html);
      const result = await extractViaText(
        pageText,
        fileName,
        "page",
        systemContent,
        extendedMode,
        userSuffix,
        useCache,
        t0,
        sessionId,
      );
      return buildResponse(result, extendedMode);
    }

    // ---- Plain text / JSON ----
    if (ft.isText) {
      const text = rawBuffer.toString("utf-8").slice(0, 40_000);
      const result = await extractViaText(
        text,
        fileName,
        "file",
        systemContent,
        extendedMode,
        userSuffix,
        useCache,
        t0,
        sessionId,
      );
      return buildResponse(result, extendedMode);
    }

    // ---- RTF ----
    if (ft.isRtf) {
      const text = stripRtf(rawBuffer.toString("utf-8"));
      const result = await extractViaText(
        text,
        fileName,
        "RTF document",
        systemContent,
        extendedMode,
        userSuffix,
        useCache,
        t0,
        sessionId,
      );
      return buildResponse(result, extendedMode);
    }

    // ---- DOCX ----
    if (ft.isDocx) {
      const text = await extractDocxText(rawBuffer);
      if (!text)
        return Response.json(
          { error: "Could not extract text from DOCX" },
          { status: 400 },
        );
      const result = await extractViaText(
        text,
        fileName,
        "Word document",
        systemContent,
        extendedMode,
        userSuffix,
        useCache,
        t0,
        sessionId,
      );
      return buildResponse(result, extendedMode);
    }

    // ---- PPTX ----
    if (ft.isPptx) {
      const text = await extractPptxText(rawBuffer);
      if (!text)
        return Response.json(
          { error: "Could not extract text from PPTX" },
          { status: 400 },
        );
      const result = await extractViaText(
        text,
        fileName,
        "PowerPoint file",
        systemContent,
        extendedMode,
        userSuffix,
        useCache,
        t0,
        sessionId,
      );
      return buildResponse(result, extendedMode);
    }

    // ---- PDF: auto-route text (Haiku) vs visual (Sonnet) ----
    if (ft.isPdf) {
      const pdfText = await extractPdfText(rawBuffer);
      const hasText = pdfText.trim().length >= 500;
      console.log(
        `[extract] PDF text chars=${pdfText.trim().length}, route=${hasText ? "text/haiku" : "visual/sonnet"}`,
      );

      if (hasText) {
        // Text-heavy PDF → Haiku (cheap, fast)
        const result = await extractViaText(
          pdfText,
          fileName,
          "PDF",
          systemContent,
          extendedMode,
          userSuffix,
          useCache,
          t0,
          sessionId,
        );
        return buildResponse(result, extendedMode, { mode: "text" });
      }

      // Visual PDF → render pages as JPEGs, send to Sonnet
      const renderedPages = await renderPdfPages(rawBuffer);
      const useRendered = renderedPages.length > 0;

      const imageContent = useRendered
        ? renderedPages.map((p) => ({
            type: "image" as const,
            source: {
              type: "base64" as const,
              media_type: p.mimeType as "image/jpeg",
              data: p.base64,
            },
          }))
        : [
            {
              type: "document" as const,
              source: {
                type: "base64" as const,
                media_type: "application/pdf" as const,
                data: rawBuffer.toString("base64"),
              },
            },
          ];

      const stream = client.messages.stream({
        model: "claude-sonnet-4-6",
        max_tokens: 64000,
        system: systemContent,
        messages: [
          {
            role: "user",
            content: [
              ...imageContent,
              {
                type: "text",
                text: `Extract all menu items from this PDF named "${fileName}". ${userSuffix}`,
              },
            ],
          },
        ],
      });
      const response = await stream.finalMessage();
      const textBlock = response.content.find((b) => b.type === "text");
      if (!textBlock || textBlock.type !== "text")
        return Response.json({ error: "No AI response" }, { status: 500 });

      const result = parseAiResponse(textBlock.text.trim(), extendedMode);
      await logUsage({
        model: "claude-sonnet-4-6",
        sourceType: "pdf-visual",
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
        rows: result.rows.length,
        durationMs: Date.now() - t0,
        ok: true,
        sessionId,
      });
      return buildResponse(result, extendedMode, { mode: "visual" });
    }

    // ---- Image uploads (non-PDF) ----
    let imageBuffer: Buffer = rawBuffer;
    let resized = false;
    const MAX_BYTES = 3_900_000;

    if (imageBuffer.length > MAX_BYTES) {
      const resizeResult = await resizeImage(imageBuffer, {
        maxDim: 2048,
        quality: 85,
      });
      imageBuffer = resizeResult.buffer;
      resized = resizeResult.resized;
    }

    const base64 = imageBuffer.toString("base64");
    const validImageTypes = [
      "image/jpeg",
      "image/png",
      "image/gif",
      "image/webp",
    ];
    const imageMediaType = resized
      ? "image/jpeg"
      : validImageTypes.includes(mimeType)
        ? mimeType
        : "image/jpeg";

    const stream = client.messages.stream({
      model: "claude-sonnet-4-6",
      max_tokens: 64000,
      system: systemContent,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: imageMediaType as
                  | "image/jpeg"
                  | "image/png"
                  | "image/gif"
                  | "image/webp",
                data: base64,
              },
            },
            {
              type: "text",
              text: `Extract all menu items from this image named "${fileName}". ${userSuffix}`,
            },
          ],
        },
      ],
    });

    const response = await stream.finalMessage();
    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text")
      return Response.json({ error: "No AI response" }, { status: 500 });

    const result = parseAiResponse(textBlock.text.trim(), extendedMode);
    await logUsage({
      model: "claude-sonnet-4-6",
      sourceType: "image",
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      rows: result.rows.length,
      durationMs: Date.now() - t0,
      ok: true,
      sessionId,
    });
    return buildResponse(result, extendedMode);
  } catch (error: unknown) {
    const err = error as { status?: number; message?: string };
    console.error("[extract] error:", err?.message);

    try {
      await logUsage({
        model: "unknown",
        sourceType: "unknown",
        inputTokens: 0,
        outputTokens: 0,
        rows: 0,
        durationMs: Date.now() - t0,
        ok: false,
        error: err?.message,
      });
    } catch {
      /* ignore logging errors */
    }

    const status = err?.status || 500;
    let msg = err?.message || "Internal server error";
    let code = status;

    if (
      status === 413 ||
      msg.includes("too large") ||
      msg.includes("payload")
    ) {
      code = 413;
      msg =
        "File too large — try splitting the menu into sections or uploading a smaller file.";
    } else if (
      status === 429 ||
      msg.includes("rate_limit") ||
      msg.includes("rate limit")
    ) {
      code = 429;
      msg = "Rate limited — please wait a moment and try again.";
    } else if (
      status === 401 ||
      msg.includes("invalid x-api-key") ||
      msg.includes("authentication")
    ) {
      code = 401;
      msg = "API authentication failed — check your Anthropic API key.";
    } else if (
      status === 408 ||
      msg.includes("timeout") ||
      msg.includes("overloaded") ||
      msg === "terminated"
    ) {
      code = 503;
      msg = "AI service disconnected — please try again.";
    }

    return Response.json({ error: msg }, { status: code });
  }
}
