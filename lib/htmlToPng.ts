/**
 * Render an HTML string to a PNG data URI using html2canvas.
 * The HTML is injected into a fixed off-screen div, captured, then removed.
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

  try {
    const canvas = await html2canvas(container, {
      width,
      height,
      scale: 1,
      useCORS: false,
      logging: false,
      backgroundColor: null, // preserve transparency if any
    });
    return canvas.toDataURL("image/png");
  } finally {
    document.body.removeChild(container);
  }
}
