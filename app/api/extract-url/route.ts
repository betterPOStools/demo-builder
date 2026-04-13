// URL-based extraction — ported from adv-menu-import/app/api/extract-url/route.ts
// Handles both HTML and PDF URLs with dual-model routing.

import Anthropic from "@anthropic-ai/sdk";
import {
  htmlToText,
  extractPageTitle,
  extractImageUrls,
  extractJsonLd,
} from "@/lib/extraction/htmlParser";
import { extractPdfText, renderPdfPages } from "@/lib/extraction/pdfProcessor";
import { parseAiResponse } from "@/lib/extraction/parseResponse";
import {
  MENU_SYSTEM_PROMPT,
  EXTENDED_MENU_SYSTEM_PROMPT,
} from "@/lib/extraction/prompts";
import type { ExtractedGraphic } from "@/lib/types/menu";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export const maxDuration = 300;

const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
  "Sec-Ch-Ua": '"Chromium";v="131", "Not_A Brand";v="24", "Google Chrome";v="131"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"macOS"',
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
};

async function downloadImage(
  url: string,
): Promise<ExtractedGraphic | null> {
  try {
    const res = await fetch(url, {
      headers: BROWSER_HEADERS,
      signal: AbortSignal.timeout(8000),
      redirect: "follow",
    });
    if (!res.ok) return null;
    const ct = (res.headers.get("content-type") || "").split(";")[0].trim();
    if (!ct.startsWith("image/") && ct !== "image/svg+xml") return null;
    const buf = Buffer.from(new Uint8Array(await res.arrayBuffer()));
    if (buf.length < 500) return null; // skip tracking pixels
    const rawName =
      url.split("/").pop()?.split("?")[0]?.split("#")[0] || "image";
    return {
      name: rawName,
      mimeType: ct,
      base64: buf.toString("base64"),
      type: "downloaded",
      description: "Downloaded from page",
    };
  } catch {
    return null;
  }
}

