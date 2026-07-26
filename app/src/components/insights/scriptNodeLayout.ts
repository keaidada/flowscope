import type { OutputGroup } from '@pondpilot/flowscope-react';

export const ROW = 22;
const HEADER_H = 55;
const SECTION_HEADER_H = 24;
const READ_START = 94;
const GAP_BETWEEN_SECTIONS = 13;
const DIVIDER_H = 10;

export interface HandlePosition {
  qname: string;
  y: number;
}

export interface GroupLayoutInfo {
  inputs: HandlePosition[];
  outputs: HandlePosition[];
  startY: number;
  height: number;
}

export interface ScriptNodeLayout {
  groups: GroupLayoutInfo[];
  totalHeight: number;
  readHandleY: Map<string, number>;
  writeHandleY: Map<string, number>;
}

/**
 * Compute the layout for a script node, supporting both flat (single group)
 * and grouped (multiple output groups) layouts.
 */
export function computeScriptNodeLayout(
  outputGroups: OutputGroup[] | undefined,
  tableNamesRead: string[],
  tableNamesWritten: string[]
): ScriptNodeLayout {
  const readHandleY = new Map<string, number>();
  const writeHandleY = new Map<string, number>();

  // If we have outputGroups with multiple entries, use grouped layout
  if (outputGroups && outputGroups.length > 1) {
    const groups: GroupLayoutInfo[] = [];
    let cursor = HEADER_H;

    // Collect all qnames covered by outputGroups to detect orphans
    const coveredReads = new Set<string>();
    const coveredWrites = new Set<string>();
    for (const g of outputGroups) {
      g.inputs.forEach((q) => coveredReads.add(q));
      g.outputs.forEach((q) => coveredWrites.add(q));
    }

    // Find orphan tables: in tableNamesRead/Written but not in any group
    const orphanReads = tableNamesRead.filter((q) => !coveredReads.has(q));
    const orphanWrites = tableNamesWritten.filter((q) => !coveredWrites.has(q));

    // Append orphans as a synthetic group so they are still rendered
    const allGroups = [...outputGroups];
    if (orphanReads.length > 0 && orphanWrites.length > 0) {
      allGroups.push({ inputs: orphanReads, outputs: orphanWrites });
    }

    for (let gi = 0; gi < allGroups.length; gi++) {
      const g = allGroups[gi];
      const groupStartY = cursor;
      const inputs: HandlePosition[] = [];
      const outputs: HandlePosition[] = [];

      // Input section
      const inputStartY = cursor + SECTION_HEADER_H;
      for (let i = 0; i < g.inputs.length; i++) {
        const y = inputStartY + i * ROW;
        inputs.push({ qname: g.inputs[i], y });
        readHandleY.set(g.inputs[i], y);
      }
      cursor = inputStartY + Math.max(g.inputs.length, 0) * ROW;

      // Output section
      cursor += g.inputs.length > 0 && g.outputs.length > 0 ? GAP_BETWEEN_SECTIONS : 0;
      const outputStartY = cursor + SECTION_HEADER_H;
      for (let i = 0; i < g.outputs.length; i++) {
        const y = outputStartY + i * ROW;
        outputs.push({ qname: g.outputs[i], y });
        writeHandleY.set(g.outputs[i], y);
      }
      cursor = outputStartY + Math.max(g.outputs.length, 0) * ROW;

      const height = cursor - groupStartY;
      groups.push({ inputs, outputs, startY: groupStartY, height });

      // Divider between groups
      if (gi < allGroups.length - 1) {
        cursor += DIVIDER_H;
      }
    }

    return { groups, totalHeight: cursor, readHandleY, writeHandleY };
  }

  // Flat layout (backward compatible)
  const reads = tableNamesRead ?? [];
  const writes = tableNamesWritten ?? [];
  const readY = (i: number) => READ_START + i * ROW;
  const writeStart =
    READ_START + SECTION_HEADER_H + Math.max(reads.length, 1) * ROW + GAP_BETWEEN_SECTIONS;
  const writeY = (i: number) => writeStart + i * ROW;

  for (let i = 0; i < reads.length; i++) readHandleY.set(reads[i], readY(i));
  for (let i = 0; i < writes.length; i++) writeHandleY.set(writes[i], writeY(i));

  const totalHeight =
    HEADER_H +
    SECTION_HEADER_H +
    Math.max(reads.length, 1) * ROW +
    GAP_BETWEEN_SECTIONS +
    SECTION_HEADER_H +
    Math.max(writes.length, 1) * ROW;

  return {
    groups: [
      {
        inputs: reads.map((qname, i) => ({ qname, y: readY(i) })),
        outputs: writes.map((qname, i) => ({ qname, y: writeY(i) })),
        startY: HEADER_H,
        height: totalHeight - HEADER_H,
      },
    ],
    totalHeight,
    readHandleY,
    writeHandleY,
  };
}

/**
 * Estimate the expanded script node height for layout algorithms.
 */
export function estimateScriptNodeHeight(
  outputGroups: OutputGroup[] | undefined,
  readCount: number,
  writeCount: number
): number {
  if (outputGroups && outputGroups.length > 1) {
    let height = HEADER_H;

    // Account for orphans: tables in readCount/writeCount not covered by outputGroups
    let coveredReads = 0;
    let coveredWrites = 0;
    for (const g of outputGroups) {
      coveredReads += g.inputs.length;
      coveredWrites += g.outputs.length;
    }
    const orphanReads = readCount - coveredReads;
    const orphanWrites = writeCount - coveredWrites;

    for (let gi = 0; gi < outputGroups.length; gi++) {
      const g = outputGroups[gi];
      const hasInputs = g.inputs.length > 0;
      const hasOutputs = g.outputs.length > 0;
      height += SECTION_HEADER_H + g.inputs.length * ROW;
      if (hasInputs && hasOutputs) height += GAP_BETWEEN_SECTIONS;
      height += SECTION_HEADER_H + g.outputs.length * ROW;
      if (gi < outputGroups.length - 1) height += DIVIDER_H;
    }

    // Add orphan group if both sides have content
    if (orphanReads > 0 && orphanWrites > 0) {
      if (outputGroups.length > 0) height += DIVIDER_H;
      height += SECTION_HEADER_H + orphanReads * ROW;
      if (orphanReads > 0 && orphanWrites > 0) height += GAP_BETWEEN_SECTIONS;
      height += SECTION_HEADER_H + orphanWrites * ROW;
    }

    return height;
  }
  const rs = readCount > 0 ? SECTION_HEADER_H + readCount * ROW : 0;
  const ws = writeCount > 0 ? SECTION_HEADER_H + writeCount * ROW : 0;
  const gap = readCount > 0 && writeCount > 0 ? GAP_BETWEEN_SECTIONS : 0;
  return HEADER_H + rs + gap + ws;
}
