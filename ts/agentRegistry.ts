import type { AgentContext } from "./core/context.ts";

export interface AgentInstance {
  pid: number;
  context: AgentContext;
  cwd: string;
  cli: string;
  prompt?: string;
  startTime: number;
  stdoutBuffer: string[]; // Circular buffer, max 1000 lines
}

const MAX_BUFFER_SIZE = 1000;

class AgentRegistry {
  private agents = new Map<number, AgentInstance>();

  /**
   * Register a new agent instance
   */
  register(pid: number, instance: AgentInstance): void {
    this.agents.set(pid, instance);
  }

  /**
   * Unregister an agent instance
   */
  unregister(pid: number): void {
    this.agents.delete(pid);
  }

  /**
   * Get an agent instance by PID
   */
  get(pid: number): AgentInstance | undefined {
    return this.agents.get(pid);
  }

  /**
   * List all registered agents
   */
  list(): AgentInstance[] {
    return Array.from(this.agents.values());
  }

  /**
   * Append stdout data to an agent's buffer (circular buffer)
   */
  appendStdout(pid: number, data: string): void {
    const instance = this.agents.get(pid);
    if (!instance) {
      return;
    }

    // Split by lines and add to buffer
    const lines = data.split('\n');
    instance.stdoutBuffer.push(...lines);

    // Maintain circular buffer size
    if (instance.stdoutBuffer.length > MAX_BUFFER_SIZE) {
      instance.stdoutBuffer = instance.stdoutBuffer.slice(-MAX_BUFFER_SIZE);
    }
  }

  /**
   * Get stdout from an agent's buffer
   */
  getStdout(pid: number, tail?: number): string[] {
    const instance = this.agents.get(pid);
    if (!instance) {
      return [];
    }

    if (tail !== undefined) {
      return instance.stdoutBuffer.slice(-tail);
    }

    return instance.stdoutBuffer;
  }
}

export const globalAgentRegistry = new AgentRegistry();
