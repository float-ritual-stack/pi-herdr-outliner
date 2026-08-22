export interface CompletionWindow {
  start: number;
  end: number;
}

export function completionWindow(
  itemCount: number,
  selectedIndex: number,
  capacity: number,
): CompletionWindow {
  const visibleCount = Math.max(0, Math.min(itemCount, capacity));
  if (visibleCount === 0) {
    return { start: 0, end: 0 };
  }

  const clampedSelectedIndex = Math.max(
    0,
    Math.min(selectedIndex, itemCount - 1),
  );
  const centeredStartIndex =
    clampedSelectedIndex - Math.floor(visibleCount / 2);
  const start = Math.max(
    0,
    Math.min(centeredStartIndex, itemCount - visibleCount),
  );

  return { start, end: start + visibleCount };
}
