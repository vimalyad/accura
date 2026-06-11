import { ActionError } from '@accura/shared';
import type { BrowserSession } from '@accura/browser';
import type { ElementHandle } from 'playwright';
import { frameIndexForId, localIdForId } from './observer.js';

/**
 * Resolves an element id from the observation back to a live element handle.
 * Ids come exclusively from the enumerated list — the model can never invent
 * a selector. A miss returns an informative error the model can recover from
 * (the element may have been removed; re-observe).
 */
export async function resolveElement(
  session: BrowserSession,
  id: number,
): Promise<ElementHandle<HTMLElement>> {
  const frameIndex = frameIndexForId(id);
  const localId = localIdForId(id);
  const frame = session.page.frames()[frameIndex];
  if (!frame) {
    throw new ActionError(`Element ${id} refers to frame ${frameIndex} which no longer exists`, {
      context: { id, frameIndex },
    });
  }
  const handle = await frame.evaluateHandle(
    (lid: number) => window.__accuraRegistry?.byId.get(lid) ?? null,
    localId,
  );
  const element = handle.asElement();
  if (!element) {
    await handle.dispose();
    throw new ActionError(
      `Element ${id} not found - it may have been removed from the page. Re-observe before retrying.`,
      { context: { id } },
    );
  }
  return element as ElementHandle<HTMLElement>;
}
