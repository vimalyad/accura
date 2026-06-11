import type { AgentObservation } from '@accura/perception';

export interface StateDiff {
  urlChanged: boolean;
  fromUrl: string;
  toUrl: string;
  addedElements: number;
  removedElements: number;
  formValueChanges: string[];
  dialogs: string[];
  /** True when nothing observable changed at all. */
  inert: boolean;
  /** One-paragraph "what changed" rendering for the model's history. */
  summary: string;
}

/**
 * Deterministic post-action change observation (Agent-E's measured win):
 * telling the model what actually changed after its actions is the cheapest
 * defense against acting on assumptions.
 */
export function diffObservations(before: AgentObservation, after: AgentObservation): StateDiff {
  const urlChanged = before.url !== after.url;

  const beforeIds = new Set(before.elements.map((e) => e.id));
  const afterIds = new Set(after.elements.map((e) => e.id));
  let addedElements = 0;
  for (const id of afterIds) if (!beforeIds.has(id)) addedElements += 1;
  let removedElements = 0;
  for (const id of beforeIds) if (!afterIds.has(id)) removedElements += 1;

  const formValueChanges: string[] = [];
  if (!urlChanged) {
    const beforeById = new Map(before.elements.map((e) => [e.id, e]));
    for (const element of after.elements) {
      const prior = beforeById.get(element.id);
      if (!prior) continue;
      for (const key of ['value', 'checked', 'selected', 'expanded'] as const) {
        const was = prior.attributes[key];
        const now = element.attributes[key];
        if (was !== now) {
          formValueChanges.push(`[${element.id}] ${key}: ${display(was)} -> ${display(now)}`);
        }
      }
    }
  }

  const dialogs = after.dialogs;
  const inert =
    !urlChanged &&
    addedElements === 0 &&
    removedElements === 0 &&
    formValueChanges.length === 0 &&
    dialogs.length === 0;

  const parts: string[] = [];
  if (urlChanged) {
    parts.push(`URL changed: ${before.url} -> ${after.url}`);
  } else {
    parts.push('URL unchanged');
  }
  if (addedElements > 0) parts.push(`${addedElements} new element(s)`);
  if (removedElements > 0) parts.push(`${removedElements} element(s) removed`);
  if (formValueChanges.length > 0) parts.push(`form changes: ${formValueChanges.join('; ')}`);
  if (dialogs.length > 0) parts.push(`dialogs: ${dialogs.join('; ')}`);
  if (inert) parts.push('NO observable change');

  return {
    urlChanged,
    fromUrl: before.url,
    toUrl: after.url,
    addedElements,
    removedElements,
    formValueChanges,
    dialogs,
    inert,
    summary: parts.join('; '),
  };
}

/**
 * Flags the dangerous case: the agent's actions all reported success, but
 * the page shows no observable change. Per Web Bench, acting on assumed
 * success is the #1 failure mode — this warning forces re-verification.
 */
function display(value: string | undefined): string {
  return value === undefined || value === '' ? '(empty)' : value;
}

export function detectContradiction(allActionsSucceeded: boolean, diff: StateDiff): string | undefined {
  if (allActionsSucceeded && diff.inert) {
    return (
      'WARNING: your previous actions reported success but NOTHING observable changed ' +
      '(same URL, same elements, same form values). The actions likely had no effect. ' +
      'Verify the page state before proceeding; try a different element or approach.'
    );
  }
  return undefined;
}
