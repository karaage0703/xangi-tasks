import { marked } from 'marked';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import { Markdown } from '@tiptap/markdown';
import { TableKit } from '@tiptap/extension-table';
import Image from '@tiptap/extension-image';

// Keep image references editable without fetching remote images when opening a task.
const ImageReference = Image.extend({
  renderHTML({ node }) {
    return ['span', { class: 'description-image-reference', 'data-image-reference': '' }, `画像: ${node.attrs.alt || node.attrs.src}`];
  },
});

export function updateMarkdownEditor(source, container, { reset = false, disabled = false, onCommit = () => {}, labelId = 'description-label', describedBy = 'quick-save-status' } = {}) {
  let state = container.descriptionState;
  // Tiptap interprets HTML and drops comments. Retain an automatic plain-source
  // editor for those documents instead of losing user content on the next save.
  let rawHtml = false;
  marked.walkTokens(marked.lexer(source.value), token => { if (token.type === 'html') rawHtml = true; });
  if (rawHtml) {
    container.descriptionState = null; state?.editor.destroy();
    container.descriptionAbort?.abort(); container.editorComposing = false;
    container.hidden = true; source.hidden = false;
    source.setAttribute('aria-labelledby', labelId);
    return;
  }
  if (reset && state) { container.descriptionState = null; state.editor.destroy(); state = null; container.editorComposing = false; }
  if (!state) {
    container.replaceChildren(); container.hidden = false;
    state = { editor: null, value: source.value, commit: onCommit, loading: true, composing: false, pendingCommit: false };
    container.descriptionState = state;
    const sync = () => {
      if (state.loading) return;
      state.value = state.editor.getMarkdown().trim();
      source.value = state.value;
      source.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const commit = () => {
      if (state.loading || container.descriptionState !== state) return;
      if (state.composing) { state.pendingCommit = true; return; }
      state.pendingCommit = false;
      state.commit();
    };
    state.editor = new Editor({
      element: container,
      extensions: [StarterKit.configure({ link: { openOnClick: false, autolink: false } }), TaskList, TaskItem.configure({ nested: true, HTMLAttributes: { 'data-type': 'taskItem' }, a11y: { checkboxLabel: node => `${node.textContent || '項目'}の完了` } }), TableKit, ImageReference, Markdown.configure({ markedOptions: { gfm: true, breaks: true } })],
      content: source.value,
      contentType: 'markdown',
      editable: !disabled,
      editorProps: {
        attributes: { role: 'textbox', 'aria-multiline': 'true', 'aria-labelledby': labelId, 'aria-describedby': describedBy },
        handleDOMEvents: {
          compositionstart: () => { state.composing = true; container.editorComposing = true; return false; },
          compositionend: () => {
            // Keep all field saves blocked until the final composition transaction settles.
            setTimeout(() => {
              if (container.descriptionState !== state) return;
              state.composing = false; container.editorComposing = false;
              sync(); if (state.pendingCommit) commit();
            }, 0);
            return false;
          },
        },
        handleKeyDown: (_view, event) => {
          if (!event.isComposing && event.keyCode !== 229 && !state.composing && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault(); commit(); return true;
          }
          return false;
        },
      },
      onUpdate: () => { if (state.composing) source.dispatchEvent(new Event('input', { bubbles: true })); else sync(); },
      onBlur: () => commit(),
    });
    state.editor.state.doc.check();
    // Loading and polling must not normalize and save untouched Markdown.
    state.loading = false;
    source.hidden = true;
    container.addEventListener('change', event => {
      if (event.target.matches('input[type="checkbox"]')) queueMicrotask(() => {
        if (container.descriptionState === state) commit();
      });
    }, { signal: attachLifecycle(container) });
  }
  state.commit = onCommit;
  if (state.value.trim() !== source.value.trim() && !state.composing && !container.contains(document.activeElement)) {
    state.loading = true;
    state.editor.commands.setContent(source.value, { contentType: 'markdown', emitUpdate: false });
    state.value = source.value;
    state.loading = false;
  }
  // Keep the focused editor alive through saves, polls and retries.
  state.editor.setEditable(!disabled, false);
  for (const checkbox of container.querySelectorAll('input[type=checkbox]')) checkbox.disabled = disabled;
  source.hidden = true; container.hidden = false;
}

function attachLifecycle(container) {
  container.descriptionAbort?.abort();
  const abort = new AbortController(); container.descriptionAbort = abort;
  return abort.signal;
}
