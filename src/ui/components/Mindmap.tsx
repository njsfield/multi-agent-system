import ReactFlow, { Background, Controls } from "reactflow";
import type { Node, Edge, NodeProps } from "reactflow";
// @ts-ignore: side-effect import of CSS file
import "reactflow/dist/style.css";
import { useMindmap } from "@/hooks/useMindmap";
import type { MindmapGraph, MindmapNode } from "../../types";

// ---------------------------------------------------------------------------
// Custom node components
// ---------------------------------------------------------------------------

function CenterNode({ data }: NodeProps) {
  return (
    <div
      style={{
        width: 80,
        height: 80,
        borderRadius: "50%",
        background: "#1e1e2e",
        border: "2px solid #6366f1",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "#a5b4fc",
        fontSize: 11,
        fontWeight: 600,
        textAlign: "center",
      }}
    >
      {data?.label ?? "All Topics"}
    </div>
  );
}

function TopicNode({ data }: NodeProps) {
  return (
    <div
      style={{
        padding: "6px 14px",
        borderRadius: 20,
        whiteSpace: "nowrap",
        background: "#0f172a",
        border: `1.5px solid ${data?.color ?? "#6366f1"}`,
        color: data?.color ?? "#a5b4fc",
        fontSize: 12,
        fontWeight: 500,
      }}
    >
      {data?.label ?? ""}
    </div>
  );
}

function FactNode({ data }: NodeProps) {
  return (
    <div
      style={{
        padding: "4px 10px",
        borderRadius: 12,
        whiteSpace: "nowrap",
        background: "#111",
        border: "1px solid #374151",
        color: "#9ca3af",
        fontSize: 11,
      }}
    >
      {data?.label ?? ""}
    </div>
  );
}

function SubtopicNode({ data }: NodeProps) {
  return (
    <div
      style={{
        padding: "5px 12px",
        borderRadius: 14,
        whiteSpace: "nowrap",
        background: "#1f2937",
        border: "1px solid #4b5563",
        color: "#d1d5db",
        fontSize: 11,
        fontWeight: 500,
      }}
    >
      {data?.label ?? ""}
    </div>
  );
}

const nodeTypes = { center: CenterNode, topic: TopicNode, fact: FactNode, subtopic: SubtopicNode };

// ---------------------------------------------------------------------------
// Position computation
// ---------------------------------------------------------------------------

function normalizeNode(n: MindmapNode): MindmapNode {
  return { ...n, data: { ...{ label: "" }, ...n.data } };
}

function buildFlowGraph(graph: MindmapGraph): { nodes: Node[]; edges: Edge[] } {
  const CX = 500,
    CY = 350;
  const normalized = graph.nodes.map(normalizeNode);
  const nodeMap = new Map<string, MindmapNode>(
    normalized.map((n) => [n.id, n]),
  );

  // Map topic id → its child ids (subtopics or facts)
  const topicChildren = new Map<string, string[]>();
  const subtopicFacts = new Map<string, string[]>();

  for (const edge of graph.edges) {
    const sourceNode = nodeMap.get(edge.source);
    if (sourceNode?.type === "topic") {
      const arr = topicChildren.get(edge.source) ?? [];
      arr.push(edge.target);
      topicChildren.set(edge.source, arr);
    } else if (sourceNode?.type === "subtopic") {
      const arr = subtopicFacts.get(edge.source) ?? [];
      arr.push(edge.target);
      subtopicFacts.set(edge.source, arr);
    }
  }

  const rfNodes: Node[] = [];
  const rfEdges: Edge[] = [];

  const topics = normalized.filter((n) => n.type === "topic");

  // Center node
  const center = normalized.find((n) => n.type === "center");
  if (center) {
    rfNodes.push({
      id: center.id,
      type: "center",
      position: { x: CX - 40, y: CY - 40 },
      data: center.data,
    });
  }

  // Topic nodes on a circle, subtopics/facts fanned around each topic
  topics.forEach((topic, i) => {
    const angle = (2 * Math.PI * i) / topics.length - Math.PI / 2;
    const tx = CX + 280 * Math.cos(angle);
    const ty = CY + 280 * Math.sin(angle);
    rfNodes.push({
      id: topic.id,
      type: "topic",
      position: { x: tx - 50, y: ty - 15 },
      data: topic.data,
    });

    const childIds = topicChildren.get(topic.id) ?? [];
    childIds.forEach((childId, ci) => {
      const child = nodeMap.get(childId);
      if (!child) return;

      const childAngle = angle + (ci - (childIds.length - 1) / 2) * 0.35;
      const cx = tx + 185 * Math.cos(childAngle);
      const cy = ty + 185 * Math.sin(childAngle);

      rfNodes.push({
        id: childId,
        type: child.type,
        position: { x: cx - 60, y: cy - 14 },
        data: child.data,
      });

      // If this is a subtopic, fan facts around it
      if (child.type === "subtopic") {
        const factIds = subtopicFacts.get(childId) ?? [];
        factIds.forEach((factId, fi) => {
          const fact = nodeMap.get(factId);
          if (!fact) return;

          const factAngle = childAngle + (fi - (factIds.length - 1) / 2) * 0.25;
          const fx = cx + 120 * Math.cos(factAngle);
          const fy = cy + 120 * Math.sin(factAngle);

          rfNodes.push({
            id: factId,
            type: "fact",
            position: { x: fx - 40, y: fy - 12 },
            data: fact.data,
          });
        });
      }
    });
  });

  // Edges with styling
  for (const edge of graph.edges) {
    const sourceNode = nodeMap.get(edge.source);
    const targetNode = nodeMap.get(edge.target);
    const isTopicEdge = sourceNode?.type === "center";
    const isSubtopicEdge = sourceNode?.type === "subtopic";

    rfEdges.push({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      style: isTopicEdge
        ? { stroke: targetNode?.data?.color ?? "#6366f1", strokeWidth: 2 }
        : isSubtopicEdge
        ? { stroke: "#555765", strokeWidth: 1, strokeDasharray: "2,2" }
        : { stroke: "#374151", strokeWidth: 1, strokeDasharray: "4,4" },
    });
  }

  return { nodes: rfNodes, edges: rfEdges };
}

// ---------------------------------------------------------------------------
// Relative time
// ---------------------------------------------------------------------------

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Mindmap() {
  const { graph, loading, error } = useMindmap();

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading mindmap…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">
          Could not load mindmap: {error}
        </p>
      </div>
    );
  }

  if (graph.nodes.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">
          Not enough conversation history yet — keep chatting!
        </p>
      </div>
    );
  }

  const { nodes, edges } = buildFlowGraph(graph);

  return (
    <div style={{ width: "100%", height: "100%", position: "relative" }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.3}
        maxZoom={2}
      >
        <Background color="#1f1f1f" gap={24} />
        <Controls />
      </ReactFlow>

      {graph.updatedAt && (
        <div
          style={{
            position: "absolute",
            bottom: 12,
            right: 12,
            fontSize: 11,
            color: "#6b7280",
            pointerEvents: "none",
          }}
        >
          Updated {relativeTime(graph.updatedAt)}
        </div>
      )}
    </div>
  );
}
