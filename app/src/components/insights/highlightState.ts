/**
 * 数据洞察 - 全局表高亮状态
 */
let _hlTable: string | null = null;
let _hlRole: 'read' | 'write' | null = null;
let _hlScript: string | null = null;
const _listeners = new Set<() => void>();

export function getHighlightedTable(): string | null { return _hlTable; }
export function getHighlightedRole(): 'read' | 'write' | null { return _hlRole; }

export function toggleHighlight(table: string, role: 'read' | 'write', script: string) {
  _hlTable = table; _hlRole = role; _hlScript = script;
  _listeners.forEach(f => f());
}

export function onHighlightChange(fn: () => void) { _listeners.add(fn); }

export function shouldHighlightRow(tableName: string, rowRole: 'read' | 'write', scriptName: string): boolean {
  if (!_hlTable || tableName !== _hlTable) return false;
  if (scriptName === _hlScript) return true;
  if (_hlRole === 'read') return rowRole === 'write';
  return rowRole === 'read';
}

export function shouldHighlightEdge(tableName: string, srcScript: string, tgtScript: string): boolean {
  if (!_hlTable || tableName !== _hlTable || !_hlRole) return false;
  if (_hlRole === 'read') return tgtScript === _hlScript;
  return srcScript === _hlScript;
}
