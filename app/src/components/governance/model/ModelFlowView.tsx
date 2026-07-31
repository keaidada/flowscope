/**
 * ModelFlowView — layered lineage flow visualization using React Flow.
 * Models positioned by layer (ODS → DWD → DWS → ADS), with data flow edges.
 */

import { useMemo, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ReactFlow, Background, Controls, MiniMap, Position,
  type Node, type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { governanceApi, type ModelEntry } from '@/lib/governance-api';

const LAYER_ORDER = ['ODS', 'DWD', 'DWS', 'ADS', 'DIM', 'unknown'];
const LAYER_COLORS: Record<string, string> = {
  ODS: '#f97316', DWD: '#3b82f6', DWS: '#10b981', ADS: '#8b5cf6', DIM: '#6b7280',
  unknown: '#94a3b8',
};
const COLUMN_WIDTH = 280;
const ROW_HEIGHT = 72;

interface TableEdge {
  from_table: string;
  to_table: string;
  script: string;
}

type FlowNode = Node;
type FlowEdge = Edge;

export function ModelFlowView({ projectId }: { projectId: string | null }) {
  const { t } = useTranslation();
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [edges, setEdges] = useState<TableEdge[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!projectId) return;
    setLoading(true);
    Promise.all([
      governanceApi.listModels(new URLSearchParams({ project_id: projectId }).toString()),
      fetch(`/api/db/table-level-edges?projectId=${projectId}`).then(r => r.json()).catch(() => []),
    ]).then(([m, e]) => {
      setModels(m);
      setEdges(Array.isArray(e) ? e : []);
    }).catch(console.error).finally(() => setLoading(false));
  }, [projectId]);

  // Group models by layer and assign positions
  const { nodes: flowNodes, edges: flowEdges, layerX } = useMemo(() => {
    if (models.length === 0) return { nodes: [] as FlowNode[], edges: [] as FlowEdge[], layerX: {} as Record<string, number> };

    // Group by layer
    const groups: Record<string, ModelEntry[]> = {};
    for (const m of models) {
      const layer = m.model_layer || 'unknown';
      (groups[layer] ||= []).push(m);
    }

    // Calculate column positions
    const layerPositions: Record<string, number> = {};
    const layerCounts: Record<string, number> = {};
    let x = 0;
    for (const layer of LAYER_ORDER) {
      if (groups[layer] && groups[layer].length > 0) {
        layerPositions[layer] = x;
        layerCounts[layer] = groups[layer].length;
        x += COLUMN_WIDTH;
      }
    }

    // Build node map for edge lookup
    const nameToId: Record<string, string> = {};
    const nodes: FlowNode[] = [];

    for (const [layer, layerModels] of Object.entries(groups)) {
      layerModels.forEach((m, idx) => {
        const id = `model-${m.id}`;
        nameToId[m.table_name] = id;
        const color = LAYER_COLORS[layer] || LAYER_COLORS.unknown;
        nodes.push({
          id,
          position: { x: layerPositions[layer] || 0, y: idx * ROW_HEIGHT + 40 },
          type: 'default',
          data: { label: m.table_name, layer, modelType: m.model_type },
          style: {
            width: 240,
            padding: '10px 12px',
            border: `2px solid ${color}`,
            borderRadius: 8,
            background: 'var(--background, #fff)',
            fontSize: 13,
            fontFamily: 'monospace',
          },
          sourcePosition: Position.Right,
          targetPosition: Position.Left,
        });
      });
    }

    // Build edges from table_level_edges
    const flowEdges: FlowEdge[] = [];
    const addedPairs = new Set<string>();
    for (const e of edges) {
      const sourceId = nameToId[e.from_table];
      const targetId = nameToId[e.to_table];
      if (sourceId && targetId) {
        const key = `${sourceId}→${targetId}`;
        if (!addedPairs.has(key)) {
          addedPairs.add(key);
          flowEdges.push({
            id: `e-${sourceId}-${targetId}`,
            source: sourceId,
            target: targetId,
            animated: true,
            style: { stroke: '#94a3b8', strokeWidth: 1.5 },
          });
        }
      }
    }

    return { nodes, edges: flowEdges, layerX: layerPositions };
  }, [models, edges]);

  // Layer statistics
  const layerStats = useMemo(() => {
    const stats: Record<string, number> = {};
    for (const m of models) {
      const layer = m.model_layer || 'unknown';
      stats[layer] = (stats[layer] || 0) + 1;
    }
    return stats;
  }, [models]);

  if (!projectId) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        {t('governance.selectProject')}
      </div>
    );
  }

  if (loading) {
    return <div className="flex items-center justify-center h-full text-muted-foreground text-sm">Loading...</div>;
  }

  if (models.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground">
        <p className="text-sm">{t('governance.noModels')}</p>
        <p className="text-xs">{t('governance.autoDiscover')} from the Models tab to populate.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Layer legend */}
      <div className="flex items-center gap-3 px-4 py-1.5 border-b bg-muted/20 shrink-0 overflow-x-auto">
        {LAYER_ORDER.map(layer => {
          if (!layerStats[layer]) return null;
          return (
            <div key={layer} className="flex items-center gap-1.5 text-xs shrink-0">
              <span className="w-2.5 h-2.5 rounded-sm" style={{ background: LAYER_COLORS[layer] }} />
              <span className="font-medium">{layer}</span>
              <span className="text-muted-foreground tabular-nums">{layerStats[layer]}</span>
            </div>
          );
        })}
        <span className="text-xs text-muted-foreground ml-auto">
          {Object.entries(layerX).length} layers · {models.length} models · {flowEdges.length} flows
        </span>
      </div>

      {/* Flow canvas */}
      <div className="flex-1 min-h-0">
        <ReactFlow
          nodes={flowNodes}
          edges={flowEdges}
          fitView
          fitViewOptions={{ padding: 0.3 }}
          attributionPosition="bottom-left"
          minZoom={0.1}
          maxZoom={2}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={true}
        >
          <Background color="#e2e8f0" gap={20} />
          <Controls showInteractive={false} />
          <MiniMap
            nodeColor={(n) => {
              const data = n.data as { layer?: string };
              return LAYER_COLORS[data.layer || 'unknown'] || '#94a3b8';
            }}
            maskColor="rgba(0,0,0,0.1)"
          />
        </ReactFlow>
      </div>
    </div>
  );
}
