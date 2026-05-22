/**
 * Pick a readable foreground colour (ink black vs paper white) against a
 * given background hex.
 *
 * Used by the completed-task cards on Calendar + Day: when a card is
 * tinted with the completer's avatar colour, the checkmark glyph on
 * top needs to flip from black to white for the darkest avatars so the
 * mark stays visible. ITU-R BT.601 luma is the same formula every
 * contrast picker uses; threshold 140 (just above mid-grey) keeps the
 * mark ink-black on the typical pastel palette and only flips to paper
 * for near-black backgrounds.
 *
 * Falls back to ink when the colour isn't parseable as `#rrggbb`.
 */
export function pickInkOrPaper(bg: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(bg.trim());
  if (!m) return 'var(--ink)';
  const v = parseInt(m[1]!, 16);
  const r = (v >> 16) & 0xff;
  const g = (v >> 8) & 0xff;
  const b = v & 0xff;
  const luma = 0.299 * r + 0.587 * g + 0.114 * b;
  return luma > 140 ? 'var(--ink)' : 'var(--paper)';
}
