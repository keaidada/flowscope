/**
 * AiChatPanel — right-side AI assistant panel.
 *
 * Features:
 * - Chat with DeepSeek/Ollama via backend SSE proxy
 * - Auto-injects current SQL/file context
 * - Streaming responses (逐字渲染)
 * - Collapsible
 */

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Sparkles, Send, Loader2, X, Settings, Copy, Check,
  Bot, AlertCircle, ChevronDown, Plus, Database, FileCode2,
  Wrench, Search,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuRadioGroup, DropdownMenuRadioItem,
} from '@/components/ui/dropdown-menu';

interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface ModelConfig {
  provider: string;
  api_key: string;
  model: string;
  endpoint: string;
  system_prompt: string;
  temperature: number;
  output_template?: string;
}

// Predefined output format templates appended to the system prompt.
// Each is a standalone instruction block telling the model how to format
// its reply. Selecting one persists it on the model config.
interface OutputTemplate {
  id: string;
  label: string;
  description: string;
  content: string;
}

const OUTPUT_TEMPLATES: OutputTemplate[] = [
  {
    id: 'none',
    label: '无（默认自由输出）',
    description: '不附加模板，按系统提示词自由回答',
    content: '',
  },
  {
    id: 'script-analysis',
    label: '脚本分析报告',
    description: '结构化输出：指标清单表格 + 明细说明 + 优化建议',
    content: `请按照以下模板结构输出脚本分析报告，使用规范的 Markdown 格式（标题 # 后必须有空格，列表 - 后必须有空格，表格每行用 | 分隔且表头后需有分隔行）：
# 一、指标清单
（用表格列出：序号 | 指标名称 | 字段名 | 计算逻辑 | 数据来源）
# 二、指标明细说明
（对每个指标用 ### 小节说明：定义 / 计算方式 / 数据来源 / 过滤条件）
# 三、指标间关系
（列出指标之间的计算公式关系）
# 四、数据清洗规则
（说明写入前过滤哪些无效数据）`,
  },
  {
    id: 'sql-explain',
    label: 'SQL 解释',
    description: '逐段解释 SQL：表、字段、逻辑、执行流程',
    content: `请按照以下模板结构解释 SQL 脚本，使用规范的 Markdown 格式：
# 一、脚本概览
（用一段话概括脚本目的）
# 二、源表与目标表
（用表格列出：表名 | 角色（源/目标） | 用途）
# 三、核心逻辑拆解
（用 ### 小节逐段解释关键 SQL：临时表、CTE、join 逻辑）
# 四、关键字段说明
（用表格列出：字段名 | 含义 | 来源）`,
  },
  {
    id: 'optimize-suggest',
    label: '优化建议',
    description: '定位瓶颈并给出可落地的优化方案',
    content: `请按照以下模板结构给出 SQL 优化建议，使用规范的 Markdown 格式：
# 一、性能问题清单
（用表格列出：序号 | 问题描述 | 严重程度 | 影响）
# 二、优化建议
（每条用 ### 小节：问题 / 优化方案 / 修改前后的 SQL 对比（用代码块））
# 三、优化总结
（总结收益：预计性能提升、可读性改善等）`,
  },
  {
    id: 'lineage-analysis',
    label: '血缘分析',
    description: '梳理表与字段的血缘链路',
    content: `请按照以下模板结构梳理 SQL 血缘关系，使用规范的 Markdown 格式：
# 一、血缘概览
（用文字或 mermaid 图描述数据流向）
# 二、表级血缘
（用表格列出：上游表 | 下游表 | 关联关系）
# 三、字段级血缘
（用表格列出：目标字段 | 来源表 | 来源字段 | 转换逻辑）
# 四、风险与建议
（标注断链、孤儿字段等风险点）`,
  },
];

interface AiChatPanelProps {
  open: boolean;
  onClose: () => void;
  projectId: string | null;
  currentFilePath?: string;
  currentSql?: string;
}

function apiBase(): string {
  if (typeof window !== 'undefined') {
    const port = (window as unknown as { __FSCOPE_PORT__?: number }).__FSCOPE_PORT__;
    if (port) return `http://localhost:${port}`;
  }
  return '';
}

