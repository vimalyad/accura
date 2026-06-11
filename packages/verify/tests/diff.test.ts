import { describe, expect, it } from 'vitest';
import type { AgentObservation, ElementRecord } from '@accura/perception';
import { detectContradiction, diffObservations } from '../src/diff.js';

function element(id: number, attributes: Record<string, string> = {}): ElementRecord {
  return {
    id,
    tag: 'input',
    attributes,
    bbox: { x: 0, y: 0, width: 10, height: 10 },
    inViewport: true,
    frameIndex: 0,
  };
}

function observation(partial: Partial<AgentObservation>): AgentObservation {
  return {
    url: 'https://a.test/',
    title: 't',
    tabs: [],
    elements: [],
    elementsText: '',
    pageText: '',
    pageStats: { interactiveElements: 0, links: 0, iframes: 0, textChars: 0, warnings: [] },
    scroll: { pagesAbove: 0, pagesBelow: 0 },
    newElementIds: [],
    dialogs: [],
    downloads: [],
    ...partial,
  };
}

describe('diffObservations', () => {
  it('reports url changes', () => {
    const diff = diffObservations(
      observation({ url: 'https://a.test/' }),
      observation({ url: 'https://a.test/checkout' }),
    );
    expect(diff.urlChanged).toBe(true);
    expect(diff.inert).toBe(false);
    expect(diff.summary).toContain('URL changed');
  });

  it('counts added and removed elements', () => {
    const diff = diffObservations(
      observation({ elements: [element(1), element(2)] }),
      observation({ elements: [element(2), element(3), element(4)] }),
    );
    expect(diff.addedElements).toBe(2);
    expect(diff.removedElements).toBe(1);
  });

  it('detects form value changes on stable elements', () => {
    const diff = diffObservations(
      observation({ elements: [element(5, { value: '' })] }),
      observation({ elements: [element(5, { value: 'ada' })] }),
    );
    expect(diff.formValueChanges).toEqual(['[5] value: (empty) -> ada']);
    expect(diff.inert).toBe(false);
  });

  it('flags inert transitions', () => {
    const before = observation({ elements: [element(1, { value: 'x' })] });
    const after = observation({ elements: [element(1, { value: 'x' })] });
    const diff = diffObservations(before, after);
    expect(diff.inert).toBe(true);
    expect(diff.summary).toContain('NO observable change');
  });
});

describe('detectContradiction', () => {
  it('warns when successful actions produced no observable change', () => {
    const diff = diffObservations(observation({}), observation({}));
    expect(detectContradiction(true, diff)).toContain('NOTHING observable changed');
  });

  it('stays silent when something changed or actions already failed', () => {
    const changed = diffObservations(
      observation({}),
      observation({ url: 'https://a.test/next' }),
    );
    expect(detectContradiction(true, changed)).toBeUndefined();
    const inert = diffObservations(observation({}), observation({}));
    expect(detectContradiction(false, inert)).toBeUndefined();
  });
});
