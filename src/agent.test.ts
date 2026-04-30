import { describe, it, expect, vi } from 'vitest';
import { Agent } from './agent';
import type { BaseChatClient } from './client';
import { BaseMemory } from './memory';

class TestMemory extends BaseMemory {
  getContextResult: string[] = [];
  queryResult: string[]      = [];
  addedItems: Array<{ content: string; metadata: Record<string, unknown> }> = [];

  async add(content: string, metadata: Record<string, unknown> = {}): Promise<void> {
    this.addedItems.push({ content, metadata });
  }
  async query(_q: string, _limit?: number): Promise<string[]>     { return this.queryResult; }
  async getContext(_max?: number):           Promise<string[]>     { return this.getContextResult; }
}

function makeClient(responseContent = 'test response'): BaseChatClient {
  return {
    create: vi.fn().mockResolvedValue({
      message: {
        role:      'assistant' as const,
        content:   responseContent,
        source:    'agent',
        timestamp: new Date(),
      },
    }),
    createStream: vi.fn(),
  } as unknown as BaseChatClient;
}

describe('Agent with memory', () => {
  it('injects recent context and relevant past context into system message', async () => {
    const memory = new TestMemory();
    memory.getContextResult = ['user: what is 2+2?', 'assistant: 4'];
    memory.queryResult      = ['assistant: I helped with math before'];

    const client = makeClient();
    const agent  = new Agent('test-agent', 'Be helpful.', client, [], memory);

    await agent.run('another question');

    const [messages] = (client.create as ReturnType<typeof vi.fn>).mock.calls[0] as [Array<{ content: string }>];
    const systemContent = messages[0]!.content;
    expect(systemContent).toContain('Recent conversation:');
    expect(systemContent).toContain('user: what is 2+2?');
    expect(systemContent).toContain('Relevant past context:');
    expect(systemContent).toContain('I helped with math before');
  });

  it('persists user and assistant messages after a completed turn', async () => {
    const memory = new TestMemory();
    const client = makeClient('sunny and warm');
    const agent  = new Agent('weather-agent', 'Be helpful.', client, [], memory);

    await agent.run('what is the weather?');

    expect(memory.addedItems).toHaveLength(2);
    expect(memory.addedItems[0]).toEqual({
      content:  'what is the weather?',
      metadata: { role: 'user', source: 'user' },
    });
    expect(memory.addedItems[1]).toEqual({
      content:  'sunny and warm',
      metadata: { role: 'assistant', source: 'weather-agent' },
    });
  });

  it('runs without error when memory is undefined', async () => {
    const client = makeClient();
    const agent  = new Agent('test-agent', 'Be helpful.', client);
    await expect(agent.run('question')).resolves.not.toThrow();
  });
});
