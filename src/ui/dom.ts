export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function q<T extends Element>(root: ParentNode, selector: string): T {
  const found = root.querySelector(selector);
  if (!found) throw new Error(`找不到元素：${selector}`);
  return found as T;
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

let toastSeq = 0;

export function toast(message: string, kind: 'info' | 'error' = 'info', ms = 4200): void {
  const host = document.getElementById('toasts');
  if (!host) return;
  const id = `toast-${++toastSeq}`;
  const node = el('div', `toast toast-${kind}`, message);
  node.id = id;
  host.appendChild(node);
  setTimeout(() => {
    node.classList.add('toast-out');
    setTimeout(() => node.remove(), 220);
  }, ms);
}

export function setBusy(button: HTMLButtonElement, busy: boolean, busyLabel = '處理中…'): void {
  if (busy) {
    button.dataset.label = button.textContent ?? '';
    button.textContent = busyLabel;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.label ?? button.textContent;
    button.disabled = false;
  }
}

export function copyText(text: string): Promise<void> {
  return navigator.clipboard.writeText(text);
}
