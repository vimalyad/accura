import { describe, expect, it } from 'vitest';
import { checkDataGrounding } from '../src/grounding.js';

const observed = [
  'Product: SuperWidget — $49.99\nContact: sales@widgets.example\nMore at https://widgets.example/super',
];

describe('checkDataGrounding', () => {
  it('passes when every claimed value appears in observations', () => {
    const check = checkDataGrounding(
      'The SuperWidget costs $49.99, see https://widgets.example/super or email sales@widgets.example',
      observed,
    );
    expect(check.ok).toBe(true);
    expect(check.ungrounded).toEqual([]);
  });

  it('catches fabricated prices', () => {
    const check = checkDataGrounding('The SuperWidget costs $39.99', observed);
    expect(check.ok).toBe(false);
    expect(check.ungrounded).toEqual(['$39.99']);
  });

  it('catches fabricated urls and emails', () => {
    const check = checkDataGrounding(
      'Order at https://widgets.example/buy-now or email support@widgets.example',
      observed,
    );
    expect(check.ok).toBe(false);
    expect(check.ungrounded).toContain('https://widgets.example/buy-now');
    expect(check.ungrounded).toContain('support@widgets.example');
  });

  it('passes results with no checkable values', () => {
    const check = checkDataGrounding('The form was submitted successfully.', observed);
    expect(check.ok).toBe(true);
  });

  it('is case and whitespace tolerant', () => {
    const check = checkDataGrounding('price: $49.99', ['PRICE   IS  $49.99 TODAY']);
    expect(check.ok).toBe(true);
  });
});
