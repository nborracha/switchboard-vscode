import * as assert from 'node:assert';
import { tagColor } from '../../src/tagColor';

suite('tagColor', () => {
  test('is stable for the same tag and the same tag universe', () => {
    const universe = ['bug', 'frontend', 'urgent'];
    assert.deepStrictEqual(tagColor('bug', universe), tagColor('bug', universe));
  });

  test('never assigns the same color to two different tags in the same universe', () => {
    const universe = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta'];
    const colors = universe.map((tag) => tagColor(tag, universe).background);
    assert.strictEqual(new Set(colors).size, colors.length);
  });

  test('background is a valid hsl() string with white foreground text', () => {
    const universe = ['frontend'];
    const { background, foreground } = tagColor('frontend', universe);
    assert.match(background, /^hsl\(\d{1,3}(\.\d)?, \d{1,3}%, \d{1,3}%\)$/);
    assert.strictEqual(foreground, '#ffffff');
  });
});
