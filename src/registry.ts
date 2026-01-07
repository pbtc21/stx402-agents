// Agent Registry - Identity and Reputation management
import type { Agent, Reputation, RegisterAgentRequest, DiscoveryQuery, Bindings } from './types';

const HIRO_API = 'https://api.hiro.so';

// Verify Stacks signature (simplified - in production use @stacks/transactions)
export async function verifySignature(message: string, signature: string, address: string): Promise<boolean> {
  // For MVP, we trust the signature if it's provided
  // In production, verify using @stacks/transactions verifyMessageSignature
  return signature.length > 0 && address.startsWith('SP');
}

// Register a new agent
export async function registerAgent(
  db: D1Database,
  request: RegisterAgentRequest,
  ownerAddress: string
): Promise<Agent> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  const agent: Agent = {
    id,
    name: request.name,
    owner: ownerAddress,
    endpoint: request.endpoint,
    capabilities: request.capabilities,
    payment_address: request.payment_address,
    payment_tokens: request.payment_tokens || ['STX'],
    metadata: request.metadata || {},
    created_at: now,
    updated_at: now,
  };

  // Insert agent
  await db.prepare(`
    INSERT INTO agents (id, name, owner, endpoint, capabilities, payment_address, payment_tokens, metadata, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    agent.id,
    agent.name,
    agent.owner,
    agent.endpoint,
    JSON.stringify(agent.capabilities),
    agent.payment_address,
    JSON.stringify(agent.payment_tokens),
    JSON.stringify(agent.metadata),
    agent.created_at,
    agent.updated_at
  ).run();

  // Initialize reputation
  await db.prepare(`
    INSERT INTO reputation (agent_id, rating, last_activity)
    VALUES (?, 50, ?)
  `).bind(agent.id, now).run();

  return agent;
}

// Get agent by ID
export async function getAgent(db: D1Database, id: string): Promise<Agent | null> {
  const result = await db.prepare('SELECT * FROM agents WHERE id = ?').bind(id).first();
  if (!result) return null;

  return {
    ...result,
    capabilities: JSON.parse(result.capabilities as string),
    payment_tokens: JSON.parse(result.payment_tokens as string),
    metadata: JSON.parse(result.metadata as string),
  } as Agent;
}

// Get agent reputation
export async function getReputation(db: D1Database, agentId: string): Promise<Reputation | null> {
  const result = await db.prepare('SELECT * FROM reputation WHERE agent_id = ?').bind(agentId).first();
  return result as Reputation | null;
}

// Discover agents by capability
export async function discoverAgents(
  db: D1Database,
  query: DiscoveryQuery
): Promise<Array<Agent & { reputation: Reputation }>> {
  let sql = `
    SELECT a.*, r.total_tasks, r.successful_tasks, r.failed_tasks,
           r.total_earned_stx, r.total_earned_sbtc, r.avg_response_time_ms,
           r.rating, r.last_activity
    FROM agents a
    JOIN reputation r ON a.id = r.agent_id
    WHERE 1=1
  `;
  const params: any[] = [];

  if (query.capability) {
    sql += ` AND a.capabilities LIKE ?`;
    params.push(`%"${query.capability}"%`);
  }

  if (query.payment_token) {
    sql += ` AND a.payment_tokens LIKE ?`;
    params.push(`%"${query.payment_token}"%`);
  }

  if (query.min_rating !== undefined) {
    sql += ` AND r.rating >= ?`;
    params.push(query.min_rating);
  }

  sql += ` ORDER BY r.rating DESC, r.successful_tasks DESC`;
  sql += ` LIMIT ?`;
  params.push(query.limit || 20);

  const stmt = db.prepare(sql);
  const results = await stmt.bind(...params).all();

  return (results.results || []).map((row: any) => ({
    id: row.id,
    name: row.name,
    owner: row.owner,
    endpoint: row.endpoint,
    capabilities: JSON.parse(row.capabilities),
    payment_address: row.payment_address,
    payment_tokens: JSON.parse(row.payment_tokens),
    metadata: JSON.parse(row.metadata),
    created_at: row.created_at,
    updated_at: row.updated_at,
    reputation: {
      agent_id: row.id,
      total_tasks: row.total_tasks,
      successful_tasks: row.successful_tasks,
      failed_tasks: row.failed_tasks,
      total_earned_stx: row.total_earned_stx,
      total_earned_sbtc: row.total_earned_sbtc,
      avg_response_time_ms: row.avg_response_time_ms,
      rating: row.rating,
      last_activity: row.last_activity,
    },
  }));
}

// Update reputation after task completion
export async function updateReputation(
  db: D1Database,
  agentId: string,
  success: boolean,
  paymentAmount: number,
  paymentToken: 'STX' | 'sBTC',
  responseTimeMs: number
): Promise<void> {
  const now = new Date().toISOString();

  // Get current reputation
  const current = await getReputation(db, agentId);
  if (!current) return;

  const newTotal = current.total_tasks + 1;
  const newSuccessful = success ? current.successful_tasks + 1 : current.successful_tasks;
  const newFailed = success ? current.failed_tasks : current.failed_tasks + 1;

  // Update earnings
  const newEarnedStx = paymentToken === 'STX'
    ? current.total_earned_stx + paymentAmount
    : current.total_earned_stx;
  const newEarnedSbtc = paymentToken === 'sBTC'
    ? current.total_earned_sbtc + paymentAmount
    : current.total_earned_sbtc;

  // Calculate new average response time
  const newAvgTime = Math.round(
    (current.avg_response_time_ms * current.total_tasks + responseTimeMs) / newTotal
  );

  // Calculate rating (success rate * 100, with task count weight)
  const successRate = newSuccessful / newTotal;
  const taskWeight = Math.min(newTotal / 100, 1); // Max weight at 100 tasks
  const newRating = Math.round(successRate * 100 * (0.5 + 0.5 * taskWeight));

  await db.prepare(`
    UPDATE reputation
    SET total_tasks = ?, successful_tasks = ?, failed_tasks = ?,
        total_earned_stx = ?, total_earned_sbtc = ?,
        avg_response_time_ms = ?, rating = ?, last_activity = ?
    WHERE agent_id = ?
  `).bind(
    newTotal, newSuccessful, newFailed,
    newEarnedStx, newEarnedSbtc,
    newAvgTime, newRating, now,
    agentId
  ).run();
}

// List all capabilities across all agents
export async function listCapabilities(db: D1Database): Promise<string[]> {
  const results = await db.prepare('SELECT DISTINCT capabilities FROM agents').all();
  const allCaps = new Set<string>();

  for (const row of results.results || []) {
    const caps = JSON.parse((row as any).capabilities);
    caps.forEach((c: string) => allCaps.add(c));
  }

  return Array.from(allCaps).sort();
}

// Get leaderboard
export async function getLeaderboard(
  db: D1Database,
  limit: number = 10
): Promise<Array<{ agent: Agent; reputation: Reputation }>> {
  const results = await db.prepare(`
    SELECT a.*, r.total_tasks, r.successful_tasks, r.failed_tasks,
           r.total_earned_stx, r.total_earned_sbtc, r.avg_response_time_ms,
           r.rating, r.last_activity
    FROM agents a
    JOIN reputation r ON a.id = r.agent_id
    ORDER BY r.rating DESC, r.total_earned_stx + r.total_earned_sbtc DESC
    LIMIT ?
  `).bind(limit).all();

  return (results.results || []).map((row: any) => ({
    agent: {
      id: row.id,
      name: row.name,
      owner: row.owner,
      endpoint: row.endpoint,
      capabilities: JSON.parse(row.capabilities),
      payment_address: row.payment_address,
      payment_tokens: JSON.parse(row.payment_tokens),
      metadata: JSON.parse(row.metadata),
      created_at: row.created_at,
      updated_at: row.updated_at,
    },
    reputation: {
      agent_id: row.id,
      total_tasks: row.total_tasks,
      successful_tasks: row.successful_tasks,
      failed_tasks: row.failed_tasks,
      total_earned_stx: row.total_earned_stx,
      total_earned_sbtc: row.total_earned_sbtc,
      avg_response_time_ms: row.avg_response_time_ms,
      rating: row.rating,
      last_activity: row.last_activity,
    },
  }));
}
