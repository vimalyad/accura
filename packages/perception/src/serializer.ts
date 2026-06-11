import type { AgentObservation, ElementRecord, PageStats, ScrollInfo } from './types.js';

export interface SerializeOptions {
  maxChars?: number;
}

const DEFAULT_MAX_CHARS = 40_000;

/**
 * Renders the enumerated element list the model sees. One line per element:
 *
 *   *[12]<button type=submit> "Sign in"
 *
 * `*` marks elements new since the previous step on the same URL — the
 * signal that drives "a suggestion dropdown appeared, click it" behavior.
 * Off-viewport elements are summarized, not listed, with scroll hints.
 */
export function serializeElements(
  elements: ElementRecord[],
  newElementIds: ReadonlySet<number>,
  scroll: ScrollInfo,
  options?: SerializeOptions,
): string {
  const maxChars = options?.maxChars ?? DEFAULT_MAX_CHARS;
  const lines: string[] = [];

  if (scroll.pagesAbove > 0.1) {
    lines.push(`... ${scroll.pagesAbove} pages above - scroll up to reveal ...`);
  } else {
    lines.push('[Start of page]');
  }

  const visible = elements.filter((e) => e.inViewport);
  const hidden = elements.length - visible.length;

  for (const element of visible) {
    lines.push(formatElement(element, newElementIds.has(element.id)));
    if (lines.join('\n').length > maxChars) {
      lines.push(`... element list truncated at ${maxChars} chars ...`);
      break;
    }
  }

  if (hidden > 0) {
    lines.push(`... ${hidden} more interactive elements outside the viewport ...`);
  }
  if (scroll.pagesBelow > 0.1) {
    lines.push(`... ${scroll.pagesBelow} pages below - scroll down to reveal more ...`);
  } else {
    lines.push('[End of page]');
  }
  return lines.join('\n');
}

function formatElement(element: ElementRecord, isNew: boolean): string {
  const parts: string[] = [];
  if (element.role && element.role !== element.tag) parts.push(`role=${element.role}`);
  for (const [name, value] of Object.entries(element.attributes)) {
    // Drop attribute values that duplicate the visible text — pure noise.
    if (value === element.text && value.length > 5) continue;
    parts.push(`${name}=${quoteIfNeeded(value)}`);
  }
  const attrText = parts.length > 0 ? ` ${parts.join(' ')}` : '';
  const frame = element.frameIndex > 0 ? `|frame${element.frameIndex}|` : '';
  const marker = isNew ? '*' : '';
  const text = element.text ? ` "${element.text}"` : '';
  return `${marker}[${element.id}]${frame}<${element.tag}${attrText}>${text}`;
}

function quoteIfNeeded(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

export function buildPageStats(
  elements: ElementRecord[],
  frameStats: Array<{ links: number; iframes: number; textChars: number }>,
): PageStats {
  const links = frameStats.reduce((sum, s) => sum + s.links, 0);
  const iframes = frameStats.reduce((sum, s) => sum + s.iframes, 0);
  const textChars = frameStats.reduce((sum, s) => sum + s.textChars, 0);
  const warnings: string[] = [];
  if (elements.length < 3 && textChars < 200) {
    warnings.push('Page appears empty - it may still be loading or failed to render.');
  } else if (elements.length > 20 && textChars < 5 * elements.length) {
    warnings.push('Page has many elements but very little text - possibly skeleton/placeholder content still loading.');
  }
  return {
    interactiveElements: elements.length,
    links,
    iframes,
    textChars,
    warnings,
  };
}

/** Human-readable header block placed above the element list in prompts. */
export function describeObservation(observation: AgentObservation): string {
  const lines = [
    `URL: ${observation.url}`,
    `Title: ${observation.title}`,
  ];
  if (observation.tabs.length > 1) {
    lines.push(
      `Tabs: ${observation.tabs
        .map((tab) => `${tab.active ? '*' : ''}[${tab.index}] ${tab.url}`)
        .join(' | ')}`,
    );
  }
  if (observation.pageStats.warnings.length > 0) {
    lines.push(`Warnings: ${observation.pageStats.warnings.join(' ')}`);
  }
  if (observation.dialogs.length > 0) {
    lines.push(`Dialogs auto-handled since last step: ${observation.dialogs.join('; ')}`);
  }
  if (observation.downloads.length > 0) {
    lines.push(`Downloads: ${observation.downloads.join('; ')}`);
  }
  lines.push('', 'Interactive elements:', observation.elementsText);
  return lines.join('\n');
}
