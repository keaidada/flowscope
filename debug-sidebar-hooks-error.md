# Debug Session: sidebar-hooks-error

## Metadata
- Status: [OPEN]
- Session ID: `sidebar-hooks-error`
- Started At: 2026-07-01
- Symptom: 打开 `http://localhost:5173/` 时，`SidebarFileTree` 抛出 `Rendered fewer hooks than expected`

## User Symptom
- 前端服务必须使用 `5173`
- 页面加载后 React Error Boundary 捕获到 `SidebarFileTree` 运行时错误
- 错误信息提示组件内部 hooks 调用顺序不稳定，通常由条件分支或提前 return 导致

## Falsifiable Hypotheses
1. `SidebarFileTree` 内部在某个条件分支前后调用 hooks，导致某次 render 少调用了一个或多个 hooks。
2. `SidebarFileTree` 调用的自定义 hook 内部存在条件式 hooks，表面看组件正常，但实际在 hook 展开后顺序不稳定。
3. 某个最近改动引入了 `return null` / `return ...` 的早退路径，绕过了后续 hooks。
4. 组件根据 props 或 store 状态切换不同渲染模式，其中一种模式少走了一段 hooks 代码。
5. React Fast Refresh 热更新导致旧状态与新代码不一致，硬刷新后若仍复现，则可排除纯热更新问题。

## Instrumentation Plan
- 先静态检查 `SidebarFileTree` 及其直接调用的自定义 hooks，找出 hooks 声明与早退路径。
- 如果静态定位不够明确，再在组件入口和关键分支加最小化埋点，记录 render 路径和条件值。
- 修复后重新在 `5173` 验证，并对比修复前后的渲染路径。

## Evidence Log
- Pending
