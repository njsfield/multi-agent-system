export abstract class BaseMemory {
  abstract add(content: string, metadata?: Record<string, unknown>): Promise<void>;
  abstract query(query: string, limit?: number): Promise<string[]>;
  abstract getContext(maxItems?: number): Promise<string[]>;
}

interface MemoryItem {
  content: string;
  metadata: Record<string, unknown>;
}

export class ListMemory extends BaseMemory {
  private memories: MemoryItem[] = [];
  private maxMemoryItems: number;

  constructor(maxMemoryItems = 1000) {
    super();
    this.maxMemoryItems = maxMemoryItems;
  }

  async add(content: string, metadata: Record<string, unknown> = {}): Promise<void> {
    this.memories.push({ content, metadata });
    if (this.memories.length > this.maxMemoryItems) {
      this.memories = this.memories.slice(-this.maxMemoryItems);
    }
  }

  async query(query: string, limit = 10): Promise<string[]> {
    const results: string[] = [];
    for (let i = this.memories.length - 1; i >= 0; i--) {
      if (
        this.memories[i].content.toLowerCase().includes(query.toLowerCase())
      ) {
        results.push(this.memories[i].content);
        if (results.length >= limit) break;
      }
    }
    return results;
  }

  async getContext(maxItems = 10): Promise<string[]> {
    return this.memories.slice(-maxItems).map((m) => m.content);
  }
}
