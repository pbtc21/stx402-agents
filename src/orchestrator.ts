// Agent Orchestrator - Chain multiple agents for complex tasks
import type { Agent, Reputation, OrchestrationRequest, TaskRecord, Bindings } from './types';
import { discoverAgents, updateReputation } from './registry';

const HIRO_API = 'https://api.hiro.so';

// Contract for x402 payments
const CONTRACT = {
  address: 'SPP5ZMH9NQDFD2K5CEQZ6P02AP8YPWMQ75TJW20M',
  name: 'simple-oracle',
};

// Verify x402 payment
async function verifyPayment(txid: string): Promise<{ valid: boolean; sender?: string; amount?: number; error?: string }> {
  try {
    const normalizedTxid = txid.startsWith('0x') ? txid : `0x${txid}`;
    const response = await fetch(`${HIRO_API}/extended/v1/tx/${normalizedTxid}`);

    if (!response.ok) {
      return { valid: false, error: 'Transaction not found' };
    }

    const tx = await response.json() as any;

    if (tx.tx_status !== 'success') {
      return { valid: false, error: `Transaction status: ${tx.tx_status}` };
    }

    if (tx.tx_type !== 'contract_call') {
      return { valid: false, error: 'Not a contract call' };
    }

    return {
      valid: true,
      sender: tx.sender_address,
      amount: parseInt(tx.contract_call?.function_args?.[0]?.repr?.replace('u', '') || '0'),
    };
  } catch (error) {
    return { valid: false, error: `Verification failed: ${error}` };
  }
}

