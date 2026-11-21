// Adapted from Paseo v0.16.2 composer/recall.ts and composer/insert-text.ts (Apache-2.0).
export class ComposerRecall {
  #recalled = null;

  handleKeyPress(event, { text, selection }, messages) {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return null;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || selection.start !== selection.end) return null;
    const recalled = this.#recalled?.text === text ? this.#recalled : null;
    if (!recalled) {
      this.#recalled = null;
      return event.key === "ArrowUp" && !text ? this.#show(messages, 0) : null;
    }
    if (event.key === "ArrowUp") {
      return text.slice(0, selection.start).includes("\n") ? null : this.#show(messages, recalled.index + 1);
    }
    if (text.slice(selection.start).includes("\n")) return null;
    if (recalled.index) return this.#show(messages, recalled.index - 1);
    this.#recalled = null;
    return "";
  }

  #show(messages, index) {
    const text = messages[index];
    if (text === undefined) return null;
    this.#recalled = { index, text };
    return text;
  }
}

export function insertAtSelection({ text, selection }, inserted) {
  const start = Math.min(selection.start, selection.end);
  const end = Math.max(selection.start, selection.end);
  return { text: text.slice(0, start) + inserted + text.slice(end), caret: start + inserted.length };
}

export function compactInstructions(text) {
  const draft = text.trim();
  return /^\/compact(?:\s|$)/.test(draft) ? draft.slice("/compact".length).trimStart() : null;
}
