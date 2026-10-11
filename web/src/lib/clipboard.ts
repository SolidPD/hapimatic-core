// SPDX-License-Identifier: AGPL-3.0-only
export async function safeCopyToClipboard(text: string): Promise<void> {
  // Try modern Clipboard API first
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (err) {
      console.warn("[Clipboard] writeText failed, trying fallback:", err);
      // Fall through to fallback
    }
  }

  // Fallback for older browsers or restricted contexts (e.g., PWA on iOS)
  const textArea = document.createElement("textarea");
  textArea.value = text;
  // Avoid scrolling to bottom
  textArea.style.top = "0";
  textArea.style.left = "0";
  textArea.style.position = "fixed";
  textArea.style.opacity = "0";
  document.body.appendChild(textArea);
  textArea.focus();
  textArea.select();

  try {
    const successful = document.execCommand("copy");
    if (!successful) {
      throw new Error("execCommand copy failed");
    }
  } finally {
    document.body.removeChild(textArea);
  }
}
