import { PerceptionError, createLogger } from '@accura/shared';
import type { BrowserSession } from '@accura/browser';
import type { Frame } from 'playwright';
import { walkPage, type WalkerOptions, type WalkerResult } from './walker.js';
import { buildPageStats, serializeElements } from './serializer.js';
import type { AgentObservation, ElementRecord, FrameSnapshot } from './types.js';

const log = createLogger('perception:observer');

export interface ObserverOptions {
  viewportLookaheadPx?: number;
  maxTextLength?: number;
  pageTextCap?: number;
  maxElementsChars?: number;
  /** Attach a screenshot to the observation (vision models only). */
  includeScreenshot?: boolean;
}

/** Frame-local ids are offset per frame ordinal so ids stay globally unique. */
const FRAME_ID_STRIDE = 1_000_000;

export function frameIndexForId(id: number): number {
  return Math.floor(id / FRAME_ID_STRIDE);
}

export function localIdForId(id: number): number {
  return id % FRAME_ID_STRIDE;
}

/**
 * Builds AgentObservations from a BrowserSession. Tracks the previous
 * step's element ids per URL so new elements can be `*`-marked — the diff
 * only applies when the URL is unchanged (a fresh page is all-new by
 * definition and marking it would be noise).
 */
export class Observer {
  private previousIds = new Set<number>();
  private previousUrl = '';

  constructor(
    private readonly session: BrowserSession,
    private readonly options?: ObserverOptions,
  ) {}

  async observe(): Promise<AgentObservation> {
    const page = this.session.page;
    const walkerOptions: WalkerOptions = {
      viewportLookaheadPx: this.options?.viewportLookaheadPx ?? 1000,
      maxTextLength: this.options?.maxTextLength ?? 80,
      pageTextCap: this.options?.pageTextCap ?? 5000,
    };

    const snapshots: FrameSnapshot[] = [];
    const frames = page.frames();
    for (let frameIndex = 0; frameIndex < frames.length; frameIndex += 1) {
      const frame = frames[frameIndex]!;
      const snapshot = await this.walkFrame(frame, frameIndex, walkerOptions);
      if (snapshot) snapshots.push(snapshot);
    }
    if (snapshots.length === 0) {
      throw new PerceptionError('Could not walk any frame on the page', {
        context: { url: page.url() },
      });
    }

    const elements: ElementRecord[] = snapshots.flatMap((s) => s.elements);
    const main = snapshots[0]!;

    const url = page.url();
    const currentIds = new Set(elements.map((e) => e.id));
    const newElementIds =
      url === this.previousUrl
        ? [...currentIds].filter((id) => !this.previousIds.has(id))
        : [];
    this.previousIds = currentIds;
    this.previousUrl = url;

    const elementsText = serializeElements(elements, new Set(newElementIds), main.scroll, {
      maxChars: this.options?.maxElementsChars ?? 40_000,
    });

    const events = this.session.drainEvents();
    const observation: AgentObservation = {
      url,
      title: await page.title().catch(() => ''),
      tabs: this.session.tabs().map(({ index, url: tabUrl, active }) => ({
        index,
        url: tabUrl,
        active,
      })),
      elements,
      elementsText,
      pageText: main.pageText,
      pageStats: buildPageStats(
        elements,
        snapshots.map((s) => s.stats),
      ),
      scroll: main.scroll,
      newElementIds,
      dialogs: [
        ...events.crashes.map((c) => `page crashed at ${c.url} and was restored`),
        ...events.dialogs.map((d) => `${d.type}(${d.handled}): ${d.message}`),
      ],
      downloads: events.downloads.map((d) => d.path ?? d.suggestedFilename),
    };

    if (this.options?.includeScreenshot) {
      const shot = await this.session.screenshot();
      observation.screenshot = {
        dataBase64: shot.data.toString('base64'),
        width: shot.width,
        height: shot.height,
      };
    }
    return observation;
  }

  private async walkFrame(
    frame: Frame,
    frameIndex: number,
    options: WalkerOptions,
  ): Promise<FrameSnapshot | null> {
    try {
      const result: WalkerResult = await frame.evaluate(walkPage, options);
      return {
        frameIndex,
        url: frame.url(),
        elements: result.elements.map((element) => ({
          ...element,
          id: frameIndex * FRAME_ID_STRIDE + element.id,
          frameIndex,
        })),
        scroll: result.scroll,
        stats: result.stats,
        pageText: result.pageText,
      };
    } catch (error) {
      // Cross-origin frames and frames detached mid-walk are skipped; the
      // main frame failing is fatal and handled by the caller.
      if (frameIndex === 0) {
        throw new PerceptionError('Failed to walk main frame', {
          cause: error,
          context: { url: frame.url() },
        });
      }
      log.debug({ frameIndex, url: frame.url() }, 'skipping unwalkable frame');
      return null;
    }
  }
}
