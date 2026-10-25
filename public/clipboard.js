async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(value); return; } catch { /* Try the synchronous fallback. */ }
  }
  const focused = document.activeElement;
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.readOnly = true;
  textarea.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
  // A modal makes elements outside it inert, so copy inside the active dialog.
  (document.querySelector('dialog[open]') || document.body).append(textarea);
  try {
    textarea.focus(); textarea.select(); textarea.setSelectionRange(0, value.length);
    if (!document.execCommand('copy')) throw new Error('Clipboard unavailable');
  } finally { textarea.remove(); focused?.focus({ preventScroll: true }); }
}
