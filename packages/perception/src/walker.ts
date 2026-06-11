/**
 * In-page DOM walker, executed inside each frame via frame.evaluate().
 *
 * Produces the enumerated action space: visible interactive elements with
 * stable ids. Ids are minted once per DOM node (WeakMap on the window) so
 * the model's references stay valid across steps — re-numbered ordinals are
 * a known accuracy killer. The id→node map is rebuilt on every call and
 * consumed by the actions package to resolve ids back to live elements.
 *
 * This file must stay self-contained: it is serialized into the page, so it
 * cannot import anything.
 */

export interface WalkerElement {
  id: number;
  tag: string;
  role?: string;
  text?: string;
  attributes: Record<string, string>;
  bbox: { x: number; y: number; width: number; height: number };
  inViewport: boolean;
}

export interface WalkerResult {
  elements: WalkerElement[];
  scroll: { pagesAbove: number; pagesBelow: number };
  stats: { links: number; iframes: number; textChars: number };
  pageText: string;
}

export interface WalkerOptions {
  viewportLookaheadPx: number;
  maxTextLength: number;
  pageTextCap: number;
}

interface AccuraRegistry {
  weak: WeakMap<Element, number>;
  byId: Map<number, Element>;
  next: number;
}

declare global {
  interface Window {
    __accuraRegistry?: AccuraRegistry;
  }
}

