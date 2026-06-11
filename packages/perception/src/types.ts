export interface ElementRecord {
  /** Stable id: persists across steps for the lifetime of the DOM node. */
  id: number;
  tag: string;
  role?: string;
  /** Visible text or accessible label, truncated. */
  text?: string;
  attributes: Record<string, string>;
  bbox: { x: number; y: number; width: number; height: number };
  inViewport: boolean;
  /** Index into page.frames() where this element lives. */
  frameIndex: number;
}

export interface ScrollInfo {
  pagesAbove: number;
  pagesBelow: number;
}

export interface PageStats {
  interactiveElements: number;
  links: number;
  iframes: number;
  textChars: number;
  warnings: string[];
}

export interface FrameSnapshot {
  frameIndex: number;
  url: string;
  elements: ElementRecord[];
  scroll: ScrollInfo;
  stats: { links: number; iframes: number; textChars: number };
  pageText: string;
}

export interface AgentObservation {
  url: string;
  title: string;
  tabs: Array<{ index: number; url: string; active: boolean }>;
  elements: ElementRecord[];
  /** The serialized element tree shown to the model. */
  elementsText: string;
  /** Visible page text (capped) for context beyond interactive elements. */
  pageText: string;
  pageStats: PageStats;
  scroll: ScrollInfo;
  /** Element ids that appeared since the previous observation on the same URL. */
  newElementIds: number[];
  screenshot?: { dataBase64: string; width: number; height: number };
  dialogs: string[];
  downloads: string[];
}