export async function POST(request: Request) {
  const t0 = Date.now();

  try {
    const body = (await request.json()) as {
      url?: string;
      rawText?: string;
      extendedMode?: boolean;
      sessionId?: string;
    };

    if (!body.url && !body.rawText) {
      return Response.json({ error: "No URL or rawText provided" }, { status: 400 });
    }

    const url = body.url ?? "";
    const extendedMode = !!body.extendedMode;
    const systemPrompt = extendedMode
      ? EXTENDED_MENU_SYSTEM_PROMPT
      : MENU_SYSTEM_PROMPT;
    const userSuffix = extendedMode
      ? "Return JSON object only."
      : "Return JSON array only.";

    // ── rawText fast-path: skip URL fetch entirely ────────────────────────────
    // Used by the local deploy agent when Playwright pre-fetched a JS-rendered page.
    if (body.rawText) {
      const extractionContent = body.rawText.slice(0, 40_000);
      const userMessage = `Extract all menu items from this restaurant website.\nURL: ${url || "unknown"}\n\n---\n${extractionContent}\n---\n\n${userSuffix}`;

      console.log(`[extract-url] rawText path — ${extractionContent.length} chars, url=${url || "none"}`);

      const stream = client.messages.stream({
        model: "claude-haiku-4-5",
        max_tokens: extendedMode ? 24000 : 16000,
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }],
      });

      const response = await stream.finalMessage();
      const textBlock = response.content.find((b) => b.type === "text");
      if (!textBlock || textBlock.type !== "text") {
        return Response.json({ error: "No AI response" }, { status: 500 });
      }

      const result = parseAiResponse(textBlock.text.trim(), extendedMode);
      const json: Record<string, unknown> = {
        rows: result.rows,
        count: result.rows.length,
        graphics: [],
        pageTitle: null,
        sourceUrl: url || "raw-text",
        suggestedName: url ? new URL(url).hostname.replace(/^www\./, "") : null,
      };
      if (extendedMode) {
        json.extendedRows = result.extendedRows;
        json.restaurantType = result.restaurantType;
        json.modifierTemplates = result.modifierTemplates;
      }
      console.log(`[extract-url] rawText extracted ${result.rows.length} rows in ${Date.now() - t0}ms`);
      return Response.json(json);
    }

    // Fetch the URL — retry with Google webcache on 403
    let pageRes = await fetch(url, {
      headers: BROWSER_HEADERS,
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    });

    if (pageRes.status === 403) {
      console.log(`[extract-url] Direct fetch 403, trying Google cache`);
      const cacheUrl = `https://webcache.googleusercontent.com/search?q=cache:${encodeURIComponent(url)}`;
      try {
        const cacheRes = await fetch(cacheUrl, {
          headers: BROWSER_HEADERS,
          redirect: "follow",
          signal: AbortSignal.timeout(15_000),
        });
        if (cacheRes.ok) {
          pageRes = cacheRes;
          console.log(`[extract-url] Google cache hit`);
        }
      } catch {
        // cache unavailable, fall through to original error
      }
    }

    if (!pageRes.ok) {
      return Response.json(
        { error: `Failed to fetch URL (HTTP ${pageRes.status}). The site may be blocking automated requests — try uploading a PDF or screenshot instead.` },
        { status: 502 },
      );
    }

    const contentType = (pageRes.headers.get("content-type") || "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    const isPdfUrl =
      contentType === "application/pdf" ||
      url.split("?")[0].toLowerCase().endsWith(".pdf");

    // Derive suggested restaurant name from hostname
    const suggestedName = (() => {
      try {
        return new URL(url).hostname.replace(/^www\./, "");
      } catch {
        return null;
      }
    })();

    // ---- PDF URL ----
    if (isPdfUrl) {
      const arrayBuffer = await pageRes.arrayBuffer();
      const buffer = Buffer.from(new Uint8Array(arrayBuffer));

      const pdfText = await extractPdfText(buffer);
      const usePdfText = pdfText.trim().length >= 500;

      console.log(
        `[extract-url] PDF url, text chars=${pdfText.trim().length}, route=${usePdfText ? "text/haiku" : "visual/sonnet"}`,
      );

      let response: Anthropic.Messages.Message;

      if (usePdfText) {
        // Text-heavy PDF → Haiku
        const stream = client.messages.stream({
          model: "claude-haiku-4-5",
          max_tokens: extendedMode ? 24000 : 16000,
          system: systemPrompt,
          messages: [
            {
              role: "user",
              content: `Extract all menu items from this PDF menu. URL: ${url}\n\n---\n${pdfText}\n---\n\n${userSuffix}`,
            },
          ],
        });
        response = await stream.finalMessage();
      } else {
        // Visual PDF → Sonnet
        const renderedPages = await renderPdfPages(buffer);
        const imageContent =
          renderedPages.length > 0
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
                    data: buffer.toString("base64"),
                  },
                },
              ];

        const stream = client.messages.stream({
          model: "claude-sonnet-4-6",
          max_tokens: 64000,
          system: systemPrompt,
          messages: [
            {
              role: "user",
              content: [
                ...imageContent,
                {
                  type: "text",
                  text: `Extract all menu items from this PDF menu. URL: ${url}\n\n${userSuffix}`,
                },
              ],
            },
          ],
        });
        response = await stream.finalMessage();
      }

      const textBlock = response.content.find((b) => b.type === "text");
      if (!textBlock || textBlock.type !== "text") {
        return Response.json({ error: "No AI response" }, { status: 500 });
      }

      const result = parseAiResponse(textBlock.text.trim(), extendedMode);

      const json: Record<string, unknown> = {
        rows: result.rows,
        count: result.rows.length,
        graphics: [],
        sourceUrl: url,
        suggestedName,
        mode: usePdfText ? "text" : "visual",
      };
      if (extendedMode) {
        json.extendedRows = result.extendedRows;
        json.restaurantType = result.restaurantType;
        json.modifierTemplates = result.modifierTemplates;
      }
      return Response.json(json);
    }

    // ---- HTML URL ----
    let html = await pageRes.text();
    let pageText = htmlToText(html);
    let pageTitle = extractPageTitle(html);

    // If text is sparse, the site is likely a JS SPA. Retry with Googlebot UA
    // since many sites serve pre-rendered HTML for SEO bots.
    if (pageText.trim().length < 50) {
      console.log(
        `[extract-url] Sparse text (${pageText.trim().length} chars), retrying with Googlebot UA`,
      );
      try {
        const botRes = await fetch(url, {
          headers: {
            ...BROWSER_HEADERS,
            "User-Agent":
              "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
          },
          redirect: "follow",
          signal: AbortSignal.timeout(15_000),
        });
        if (botRes.ok) {
          const botHtml = await botRes.text();
          const botText = htmlToText(botHtml);
          if (botText.trim().length > pageText.trim().length) {
            console.log(
              `[extract-url] Googlebot got ${botText.trim().length} chars (was ${pageText.trim().length})`,
            );
            html = botHtml;
            pageText = botText;
            pageTitle = extractPageTitle(botHtml) || pageTitle;
          }
        }
      } catch {
        // Googlebot retry failed, continue with what we have
      }
    }

    const jsonLd = extractJsonLd(html);

    // Build the best content we have for extraction
    let extractionContent = pageText;
    let contentSource = "text";

    if (pageText.trim().length < 50) {
      if (jsonLd.length > 50) {
        // JS-rendered site but has structured data — use JSON-LD
        extractionContent = `[JSON-LD structured data from page]\n${jsonLd}`;
        contentSource = "json-ld";
        console.log(
          `[extract-url] Using JSON-LD (${jsonLd.length} chars)`,
        );
      } else if (html.length > 500) {
        // No JSON-LD but HTML has content — send raw HTML (trimmed)
        extractionContent = html.slice(0, 40_000);
        contentSource = "raw-html";
        console.log(
          `[extract-url] No JSON-LD, sending raw HTML (${html.length} chars)`,
        );
      } else {
        return Response.json(
          {
            error:
              "Page has too little content to extract menu items from. Try uploading a PDF or screenshot instead.",
          },
          { status: 400 },
        );
      }
    }

    // Download page images in parallel (up to 50)
    const imgUrls = extractImageUrls(html, url).slice(0, 50);
    const imgResults = await Promise.allSettled(imgUrls.map(downloadImage));
    const graphics: ExtractedGraphic[] = imgResults
      .filter(
        (r): r is PromiseFulfilledResult<ExtractedGraphic | null> =>
          r.status === "fulfilled" && r.value !== null,
      )
      .map((r) => r.value!);

    const userMessage =
      contentSource === "json-ld"
        ? `Extract all menu items from this restaurant's structured data.\nURL: ${url}\n\n---\n${extractionContent}\n---\n\n${userSuffix}`
        : contentSource === "raw-html"
          ? `Extract all menu items from this restaurant website HTML. The site may be JavaScript-rendered so focus on any menu data, prices, or item names in the markup.\nURL: ${url}\n\n---\n${extractionContent}\n---\n\n${userSuffix}`
          : `Extract all menu items from this restaurant website.\nURL: ${url}\n\n---\n${extractionContent}\n---\n\n${userSuffix}`;

    const stream = client.messages.stream({
      model: "claude-haiku-4-5",
      max_tokens: extendedMode ? 24000 : 16000,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: userMessage,
        },
      ],
    });

    const response = await stream.finalMessage();
    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      return Response.json({ error: "No AI response" }, { status: 500 });
    }

    console.log(
      `[extract-url] AI response (${textBlock.text.length} chars, source=${contentSource}): ${textBlock.text.slice(0, 300)}`,
    );

    const result = parseAiResponse(textBlock.text.trim(), extendedMode);

    const json: Record<string, unknown> = {
      rows: result.rows,
      count: result.rows.length,
      graphics,
      pageTitle,
      sourceUrl: url,
      suggestedName: pageTitle || suggestedName,
    };
    if (extendedMode) {
      json.extendedRows = result.extendedRows;
      json.restaurantType = result.restaurantType;
      json.modifierTemplates = result.modifierTemplates;
    }
    return Response.json(json);
  } catch (error: unknown) {
    const err = error as { status?: number; message?: string };
    console.error("[extract-url] error:", err?.message);

    const status = err?.status || 500;
    let msg = err?.message || "Internal server error";
    let code = status;

    if (
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
    } else if (msg.includes("HTTP 4") || msg.includes("HTTP 5")) {
      code = 502;
      msg = `Could not fetch URL — ${msg}`;
    } else if (msg.includes("abort")) {
      code = 504;
      msg =
        "URL fetch timed out — the site may be too slow or blocking requests";
    }

    return Response.json({ error: msg }, { status: code });
  }
}