// Call an agent's x402 endpoint
async function callAgent(
  agent: Agent,
  taskType: string,
  input: any,
  paymentTxid: string
): Promise<{ success: boolean; data?: any; error?: string; responseTimeMs: number }> {
  const startTime = Date.now();

  try {
    const url = `${agent.endpoint}/${taskType}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Payment': paymentTxid,
      },
      body: JSON.stringify(input),
    });

    const responseTimeMs = Date.now() - startTime;

    if (!response.ok) {
      const error = await response.text();
      return { success: false, error, responseTimeMs };
    }

    const data = await response.json();
    return { success: true, data, responseTimeMs };
  } catch (error) {
    return {
      success: false,
      error: `Agent call failed: ${error}`,
      responseTimeMs: Date.now() - startTime,
    };
  }
}

// Find best agent for a capability
export async function findBestAgent(
  db: D1Database,
  capability: string,
  paymentToken: 'STX' | 'sBTC' = 'STX'
): Promise<(Agent & { reputation: Reputation }) | null> {
  const agents = await discoverAgents(db, {
    capability,
    payment_token: paymentToken,
    min_rating: 0,
    limit: 1,
  });

  return agents[0] || null;
}

// Execute orchestrated multi-agent task
export async function orchestrate(
  db: D1Database,
  request: OrchestrationRequest,
  paymentTxid: string,
  callerAddress: string
): Promise<{
  success: boolean;
  results: Array<{
    capability: string;
    agent_id: string;
    agent_name: string;
    success: boolean;
    data?: any;
    error?: string;
  }>;
  total_time_ms: number;
}> {
  const startTime = Date.now();
  const results: Array<{
    capability: string;
    agent_id: string;
    agent_name: string;
    success: boolean;
    data?: any;
    error?: string;
  }> = [];

  // Verify the orchestration payment first
  const paymentVerification = await verifyPayment(paymentTxid);
  if (!paymentVerification.valid) {
    return {
      success: false,
      results: [{
        capability: 'orchestration',
        agent_id: 'orchestrator',
        agent_name: 'Orchestrator',
        success: false,
        error: paymentVerification.error,
      }],
      total_time_ms: Date.now() - startTime,
    };
  }

  if (request.strategy === 'sequential') {
    // Execute tasks one after another, passing output to next input
    let previousOutput: any = null;

    for (const task of request.tasks) {
      const agent = await findBestAgent(db, task.capability);

      if (!agent) {
        results.push({
          capability: task.capability,
          agent_id: 'none',
          agent_name: 'No agent found',
          success: false,
          error: `No agent found for capability: ${task.capability}`,
        });
        continue;
      }

      // Merge previous output into input
      const input = previousOutput
        ? { ...task.input, previous_result: previousOutput }
        : task.input;

      // For sequential tasks, we use the original payment
      // In production, you'd need separate payments per agent
      const result = await callAgent(agent, task.capability, input, paymentTxid);

      // Update reputation
      await updateReputation(
        db,
        agent.id,
        result.success,
        task.max_payment || 1000,
        'STX',
        result.responseTimeMs
      );

      // Record task
      await recordTask(db, {
        id: crypto.randomUUID(),
        requester_agent_id: null,
        provider_agent_id: agent.id,
        task_type: task.capability,
        payment_txid: paymentTxid,
        payment_amount: task.max_payment || 1000,
        payment_token: 'STX',
        status: result.success ? 'completed' : 'failed',
        request_hash: hashObject(input),
        response_hash: result.data ? hashObject(result.data) : null,
        started_at: new Date(startTime).toISOString(),
        completed_at: new Date().toISOString(),
        error: result.error || null,
      });

      results.push({
        capability: task.capability,
        agent_id: agent.id,
        agent_name: agent.name,
        success: result.success,
        data: result.data,
        error: result.error,
      });

      if (result.success) {
        previousOutput = result.data;
      }
    }
  } else if (request.strategy === 'parallel') {
    // Execute all tasks in parallel
    const taskPromises = request.tasks.map(async (task) => {
      const agent = await findBestAgent(db, task.capability);

      if (!agent) {
        return {
          capability: task.capability,
          agent_id: 'none',
          agent_name: 'No agent found',
          success: false,
          error: `No agent found for capability: ${task.capability}`,
        };
      }

      const result = await callAgent(agent, task.capability, task.input, paymentTxid);

      await updateReputation(
        db,
        agent.id,
        result.success,
        task.max_payment || 1000,
        'STX',
        result.responseTimeMs
      );

      return {
        capability: task.capability,
        agent_id: agent.id,
        agent_name: agent.name,
        success: result.success,
        data: result.data,
        error: result.error,
      };
    });

    const parallelResults = await Promise.all(taskPromises);
    results.push(...parallelResults);
  } else if (request.strategy === 'best_agent') {
    // Find single best agent that can handle all capabilities
    // (simplified - just handles first capability)
    const task = request.tasks[0];
    if (task) {
      const agent = await findBestAgent(db, task.capability);

      if (agent) {
        const result = await callAgent(agent, task.capability, task.input, paymentTxid);

        await updateReputation(
          db,
          agent.id,
          result.success,
          task.max_payment || 1000,
          'STX',
          result.responseTimeMs
        );

        results.push({
          capability: task.capability,
          agent_id: agent.id,
          agent_name: agent.name,
          success: result.success,
          data: result.data,
          error: result.error,
        });
      }
    }
  }

  return {
    success: results.every(r => r.success),
    results,
    total_time_ms: Date.now() - startTime,
  };
}

// Record a task for audit trail
async function recordTask(db: D1Database, task: TaskRecord): Promise<void> {
  await db.prepare(`
    INSERT INTO tasks (id, requester_agent_id, provider_agent_id, task_type,
                       payment_txid, payment_amount, payment_token, status,
                       request_hash, response_hash, started_at, completed_at, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    task.id,
    task.requester_agent_id,
    task.provider_agent_id,
    task.task_type,
    task.payment_txid,
    task.payment_amount,
    task.payment_token,
    task.status,
    task.request_hash,
    task.response_hash,
    task.started_at,
    task.completed_at,
    task.error
  ).run();
}

// Simple hash function for request/response verification
function hashObject(obj: any): string {
  const str = JSON.stringify(obj);
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString(16);
}

// Get task history for an agent
export async function getAgentTasks(
  db: D1Database,
  agentId: string,
  limit: number = 50
): Promise<TaskRecord[]> {
  const results = await db.prepare(`
    SELECT * FROM tasks
    WHERE provider_agent_id = ? OR requester_agent_id = ?
    ORDER BY started_at DESC
    LIMIT ?
  `).bind(agentId, agentId, limit).all();

  return (results.results || []) as TaskRecord[];
}
