/**
 * Text Diff Tests
 */

import { describe, test, expect } from 'bun:test';
import { computeTextEdits, applyTextEdits, mergeAdjacentEdits } from '../src/utils/text-diff';

describe('Text Diff', () => {
  describe('computeTextEdits', () => {
    test('should return empty array for identical strings', () => {
      const edits = computeTextEdits('hello', 'hello');
      expect(edits).toEqual([]);
    });

    test('should handle empty to non-empty (insert all)', () => {
      const edits = computeTextEdits('', 'hello');
      expect(edits).toEqual([
        { position: 0, deleteCount: 0, insertText: 'hello' },
      ]);
    });

    test('should handle non-empty to empty (delete all)', () => {
      const edits = computeTextEdits('hello', '');
      expect(edits).toEqual([
        { position: 0, deleteCount: 5, insertText: '' },
      ]);
    });

    test('should handle insertion at beginning', () => {
      const edits = computeTextEdits('world', 'hello world');
      expect(edits).toHaveLength(1);
      expect(edits[0].position).toBe(0);
      expect(edits[0].deleteCount).toBe(0);
      expect(edits[0].insertText).toBe('hello ');
    });

    test('should handle insertion at end', () => {
      const edits = computeTextEdits('hello', 'hello world');
      expect(edits).toHaveLength(1);
      expect(edits[0].position).toBe(5);
      expect(edits[0].deleteCount).toBe(0);
      expect(edits[0].insertText).toBe(' world');
    });

    test('should handle insertion in middle', () => {
      const edits = computeTextEdits('helloworld', 'hello world');
      expect(edits).toHaveLength(1);
      expect(edits[0].position).toBe(5);
      expect(edits[0].deleteCount).toBe(0);
      expect(edits[0].insertText).toBe(' ');
    });

    test('should handle deletion at beginning', () => {
      const edits = computeTextEdits('hello world', 'world');
      expect(edits).toHaveLength(1);
      expect(edits[0].position).toBe(0);
      expect(edits[0].deleteCount).toBe(6);
      expect(edits[0].insertText).toBe('');
    });

    test('should handle deletion at end', () => {
      const edits = computeTextEdits('hello world', 'hello');
      expect(edits).toHaveLength(1);
      expect(edits[0].position).toBe(5);
      expect(edits[0].deleteCount).toBe(6);
      expect(edits[0].insertText).toBe('');
    });

    test('should handle deletion in middle', () => {
      const edits = computeTextEdits('hello world', 'helloworld');
      expect(edits).toHaveLength(1);
      expect(edits[0].position).toBe(5);
      expect(edits[0].deleteCount).toBe(1);
      expect(edits[0].insertText).toBe('');
    });

    test('should handle replacement in middle', () => {
      const edits = computeTextEdits('hello world', 'hello there');
      expect(edits).toHaveLength(1);
      expect(edits[0].position).toBe(6);
      expect(edits[0].deleteCount).toBe(5); // 'world'
      expect(edits[0].insertText).toBe('there');
    });

    test('should handle single character change', () => {
      const edits = computeTextEdits('hello', 'hallo');
      expect(edits).toHaveLength(1);
      expect(edits[0].position).toBe(1);
      expect(edits[0].deleteCount).toBe(1);
      expect(edits[0].insertText).toBe('a');
    });

    test('should handle complete replacement', () => {
      const edits = computeTextEdits('abc', 'xyz');
      expect(edits).toHaveLength(1);
      expect(edits[0].position).toBe(0);
      expect(edits[0].deleteCount).toBe(3);
      expect(edits[0].insertText).toBe('xyz');
    });
  });

  describe('applyTextEdits', () => {
    test('should apply insert edit', () => {
      const result = applyTextEdits('hello', [
        { position: 5, deleteCount: 0, insertText: ' world' },
      ]);
      expect(result).toBe('hello world');
    });

    test('should apply delete edit', () => {
      const result = applyTextEdits('hello world', [
        { position: 5, deleteCount: 6, insertText: '' },
      ]);
      expect(result).toBe('hello');
    });

    test('should apply replace edit', () => {
      const result = applyTextEdits('hello world', [
        { position: 6, deleteCount: 5, insertText: 'there' },
      ]);
      expect(result).toBe('hello there');
    });

    test('should apply multiple edits in order', () => {
      const result = applyTextEdits('hello', [
        { position: 0, deleteCount: 1, insertText: 'H' },
        { position: 5, deleteCount: 0, insertText: '!' },
      ]);
      expect(result).toBe('Hello!');
    });
  });

  describe('roundtrip', () => {
    const testCases = [
      ['hello', 'hello world'],
      ['hello world', 'hello'],
      ['hello world', 'hello there'],
      ['abc', 'xyz'],
      ['', 'test'],
      ['test', ''],
      ['The quick brown fox', 'The slow brown fox'],
      ['line1\nline2\nline3', 'line1\nmodified\nline3'],
    ];

    for (const [oldText, newText] of testCases) {
      test(`should roundtrip: "${oldText}" -> "${newText}"`, () => {
        const edits = computeTextEdits(oldText, newText);
        const result = applyTextEdits(oldText, edits);
        expect(result).toBe(newText);
      });
    }
  });

  describe('mergeAdjacentEdits', () => {
    test('should return single edit unchanged', () => {
      const edits = [{ position: 0, deleteCount: 5, insertText: 'hello' }];
      const merged = mergeAdjacentEdits(edits);
      expect(merged).toEqual(edits);
    });

    test('should merge adjacent edits', () => {
      const edits = [
        { position: 0, deleteCount: 3, insertText: 'abc' },
        { position: 3, deleteCount: 3, insertText: 'def' },
      ];
      const merged = mergeAdjacentEdits(edits);
      expect(merged).toHaveLength(1);
      expect(merged[0]).toEqual({
        position: 0,
        deleteCount: 6,
        insertText: 'abcdef',
      });
    });

    test('should not merge non-adjacent edits', () => {
      const edits = [
        { position: 0, deleteCount: 3, insertText: 'abc' },
        { position: 10, deleteCount: 3, insertText: 'xyz' },
      ];
      const merged = mergeAdjacentEdits(edits);
      expect(merged).toHaveLength(2);
    });
  });
});
