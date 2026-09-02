export interface TagColor {
  background: string;
  foreground: string;
}

// The golden angle spreads N sequential points maximally around a circle — assigning each tag a
// hue by its index in the full, stable, alphabetically-sorted tag universe (not by hashing the
// tag string alone) guarantees distinct tags never collide on the same hue, which a plain hash
// can't promise (two different strings can hash to the same bucket).
const GOLDEN_ANGLE = 137.50776;

export function tagColor(tag: string, allTagsSorted: string[]): TagColor {
  const index = Math.max(0, allTagsSorted.indexOf(tag));
  const hue = (index * GOLDEN_ANGLE) % 360;
  return { background: `hsl(${hue.toFixed(1)}, 55%, 38%)`, foreground: '#ffffff' };
}
