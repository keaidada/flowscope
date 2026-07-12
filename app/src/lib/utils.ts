import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { byteOffsetToCharOffset } from '@pondpilot/flowscope-core';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Short unique id generator — replaces crypto.randomUUID() for shorter ids.
 * ~12 chars: timestamp(base36) + process-local counter + random. Short enough
 * for project/file/schema ids (user-scale) while staying unique in a session.
 */
let _genIdCounter = 0;
export function genId(): string {
  _genIdCounter += 1;
  return (
    Date.now().toString(36) +
    _genIdCounter.toString(36) +
    Math.random().toString(36).slice(2, 5)
  );
}

/**
 * Detect whether a file is text by scanning the first chunk for NULL bytes (0x00).
 * Classic heuristic (same as git/file): text (UTF-8/ASCII) has no NULL bytes;
 * binaries (images, archives, executables) almost always do.
 * Note: UTF-16 text contains NULL bytes and would be misdetected as binary — rare in practice.
 */
export async function isTextFile(file: File, sampleBytes = 8192): Promise<boolean> {
  try {
    const buf = await file.slice(0, sampleBytes).arrayBuffer();
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] === 0) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Convert a UTF-8 byte offset into a line:column position within a string.
 * Lines are 1-indexed, columns are 1-indexed.
 *
 * Handles UTF-8 to UTF-16 conversion internally since JavaScript strings
 * use UTF-16 encoding while FlowScope spans use UTF-8 byte offsets.
 *
 * @param content - The string content
 * @param byteOffset - UTF-8 byte offset from the start of the string
 * @returns Line and column (both 1-indexed), or { line: 1, column: 1 } if conversion fails
 */
export function byteOffsetToLineColumn(
  content: string,
  byteOffset: number
): { line: number; column: number } {
  // Handle edge cases - empty content or negative offset
  if (!content || byteOffset < 0) {
    return { line: 1, column: 1 };
  }

  // Convert UTF-8 byte offset to JavaScript character index (UTF-16 code units)
  let charOffset: number;
  try {
    charOffset = byteOffsetToCharOffset(content, byteOffset);
    // Clamp to content length in case the offset exceeds the string
    charOffset = Math.min(charOffset, content.length);
  } catch (error) {
    // If conversion fails (e.g., offset exceeds string length or doesn't land on boundary),
    // clamp to string length to provide best-effort result
    if (import.meta.env.DEV) {
      console.warn('[byteOffsetToLineColumn] Conversion failed, clamping to end:', error);
    }
    charOffset = content.length;
  }

  const textUpToOffset = content.slice(0, charOffset);
  const lines = textUpToOffset.split('\n');
  return {
    line: lines.length,
    column: (lines[lines.length - 1]?.length ?? 0) + 1,
  };
}
