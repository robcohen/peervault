/**
 * Text Diff Utilities
 *
 * Simple text diffing for efficient CRDT updates.
 * Finds the minimal changes between two strings.
 */

/** A single text edit operation */
export interface TextEdit {
  /** Position where the edit starts */
  position: number;
  /** Number of characters to delete */
  deleteCount: number;
  /** Text to insert (empty string for pure deletion) */
  insertText: string;
}

/**
 * Compute the minimal edits to transform `oldText` into `newText`.
 * Uses a simple prefix/suffix matching algorithm for single edits.
 * For complex multi-edit cases, falls back to full replacement.
 */
export function computeTextEdits(oldText: string, newText: string): TextEdit[] {
  // Fast path: identical strings
  if (oldText === newText) {
    return [];
  }

  // Fast path: empty to non-empty (pure insert)
  if (oldText.length === 0) {
    return [{ position: 0, deleteCount: 0, insertText: newText }];
  }

  // Fast path: non-empty to empty (pure delete)
  if (newText.length === 0) {
    return [{ position: 0, deleteCount: oldText.length, insertText: "" }];
  }

  // Find common prefix
  let prefixLen = 0;
  const minLen = Math.min(oldText.length, newText.length);
  while (prefixLen < minLen && oldText[prefixLen] === newText[prefixLen]) {
    prefixLen++;
  }

  // Find common suffix (from the end, not overlapping with prefix)
  let suffixLen = 0;
  const maxSuffixLen = minLen - prefixLen;
  while (
    suffixLen < maxSuffixLen &&
    oldText[oldText.length - 1 - suffixLen] ===
      newText[newText.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  // Calculate the changed region
  const deleteStart = prefixLen;
  const deleteEnd = oldText.length - suffixLen;
  const insertStart = prefixLen;
  const insertEnd = newText.length - suffixLen;

  const deleteCount = deleteEnd - deleteStart;
  const insertText = newText.slice(insertStart, insertEnd);

  // If nothing changed, return empty
  if (deleteCount === 0 && insertText.length === 0) {
    return [];
  }

  return [{ position: deleteStart, deleteCount, insertText }];
}

/**
 * Apply text edits to a string.
 * Useful for testing the diff algorithm.
 */
export function applyTextEdits(text: string, edits: TextEdit[]): string {
  // Sort edits by position in reverse order (apply from end to start)
  const sortedEdits = [...edits].sort((a, b) => b.position - a.position);

  let result = text;
  for (const edit of sortedEdits) {
    const before = result.slice(0, edit.position);
    const after = result.slice(edit.position + edit.deleteCount);
    result = before + edit.insertText + after;
  }

  return result;
}

/**
 * Check if text edits can be merged into a single edit.
 * Adjacent or overlapping edits can often be combined.
 */
export function mergeAdjacentEdits(edits: TextEdit[]): TextEdit[] {
  if (edits.length <= 1) return edits;

  // Sort by position
  const sorted = [...edits].sort((a, b) => a.position - b.position);

  const merged: TextEdit[] = [];
  let current: TextEdit = sorted[0]!;

  for (let i = 1; i < sorted.length; i++) {
    const next: TextEdit = sorted[i]!;
    const currentEnd = current.position + current.deleteCount;

    // Check if edits are adjacent or overlapping
    if (next.position <= currentEnd) {
      // Merge: extend delete count and append insert text
      const newDeleteEnd = Math.max(
        currentEnd,
        next.position + next.deleteCount,
      );
      current = {
        position: current.position,
        deleteCount: newDeleteEnd - current.position,
        insertText: current.insertText + next.insertText,
      };
    } else {
      merged.push(current);
      current = next;
    }
  }

  merged.push(current);
  return merged;
}