export function walkPage(options: WalkerOptions): WalkerResult {
  const registry: AccuraRegistry = window.__accuraRegistry ?? {
    weak: new WeakMap<Element, number>(),
    byId: new Map<number, Element>(),
    next: 1,
  };
  window.__accuraRegistry = registry;
  registry.byId.clear();

  const INTERACTIVE_TAGS = new Set([
    'button',
    'select',
    'textarea',
    'option',
    'summary',
    'details',
  ]);
  const INTERACTIVE_ROLES = new Set([
    'button',
    'link',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'tab',
    'checkbox',
    'radio',
    'combobox',
    'option',
    'switch',
    'slider',
    'searchbox',
    'textbox',
    'gridcell',
  ]);
  // Containers whose interactivity propagates: their nested spans/divs are
  // redundant noise unless independently meaningful.
  const PROPAGATING = new Set(['a', 'button']);

  const elements: WalkerElement[] = [];
  let links = 0;
  let iframes = 0;

  function attr(el: Element, name: string): string | null {
    const value = el.getAttribute(name);
    return value === null ? null : value.slice(0, 100);
  }

  function isVisible(el: Element, style: CSSStyleDeclaration, rect: DOMRect): boolean {
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (parseFloat(style.opacity) === 0) return false;
    if (rect.width <= 1 && rect.height <= 1) return false;
    return true;
  }

  function inViewportWindow(rect: DOMRect): boolean {
    return (
      rect.top < window.innerHeight + options.viewportLookaheadPx &&
      rect.bottom > -options.viewportLookaheadPx / 5
    );
  }

  function isInteractive(el: Element, style: CSSStyleDeclaration): boolean {
    const tag = el.tagName.toLowerCase();
    if (INTERACTIVE_TAGS.has(tag)) return true;
    if (tag === 'input') return (el as HTMLInputElement).type !== 'hidden';
    if (tag === 'a') return true;
    if (tag === 'label') {
      // label[for] double-activates its control when clicked by an agent —
      // exclude it; the control itself is listed. Wrapping labels are kept.
      if ((el as HTMLLabelElement).htmlFor) return false;
      return el.querySelector('input,select,textarea') !== null;
    }
    if ((el as HTMLElement).isContentEditable) return true;
    const role = el.getAttribute('role');
    if (role && INTERACTIVE_ROLES.has(role)) return true;
    if (
      el.hasAttribute('onclick') ||
      el.hasAttribute('onmousedown') ||
      el.hasAttribute('onkeydown')
    ) {
      return true;
    }
    const tabindex = el.getAttribute('tabindex');
    if (tabindex !== null && tabindex !== '-1') return true;
    if (style.cursor === 'pointer') {
      // Only the outermost pointer-cursor element: nested children inherit
      // the cursor and would each be listed as separate phantom targets.
      const parent = el.parentElement;
      if (!parent) return true;
      return getComputedStyle(parent).cursor !== 'pointer';
    }
    return false;
  }

  function elementText(el: Element): string {
    const html = el as HTMLElement;
    const text = (html.innerText ?? html.textContent ?? '').trim().replace(/\s+/g, ' ');
    return text.slice(0, options.maxTextLength);
  }

  function buildAttributes(el: Element): Record<string, string> {
    const out: Record<string, string> = {};
    const tag = el.tagName.toLowerCase();
    for (const name of ['type', 'placeholder', 'aria-label', 'name', 'title', 'alt', 'href']) {
      const value = attr(el, name);
      if (value) out[name] = value;
    }
    if (tag === 'input') {
      const input = el as HTMLInputElement;
      if (input.type === 'checkbox' || input.type === 'radio') {
        out.checked = String(input.checked);
      } else if (input.type === 'password') {
        // Never serialize password values (prompt-injection exfiltration path).
        if (input.value) out.value = '<redacted>';
      } else if (input.value) {
        // Live property, not the attribute: reflects what was actually typed.
        out.value = input.value.slice(0, 100);
      }
      if (input.type === 'date' || input.type === 'time' || input.type === 'datetime-local') {
        out.format =
          input.type === 'date'
            ? 'YYYY-MM-DD'
            : input.type === 'time'
              ? 'HH:MM'
              : 'YYYY-MM-DDTHH:MM';
      }
    } else if (tag === 'textarea') {
      const value = (el as HTMLTextAreaElement).value;
      if (value) out.value = value.slice(0, 100);
    } else if (tag === 'select') {
      const select = el as HTMLSelectElement;
      const selected = select.selectedOptions[0]?.textContent?.trim();
      if (selected) out.selected = selected.slice(0, 100);
      out.options = Array.from(select.options)
        .slice(0, 12)
        .map((o) => o.textContent?.trim() ?? '')
        .join('|')
        .slice(0, 200);
    }
    if (el.getAttribute('aria-expanded')) out.expanded = el.getAttribute('aria-expanded')!;
    if ((el as HTMLButtonElement).disabled === true) out.disabled = 'true';
    return out;
  }

  function visit(node: Element, insidePropagating: boolean): void {
    const tag = node.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'svg') return;
    if (tag === 'iframe' || tag === 'frame') {
      iframes += 1;
      return; // child frames are walked separately via page.frames()
    }

    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    const visible = isVisible(node, style, rect);

    if (visible && isInteractive(node, style)) {
      const isFormControl = tag === 'input' || tag === 'select' || tag === 'textarea';
      const independentlyMeaningful =
        isFormControl || PROPAGATING.has(tag) || node.hasAttribute('aria-label');
      if (!insidePropagating || independentlyMeaningful) {
        if (tag === 'a') links += 1;
        let id = registry.weak.get(node);
        if (id === undefined) {
          id = registry.next;
          registry.next += 1;
          registry.weak.set(node, id);
        }
        registry.byId.set(id, node);
        const record: WalkerElement = {
          id,
          tag,
          attributes: buildAttributes(node),
          bbox: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
          inViewport: inViewportWindow(rect),
        };
        const role = node.getAttribute('role');
        if (role) record.role = role;
        const text = isFormControl ? '' : elementText(node);
        if (text) record.text = text;
        elements.push(record);
        insidePropagating = insidePropagating || PROPAGATING.has(tag);
      }
    }

    // Recurse into children and open shadow roots.
    const shadowRoot = (node as HTMLElement).shadowRoot;
    if (shadowRoot) {
      for (const child of Array.from(shadowRoot.children)) visit(child, insidePropagating);
    }
    for (const child of Array.from(node.children)) visit(child, insidePropagating);
  }

  if (document.body) visit(document.body, false);

  const pageText = (document.body?.innerText ?? '')
    .replace(/\n{3,}/g, '\n\n')
    .slice(0, options.pageTextCap);

  const viewportHeight = window.innerHeight || 1;
  const scrollHeight = document.documentElement.scrollHeight;
  const scrollY = window.scrollY;

  return {
    elements,
    scroll: {
      pagesAbove: Math.round((scrollY / viewportHeight) * 10) / 10,
      pagesBelow:
        Math.round((Math.max(0, scrollHeight - scrollY - viewportHeight) / viewportHeight) * 10) /
        10,
    },
    stats: { links, iframes, textChars: pageText.length },
    pageText,
  };
}