export function AiChatPanel({ open, onClose, projectId, currentFilePath, currentSql }: AiChatPanelProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [draftKey, setDraftKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<ModelConfig | null>(null);
  const [activeKey, setActiveKey] = useState('ollama|qwen2.5:3b');
  const [models, setModels] = useState<Record<string, ModelConfig>>({});
  const [configSaved, setConfigSaved] = useState(false);
  const [panelWidth, setPanelWidth] = useState<number>(() => {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('ai-panel-width') : null;
    const n = saved ? Number(saved) : 400;
    return n >= 320 && n <= 720 ? n : 400;
  });
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const widthRef = useRef(panelWidth);
  useEffect(() => { widthRef.current = panelWidth; }, [panelWidth]);

  // Chat history recall: ArrowUp/ArrowDown walks previously sent user messages.
  const historyRef = useRef<string[]>([]);
  const historyIdxRef = useRef(-1); // -1 = not recalling; 0..len-1 = current position
  const historyRestoringRef = useRef(false);

  // Draggable left-edge resize: width is unconstrained so long tables can expand.
  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    const startX = e.clientX;
    const startW = widthRef.current;
    const onMove = (ev: MouseEvent) => {
      const dx = startX - ev.clientX;
      const next = Math.min(720, Math.max(320, startW + dx));
      widthRef.current = next;
      setPanelWidth(next);
    };
    const onUp = () => {
      draggingRef.current = false;
      localStorage.setItem('ai-panel-width', String(widthRef.current));
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // Preset models for quick switching (each keeps its own config).
  const PRESETS = [
    { label: 'Ollama · qwen2.5:3b', provider: 'ollama', model: 'qwen2.5:3b', endpoint: 'http://localhost:11434', api_key: 'ollama' },
    { label: 'DeepSeek · deepseek-chat', provider: 'deepseek', model: 'deepseek-chat', endpoint: 'https://api.deepseek.com', api_key: '' },
    { label: 'DeepSeek · deepseek-reasoner', provider: 'deepseek', model: 'deepseek-reasoner', endpoint: 'https://api.deepseek.com', api_key: '' },
  ] as const;

  const DEFAULT_SYSTEM_PROMPT = '你是一个 SQL 血缘分析和数据治理助手。帮助用户理解 SQL 脚本的血缘关系、表和字段的来源，提供 SQL 解释和优化建议。回答时不要提及你的模型名称、模型来源、供应商或公司信息，也不要自我暴露身份，专注于回答用户的问题本身。';

  const modelKey = (p: string, m: string) => `${p}|${m}`;

  // Get a model's effective config: preset defaults merged with any saved config.
  const modelConfig = useCallback((provider: string, model: string): ModelConfig => {
    const saved = models[modelKey(provider, model)];
    const preset = PRESETS.find(p => p.provider === provider && p.model === model);
    return {
      provider,
      api_key: saved?.api_key ?? preset?.api_key ?? '',
      model,
      endpoint: saved?.endpoint ?? preset?.endpoint ?? '',
      system_prompt: saved?.system_prompt ?? DEFAULT_SYSTEM_PROMPT,
      temperature: saved?.temperature ?? 0.7,
      output_template: saved?.output_template ?? 'none',
    };
  }, [models]);

  // Effective config for the active model.
  const activeConfig = useMemo(() => {
    const [provider, model] = activeKey.split('|');
    return modelConfig(provider, model);
  }, [activeKey, modelConfig]);

  // Compose the final system prompt = base prompt + selected output template.
  const composeSystemPrompt = useCallback((cfg: ModelConfig): string => {
    const tpl = OUTPUT_TEMPLATES.find(t => t.id === cfg.output_template);
    if (tpl && tpl.content) {
      return `${cfg.system_prompt}\n\n${tpl.content}`;
    }
    return cfg.system_prompt;
  }, []);

  // Load config on mount / project change.
  useEffect(() => {
    if (!projectId) return;
    console.log('[ai] GET config for project=', projectId);
    fetch(`${apiBase()}/api/ai/config?project_id=${projectId}`)
      .then(r => r.json())
      .then(c => {
        console.log('[ai] GET config response active=', JSON.stringify(c.active), 'models=', c.models?.length ?? 0);
        const m = c.models || [];
        const map: Record<string, ModelConfig> = {};
        for (const item of m) {
          map[modelKey(item.provider, item.model)] = {
            provider: item.provider,
            api_key: item.api_key || '',
            model: item.model,
            endpoint: item.endpoint || '',
            system_prompt: item.system_prompt || DEFAULT_SYSTEM_PROMPT,
            temperature: item.temperature ?? 0.7,
            output_template: item.output_template || 'none',
          };
        }
        setModels(map);
        if (c.active?.provider && c.active?.model) {
          setActiveKey(modelKey(c.active.provider, c.active.model));
        }
      })
      .catch(() => {});
  }, [projectId]);

  const saveConfig = async (cfg?: ModelConfig): Promise<boolean> => {
    if (!projectId) {
      console.warn('[ai] saveConfig skipped: no projectId');
      return false;
    }
    console.log('[ai] saveConfig called, projectId=', projectId, 'cfg=', cfg ? `${cfg.provider}/${cfg.model}` : 'null(active)');
    try {
      const c = cfg ?? activeConfig;
      // Compose base prompt + template into the persisted system_prompt.
      const body = {
        project_id: projectId,
        ...c,
        system_prompt: composeSystemPrompt(c),
      };
      console.log('[ai] saveConfig PUT body=', JSON.stringify(body));
      const res = await fetch(`${apiBase()}/api/ai/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      console.log('[ai] saveConfig response status=', res.status);
      if (!res.ok) {
        const text = await res.text();
        console.log('[ai] saveConfig FAILED:', res.status, text);
        return false;
      }
      if (cfg) {
        // Save just this model's config.
        setModels(prev => ({ ...prev, [modelKey(cfg.provider, cfg.model)]: cfg }));
      } else {
        // Saving settings dialog: model stays active, but merge into map.
        setModels(prev => ({ ...prev, [modelKey(activeConfig.provider, activeConfig.model)]: activeConfig }));
      }
      return true;
    } catch (e) {
      console.error('[ai] saveConfig threw:', e);
      return false;
    }
  };

  // Quick model switch: only change the active pointer, keep each model's own config.
  const quickSwitchModel = (provider: string, model: string) => {
    console.log('[ai] quickSwitchModel', provider, model, 'projectId=', projectId);
    setActiveKey(modelKey(provider, model));
    const cfg = modelConfig(provider, model);
    // Send the full config so the backend has this model's own endpoint/api_key.
    // If it was never saved, this persists the preset defaults for it.
    fetch(`${apiBase()}/api/ai/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: projectId,
        ...cfg,
        system_prompt: composeSystemPrompt(cfg),
      }),
    }).then(r => console.log('[ai] quickSwitch response', r.status)).catch(e => console.error('[ai] quickSwitch failed', e));
  };

  // Auto-scroll to bottom on new messages.
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const clearChat = () => setMessages([]);
  const hasMessages = messages.length > 0;

  // Capability cards shown on the empty-state welcome screen.
  const CAPABILITIES = [
    { icon: FileCode2, title: '解释脚本', desc: '理解这段 SQL 在做什么', prompt: '帮我解释当前脚本的功能' },
    { icon: Database, title: '分析血缘', desc: '梳理表与字段的来源', prompt: '当前脚本读了哪些表？' },
    { icon: Wrench, title: '优化建议', desc: '找出可优化的地方', prompt: '给当前脚本一些优化建议' },
    { icon: Search, title: '排查问题', desc: '定位字段或表的去向', prompt: '帮我梳理这个脚本的血缘关系' },
  ];

  const handleSend = useCallback(async () => {
    if (!input.trim() || loading || !projectId) return;

    const userMsg: Message = { role: 'user', content: input.trim() };
    historyRef.current.push(userMsg.content);
    historyIdxRef.current = -1;
    const newMessages = [...messages.filter(m => m.role !== 'system'), userMsg];
    setMessages([...newMessages, { role: 'assistant', content: '' }]);
    setInput('');
    setLoading(true);
    setError('');

    try {
      // Resolve the current script's SQL context. The panel receives
      // currentSql from the project store, which is often meta-only
      // (content ''), so fall back to fetching the file content directly.
      let contextSql = currentSql;
      if (!contextSql && currentFilePath && projectId) {
        try {
          const { loadFileContent } = await import('@/lib/file-storage');
          const r = await loadFileContent(projectId, currentFilePath);
          contextSql = r?.content ?? '';
        } catch (e) {
          console.error('[ai] load context sql failed', e);
          contextSql = '';
        }
      }
      const context = contextSql && currentFilePath
        ? { file_path: currentFilePath, sql: contextSql }
        : undefined;

      const res = await fetch(`${apiBase()}/api/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: projectId,
          messages: newMessages.map(m => ({ role: m.role, content: m.content })),
          context,
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        setError(`请求失败: ${res.status} ${text}`);
        setMessages(prev => {
          const copy = [...prev];
          copy[copy.length - 1] = { role: 'assistant', content: `❌ 请求失败: ${res.status}` };
          return copy;
        });
        return;
      }

      // Read SSE stream (robust: accumulate buffer across chunks so
      // multi-line SSE events are parsed correctly).
      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let fullContent = '';
      let sseBuffer = '';

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          sseBuffer += decoder.decode(value, { stream: true });

          // Process complete SSE events (terminated by blank line \n\n).
          let sepIdx;
          while ((sepIdx = sseBuffer.indexOf('\n\n')) !== -1) {
            const event = sseBuffer.slice(0, sepIdx);
            sseBuffer = sseBuffer.slice(sepIdx + 2);
            // Collect all data: lines and rejoin with \n (axum splits
            // embedded newlines in content into separate data: lines, so
            // rejoining restores the original newlines).
            const dataParts: string[] = [];
            for (const line of event.split('\n')) {
              if (line.startsWith('data:')) dataParts.push(line.slice(5).trim());
            }
            const data = dataParts.join('\n');
            if (data === '[DONE]') { sseBuffer = ''; break; }
            if (data.startsWith('[ERROR]')) {
              setError(data.slice(7));
              fullContent += `\n\n❌ ${data.slice(7)}`;
              sseBuffer = '';
              break;
            }
            if (data) {
              fullContent += data;
              setMessages(prev => {
                const copy = [...prev];
                copy[copy.length - 1] = { role: 'assistant', content: fullContent };
                return copy;
              });
            }
          }
        }
        // Flush any remaining partial event.
        if (sseBuffer.startsWith('data:')) {
          const data = sseBuffer.slice(5).trim();
          if (data && data !== '[DONE]') {
            fullContent += data;
            setMessages(prev => {
              const copy = [...prev];
              copy[copy.length - 1] = { role: 'assistant', content: fullContent };
              return copy;
            });
          }
        }
      }

      // If no content was received, show a fallback.
      if (!fullContent) {
        setMessages(prev => {
          const copy = [...prev];
          copy[copy.length - 1] = { role: 'assistant', content: '(AI 未返回内容，请检查 API Key 配置)' };
          return copy;
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setMessages(prev => {
        const copy = [...prev];
        copy[copy.length - 1] = { role: 'assistant', content: `❌ 错误: ${msg}` };
        return copy;
      });
    } finally {
      setLoading(false);
    }
  }, [input, loading, projectId, messages, currentSql, currentFilePath]);

  if (!open) return null;

  return (
    <div className="relative flex flex-col h-full border-l bg-background shrink-0" style={{ width: `${panelWidth}px` }}>
      {/* Left-edge drag handle */}
      <div
        onMouseDown={startDrag}
        className="absolute -left-[2px] top-0 bottom-0 w-[5px] cursor-col-resize z-20 hover:bg-primary/30 transition-colors group/aihandle"
        title="拖拽调整宽度"
      />
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b shrink-0">
        <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-gradient-to-br from-primary to-indigo-400 shadow-sm">
          <Sparkles className="h-4 w-4 text-primary-foreground" />
        </div>
        <span className="font-semibold text-[13px]">AI 对话</span>
        {hasMessages && (
          <button onClick={clearChat} className="p-1.5 rounded-md hover:bg-accent text-muted-foreground" title="新对话">
            <Plus className="h-4 w-4" />
          </button>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          {configSaved && <span className="text-[10px] text-green-600 flex items-center gap-0.5 mr-1"><Check className="h-3 w-3" /></span>}
          <button onClick={() => {
            const [p, m] = activeKey.split('|');
            setDraftKey(activeKey);
            setDraft(modelConfig(p, m));
            setShowSettings(true);
          }} className="p-1.5 rounded-md hover:bg-accent text-muted-foreground" title="设置">
            <Settings className="h-4 w-4" />
          </button>
          <button onClick={onClose} className="p-1.5 rounded-md hover:bg-accent text-muted-foreground" title="收起">
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Body: welcome screen or messages */}
      {!hasMessages ? (
        <div className="flex-1 overflow-auto px-6 py-8">
          <div className="flex flex-col items-center text-center">
            <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-primary to-indigo-400 flex items-center justify-center shadow-lg mb-5">
              <Sparkles className="h-8 w-8 text-primary-foreground" />
            </div>
            <h2 className="text-xl font-bold">你好，我是 Capybara AI</h2>
            <p className="text-xs text-muted-foreground mt-2 mb-6 max-w-[260px] leading-relaxed">
              SQL 血缘分析助手，帮你理解脚本、梳理字段来源、优化查询。
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            {CAPABILITIES.map(cap => (
              <button
                key={cap.title}
                onClick={() => setInput(cap.prompt)}
                disabled={loading || !projectId}
                className="flex flex-col items-start gap-1 p-3 rounded-xl border bg-card hover:border-primary/50 hover:shadow-sm transition-all text-left group"
              >
                <cap.icon className="h-4 w-4 text-primary mb-0.5" />
                <span className="text-xs font-medium">{cap.title}</span>
                <span className="text-[10px] text-muted-foreground leading-snug">{cap.desc}</span>
              </button>
            ))}
          </div>
          {!projectId && (
            <p className="text-[10px] text-muted-foreground text-center mt-4">
              请先打开一个项目，才能开始对话。
            </p>
          )}
        </div>
      ) : (
        <div className="flex-1 overflow-auto px-4 py-4 space-y-4">
          {messages.map((msg, i) => (
            <MessageBubble key={i} message={msg} loading={loading && i === messages.length - 1} />
          ))}
          <div ref={messagesEndRef} />
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="px-4 py-1.5 border-t bg-destructive/5 text-[11px] text-destructive flex items-center gap-1">
          <AlertCircle className="h-3 w-3 shrink-0" />
          <span className="truncate">{error}</span>
        </div>
      )}

      {/* Input */}
      <div className="border-t p-3 shrink-0 bg-muted/20">
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={e => {
              if (!historyRestoringRef.current) historyIdxRef.current = -1;
              historyRestoringRef.current = false;
              setInput(e.target.value);
            }}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
                return;
              }
              // ArrowUp: recall previous user message (start of line only).
              if (e.key === 'ArrowUp' && !e.shiftKey && e.currentTarget.selectionStart === 0) {
                e.preventDefault();
                const hist = historyRef.current;
                if (hist.length === 0) return;
                if (historyIdxRef.current === -1) {
                  historyIdxRef.current = hist.length - 1;
                } else if (historyIdxRef.current > 0) {
                  historyIdxRef.current -= 1;
                } else {
                  return;
                }
                historyRestoringRef.current = true;
                setInput(hist[historyIdxRef.current]);
                return;
              }
              // ArrowDown: forward through history, clear input at the end.
              if (e.key === 'ArrowDown' && !e.shiftKey
                && e.currentTarget.selectionStart === e.currentTarget.value.length) {
                e.preventDefault();
                const hist = historyRef.current;
                if (historyIdxRef.current === -1) return;
                historyRestoringRef.current = true;
                if (historyIdxRef.current < hist.length - 1) {
                  historyIdxRef.current += 1;
                  setInput(hist[historyIdxRef.current]);
                } else {
                  historyIdxRef.current = -1;
                  setInput('');
                }
              }
            }}
            placeholder="问问 FlowScope AI…"
            rows={2}
            className="flex-1 text-xs px-3 py-2 rounded-xl border bg-background focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/60 resize-none leading-relaxed"
            disabled={loading}
          />
          <Button
            size="icon"
            className="h-9 w-9 rounded-xl shrink-0 bg-primary hover:bg-primary/90 text-primary-foreground"
            onClick={handleSend}
            disabled={!input.trim() || loading || !projectId}
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>
        {/* Footer row: model switch + hint */}
        <div className="flex items-center mt-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="flex items-center gap-1 px-2 py-1 rounded-lg border bg-background hover:bg-accent transition-colors text-[11px] text-foreground">
                <Bot className="h-3 w-3 text-primary" />
                <span className="max-w-[150px] truncate">
                  {(() => {
                    const [p, m] = activeKey.split('|');
                    return PRESETS.find(x => x.provider === p && x.model === m)?.label ?? `${p}/${m}`;
                  })()}
                </span>
                <ChevronDown className="h-3 w-3 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64">
              <DropdownMenuLabel>选择模型</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuRadioGroup
                value={activeKey}
                onValueChange={val => {
                  const [p, m] = val.split('|');
                  quickSwitchModel(p, m);
                }}
              >
                {PRESETS.map(p => (
                  <DropdownMenuRadioItem key={`${p.provider}|${p.model}`} value={`${p.provider}|${p.model}`}>
                    {p.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <span className="ml-auto text-[10px] text-muted-foreground">
            Enter 发送 · Shift+Enter 换行 · ↑/↓ 回溯
          </span>
        </div>
      </div>

      {/* Settings Dialog: edit ANY model's config, independent of active model */}
      <Dialog open={showSettings} onOpenChange={setShowSettings}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>AI 设置</DialogTitle>
            <p className="text-[11px] text-muted-foreground">
              每个模型可单独配置，切换模型时互不影响。
            </p>
          </DialogHeader>

          <div className="space-y-3">
            {/* Model selector tabs */}
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map(p => {
                const key = modelKey(p.provider, p.model);
                const isActive = key === activeKey;
                const isEditing = key === draftKey;
                return (
                  <button
                    key={key}
                    onClick={() => {
                      setDraftKey(key);
                      setDraft(modelConfig(p.provider, p.model));
                    }}
                    className={cn(
                      'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs transition-colors',
                      isEditing
                        ? 'border-primary/60 bg-primary/10 text-foreground'
                        : isActive
                          ? 'border-primary/40 bg-muted text-foreground'
                          : 'border-border bg-background text-muted-foreground hover:bg-accent'
                    )}
                  >
                    {isActive && <Bot className="h-3 w-3 text-primary" />}
                    <span>{p.label}</span>
                    {isActive && !isEditing && <span className="text-[9px] px-1 rounded bg-primary/10 text-primary">当前</span>}
                  </button>
                );
              })}
            </div>

            {/* Edit form for the selected draft model */}
            {draftKey && draft && (
              <div className="space-y-2.5 rounded-xl border p-3">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-medium">配置：{draft.provider} / {draft.model}</span>
                  {draftKey === activeKey && <span className="text-[10px] text-primary">当前使用中</span>}
                </div>
                {draft.provider === 'deepseek' && (
                  <div className="flex items-center gap-2">
                    <label className="w-20 text-[11px] text-muted-foreground shrink-0">API Key</label>
                    <input type="password" value={draft.api_key} onChange={e => setDraft({ ...draft, api_key: e.target.value })}
                      placeholder="sk-..." className="flex-1 text-xs px-2 py-1 rounded border bg-transparent focus:outline-none focus:ring-1 focus:ring-ring" />
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <label className="w-20 text-[11px] text-muted-foreground shrink-0">Endpoint</label>
                  <input value={draft.endpoint} onChange={e => setDraft({ ...draft, endpoint: e.target.value })}
                    className="flex-1 text-xs px-2 py-1 rounded border bg-transparent focus:outline-none focus:ring-1 focus:ring-ring" />
                </div>
                <div className="flex items-start gap-2">
                  <label className="w-20 text-[11px] text-muted-foreground shrink-0 pt-1">System</label>
                  <textarea value={draft.system_prompt} onChange={e => setDraft({ ...draft, system_prompt: e.target.value })}
                    rows={3} className="flex-1 text-[11px] px-2 py-1 rounded border bg-transparent focus:outline-none focus:ring-1 focus:ring-ring resize-none"
                    placeholder="AI 系统提示词" />
                </div>
                <div className="flex items-center gap-2">
                  <label className="w-20 text-[11px] text-muted-foreground shrink-0">温度</label>
                  <input type="number" step="0.1" min="0" max="1" value={draft.temperature}
                    onChange={e => setDraft({ ...draft, temperature: Number(e.target.value) })}
                    className="w-20 text-xs px-2 py-1 rounded border bg-transparent focus:outline-none focus:ring-1 focus:ring-ring" />
                </div>
                <div className="flex items-start gap-2">
                  <label className="w-20 text-[11px] text-muted-foreground shrink-0 pt-1">输出模板</label>
                  <div className="flex-1 space-y-1">
                    <select
                      value={draft.output_template ?? 'none'}
                      onChange={e => setDraft({ ...draft, output_template: e.target.value })}
                      className="w-full text-xs px-2 py-1 rounded border bg-transparent focus:outline-none focus:ring-1 focus:ring-ring"
                    >
                      {OUTPUT_TEMPLATES.map(t => (
                        <option key={t.id} value={t.id}>{t.label}</option>
                      ))}
                    </select>
                    {(() => {
                      const tpl = OUTPUT_TEMPLATES.find(t => t.id === draft.output_template);
                      return tpl && tpl.content ? (
                        <p className="text-[10px] text-muted-foreground leading-snug">{tpl.description}</p>
                      ) : (
                        <p className="text-[10px] text-muted-foreground leading-snug">选择模板后，AI 回复将按该格式输出；未选择则自由输出。</p>
                      );
                    })()}
                  </div>
                </div>
                <div className="flex justify-end gap-2 pt-1">
                  <Button size="sm" variant="outline" className="text-xs" onClick={() => setDraftKey(null)}>取消</Button>
                  <Button size="sm" className="text-xs" onClick={async () => {
                    console.log('[ai] 保存该模型 clicked, draft=', draft);
                    if (!draft) { toast.error('没有可保存的模型配置'); return; }
                    const ok = await saveConfig(draft);
                    if (ok) {
                      toast.success(`已保存 ${draft.provider}/${draft.model} 的配置`);
                      setDraftKey(null);
                      setConfigSaved(true);
                      setTimeout(() => setConfigSaved(false), 1500);
                    } else {
                      toast.error(`保存 ${draft.provider}/${draft.model} 失败，请检查后端服务`);
                    }
                  }}>
                    <Check className="h-3 w-3 mr-1" /> 保存该模型
                  </Button>
                </div>
              </div>
            )}
          </div>

          <DialogFooter className="text-[10px] text-muted-foreground">
            提示：保存的配置只作用于对应模型；切换模型使用各自保存的配置。
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// Normalize LLM-generated markdown that often omits the space after
// ATX heading markers and list bullets (e.g. `###1.标题` / `-**定义**`),
// which GFM otherwise treats as plain text. Fenced code blocks are skipped.
function normalizeMarkdown(src: string): string {
  if (!src) return src;
  const lines = src.split('\n');
  let inFence = false;
  const out: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (/^```/.test(t) || /^~~~/.test(t)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    let fixed = line;
    // heading: ###text -> ### text
    fixed = fixed.replace(/^(#{1,6})(?=[^\s#])/, '$1 ');
    // bullet: -text / *text / +text -> - text
    fixed = fixed.replace(/^([-*+])(?=[^\s])/, '$1 ');
    // table row missing leading pipe spacing (e.g. `|序号|...`) is fine;
    // but a heading line that ends with | could merge with a table — handled by heading fix.
    out.push(fixed);
  }
  return out.join('\n');
}

function MessageBubble({ message, loading }: { message: Message; loading?: boolean }) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system';
  const [copied, setCopied] = useState(false);

  if (isSystem) return null;

  const handleCopy = async () => {
    await navigator.clipboard.writeText(message.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  // User message: right-aligned blue bubble (Trae style).
  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-primary text-primary-foreground px-3.5 py-2 text-xs leading-relaxed whitespace-pre-wrap break-words shadow-sm">
          {message.content}
        </div>
      </div>
    );
  }

  // AI message: left-aligned, no bubble background (Trae style).
  return (
    <div className="flex gap-2.5 group">
      <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-primary to-indigo-400 flex items-center justify-center shrink-0 shadow-sm mt-0.5">
        <Bot className="h-4 w-4 text-primary-foreground" />
      </div>
      <div className="flex-1 min-w-0 text-xs leading-relaxed text-foreground">
        {loading && !message.content ? (
          <div className="flex items-center gap-2 text-muted-foreground py-2">
            <span className="flex gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50 animate-bounce" />
              <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:0.15s]" />
              <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:0.3s]" />
            </span>
            <span className="text-[11px]">思考中…</span>
          </div>
        ) : (
          <>
            <div className="markdown-body">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  h1: ({ children }) => <h1 className="text-sm font-semibold my-1.5">{children}</h1>,
                  h2: ({ children }) => <h2 className="text-sm font-semibold my-1.5">{children}</h2>,
                  h3: ({ children }) => <h3 className="text-xs font-semibold my-1.5">{children}</h3>,
                  h4: ({ children }) => <h4 className="text-xs font-semibold my-1.5">{children}</h4>,
                  p: ({ children }) => <p className="my-1 leading-relaxed">{children}</p>,
                  ul: ({ children }) => <ul className="list-disc pl-4 my-1 space-y-0.5">{children}</ul>,
                  ol: ({ children }) => <ol className="list-decimal pl-4 my-1 space-y-0.5">{children}</ol>,
                  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
                  a: ({ children, href }) => (
                    <a href={href} target="_blank" rel="noreferrer" className="text-primary underline">{children}</a>
                  ),
                  code: ({ className: _className, children }) => (
                    <code className="bg-muted px-1 py-0.5 rounded text-[10px] font-mono">{children}</code>
                  ),
                  pre: ({ children }) => (
                    <pre className="bg-muted rounded p-2 my-1.5 overflow-x-auto text-[10px] font-mono leading-relaxed">{children}</pre>
                  ),
                  table: ({ children }) => (
                    <div className="overflow-x-auto my-1.5">
                      <table className="border-collapse text-[11px] w-full min-w-fit">{children}</table>
                    </div>
                  ),
                  th: ({ children }) => <th className="border border-border px-1.5 py-0.5 text-left font-semibold bg-muted/40">{children}</th>,
                  td: ({ children }) => <td className="border border-border px-1.5 py-0.5">{children}</td>,
                blockquote: ({ children }) => (
                  <blockquote className="border-l-2 border-muted pl-2 my-1 text-muted-foreground">{children}</blockquote>
                ),
                hr: () => <hr className="my-2 border-border" />,
              }}
            >
              {normalizeMarkdown(message.content)}
            </ReactMarkdown>
            </div>
            {/* Copy button below the message */}
            <div className="flex justify-end mt-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                onClick={handleCopy}
                className="flex items-center gap-1 px-1.5 py-0.5 rounded-md hover:bg-accent transition-colors text-muted-foreground"
                title="复制"
              >
                {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
                <span className="text-[10px]">{copied ? '已复制' : '复制'}</span>
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

