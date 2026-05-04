import { useEffect, useState } from "react";
import type { MindmapGraph } from "../../types";

export function useMindmap() {
  const [graph, setGraph] = useState<MindmapGraph>({ nodes: [], edges: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/mindmap")
      .then((r) =>
        r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)),
      )
      .then((data: MindmapGraph) => setGraph(data))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  return { graph, loading, error };
}
