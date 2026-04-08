/**
 * Render an HTML string to a PNG data URI using html2canvas.
 * Supports <style> tags inline in the HTML — browsers process style elements
 * anywhere in the document, and html2canvas reads computed styles correctly.
 * Runs client-side only.
 */
export async function htmlToPng(
  html: string,
  width: number,
  height: number,
): Promise<string> {
  const html2canvas = (await import("html2canvas")).default;

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
  container.innerHTML = html;
  document.body.appendChild(container);

  // Give the browser one frame to apply styles from any injected <style> tags
  await new Promise<void>((r) => requestAnimationFrame(() => r()));

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
  }
}
