// Model: web.FileTree rule-433 — plain-text copy that also works over plain
// http on the LAN, where navigator.clipboard is unavailable (non-secure
// context). Mirrors the strategy in RichCopy but for text only: try the
// async API first, then fall back to a selected off-screen textarea and
// execCommand('copy'), which only needs a user gesture.
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through */ }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '0';
  ta.style.left = '0';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  try {
    ta.select();
    ta.setSelectionRange(0, text.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    ta.remove();
  }
}
