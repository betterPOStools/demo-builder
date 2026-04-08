/**
 * Render an HTML string to a PNG data URI using html2canvas.
 * Supports <style> tags in the HTML — they are hoisted into a scoped <style>
 * injected into document.head so html2canvas can read computed styles.
 * Runs client-side only.
 */
export async function htmlToPng(
  html: string,
  width: number,
  height: number,
): Promise<string> {
  const html2canvas = (await import("html2canvas")).default;

  // Extract any <style> blocks from the HTML so we can hoist them
  const styleBlocks: string[] = [];
  const bodyHtml = html.replace(/<style>([\s\S]*?)<\/style>/gi, (_, css) => {
    styleBlocks.push(css);
    return "";
  });

  // Inject extracted CSS into document head with a unique scope marker
  let styleEl: HTMLStyleElement | null = null;
  if (styleBlocks.length > 0) {
    styleEl = document.createElement("style");
    styleEl.setAttribute("data-htmltopng", "1");
    styleEl.textContent = styleBlocks.join("\n");
    document.head.appendChild(styleEl);
  }

  const container = document.createElement("div");
  container.style.cssText = `
    position: fixed;
    left: -9999px;
    top: -9999px;
    width: ${width}px;
    height: ${height}px;
    overflow: hidden;
    pointer-events: none;
  `;
  container.innerHTML = bodyHtml;
  document.body.appendChild(container);

  try {
    const canvas = await html2canvas(container, {
      width,
      height,
      scale: 1,
      useCORS: false,
      logging: false,
      backgroundColor: null,
    });
    return canvas.toDataURL("image/png");
  } finally {
    document.body.removeChild(container);
    if (styleEl) document.head.removeChild(styleEl);
  }
}
