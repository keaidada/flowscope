/**
 * 数据洞察 - 全局表高亮状态
 * 追踪被点击的表名、角色（读/写）和来源脚本，实现精准上下游高亮。
 */
let _hlTable: string | null = null;
let _hlRole: 'read' | 'write' | null = null;
let _hlScript: string | null = null;
const _listeners = new Set<() => void>();

export function getHighlightedTable(): string | null { return _hlTable; }
export function getHighlightedRole(): 'read' | 'write' | null { return _hlRole; }

export function toggleHighlight(table: string, role: 'read' | 'write', script: string) {
  if (_hlTable === table) {
    _hlTable = null; _hlRole = null; _hlScript = null;
  } else {
    _hlTable = table; _hlRole = role; _hlScript = script;
  }
  _listeners.forEach(f => f());
}

export function onHighlightChange(fn: () => void) { _listeners.add(fn); }

/**
 * 判断当前行是否应该高亮：
 * - 同脚本的匹配表始终高亮（自己）
 * - 上游点击（读行）→ 只高亮写者
 * - 下游点击（写行）→ 只高亮读者
 */
export function shouldHighlightRow(tableName: string, rowRole: 'read' | 'write', scriptName: string): boolean {
  if (!_hlTable || tableName !== _hlTable) return false;
  // 自己的行始终高亮
  if (scriptName === _hlScript) return true;
  // 上下游方向：点击读行 → 高亮写者（上游）; 点击写行 → 高亮读者（下游）
  if (_hlRole === 'read') return rowRole === 'write';
  return rowRole === 'read';
}
