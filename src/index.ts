// Stacks Agent Protocol (ERC-8004 inspired + x402 + sBTC)
// Agent registry, reputation, and orchestration for Stacks
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Bindings, RegisterAgentRequest, DiscoveryQuery, OrchestrationRequest } from './types';
import {
  registerAgent, getAgent, getReputation, discoverAgents,
  listCapabilities, getLeaderboard, verifySignature
} from './registry';
import { orchestrate, findBestAgent, getAgentTasks } from './orchestrator';

const HIRO_API = 'https://api.hiro.so';

// Payment config - sBTC only
const PAYMENT_ADDRESS = 'SPKH9AWG0ENZ87J1X0PBD4HETP22G8W22AFNVF8K'
const PRICING = {
  orchestration: 100, // 100 sats (~$0.10) for orchestration
  register: 50, // 50 sats (~$0.05) for agent registration
};

// sBTC contract
const SBTC_CONTRACT = {
  address: 'SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9',
  name: 'token-sbtc',
};

// Legacy CONTRACT constant for compatibility
const CONTRACT = {
  address: PAYMENT_ADDRESS,
  name: 'sbtc-payment',
  orchestrationPrice: PRICING.orchestration,
  orchestrationPriceSbtc: PRICING.orchestration,
  registerPrice: PRICING.register,
  registerPriceSbtc: PRICING.register,
};

type PaymentTokenType = 'STX' | 'sBTC';

function getPaymentTokenType(c: any): PaymentTokenType {
  const queryToken = c.req.query('tokenType');
  const headerToken = c.req.header('X-PAYMENT-TOKEN-TYPE');
  const tokenStr = (headerToken || queryToken || 'STX').toUpperCase();
  return tokenStr === 'SBTC' ? 'sBTC' : 'STX';
}

const app = new Hono<{ Bindings: Bindings }>();

app.use('*', cors());

// ============================================
// Public Endpoints (Free)
// ============================================

// Health check & protocol info
app.get('/', (c) => {
  return c.json({
    name: 'stx402-agents',
    description: 'Stacks Agent Protocol - ERC-8004 inspired registry with x402 payments',
    version: '1.0.0',
    protocol: {
      identity: 'Agent registration with Stacks address ownership',
      reputation: 'On-chain payment verification builds reputation',
      validation: 'Task records with request/response hashes',
    },
    payment_tokens: ['STX', 'sBTC'],
    endpoints: {
      free: [
        'GET / - Protocol info',
        'GET /agents - List agents (paginated)',
        'GET /agents/:id - Get agent details',
        'GET /agents/:id/reputation - Get agent reputation',
        'GET /agents/:id/tasks - Get agent task history',
        'GET /discover - Discover agents by capability',
        'GET /capabilities - List all capabilities',
        'GET /leaderboard - Top rated agents',
      ],
      x402_discovery: [
        'GET /register - x402 discovery for agent registration',
        'GET /orchestrate - x402 discovery for orchestration',
      ],
      paid: [
        'POST /register - Register new agent (x402 payment required)',
        'POST /orchestrate - Execute multi-agent task chain (x402 payment required)',
      ],
    },
    inspired_by: {
      'ERC-8004': 'Trustless Agents standard for agent identity, reputation, validation',
      'x402': 'HTTP 402 payment protocol for agent-to-agent micropayments',
      'sBTC': 'Bitcoin on Stacks for cross-chain value transfer',
    },
  });
});

// List all agents
app.get('/agents', async (c) => {
  const limit = parseInt(c.req.query('limit') || '20');
  const offset = parseInt(c.req.query('offset') || '0');

  const agents = await discoverAgents(c.env.DB, { limit: limit + offset });
  const paged = agents.slice(offset, offset + limit);

  return c.json({
    agents: paged,
    total: agents.length,
    limit,
    offset,
  });
});

// Get agent by ID
app.get('/agents/:id', async (c) => {
  const id = c.req.param('id');
  const agent = await getAgent(c.env.DB, id);

  if (!agent) {
    return c.json({ error: 'Agent not found' }, 404);
  }

  const reputation = await getReputation(c.env.DB, id);

  return c.json({ agent, reputation });
});

// Get agent reputation
app.get('/agents/:id/reputation', async (c) => {
  const id = c.req.param('id');
  const reputation = await getReputation(c.env.DB, id);

  if (!reputation) {
    return c.json({ error: 'Agent not found' }, 404);
  }

  return c.json(reputation);
});

// Get agent task history
app.get('/agents/:id/tasks', async (c) => {
  const id = c.req.param('id');
  const limit = parseInt(c.req.query('limit') || '50');
  const tasks = await getAgentTasks(c.env.DB, id, limit);

  return c.json({ tasks });
});

// Discover agents by capability
app.get('/discover', async (c) => {
  const query: DiscoveryQuery = {
    capability: c.req.query('capability'),
    payment_token: c.req.query('token') as 'STX' | 'sBTC' | undefined,
    min_rating: c.req.query('min_rating') ? parseInt(c.req.query('min_rating')!) : undefined,
    limit: parseInt(c.req.query('limit') || '20'),
  };

  const agents = await discoverAgents(c.env.DB, query);

  return c.json({
    query,
    agents,
    count: agents.length,
  });
});

// List all capabilities
app.get('/capabilities', async (c) => {
  const capabilities = await listCapabilities(c.env.DB);
  return c.json({ capabilities });
});

// Leaderboard
app.get('/leaderboard', async (c) => {
  const limit = parseInt(c.req.query('limit') || '10');
  const leaderboard = await getLeaderboard(c.env.DB, limit);

  return c.json({
    leaderboard: leaderboard.map((entry, i) => ({
      rank: i + 1,
      ...entry,
    })),
  });
});

// ============================================
// x402 Discovery Endpoints
// ============================================

// x402 discovery for /register endpoint
app.get('/register', (c) => {
  return c.json({
    x402Version: 1,
    name: 'x402 Agents Registry',
    accepts: [{
      scheme: 'exact',
      network: 'stacks',
      maxAmountRequired: PRICING.register.toString(),
      resource: '/register',
      description: 'Register an AI agent with the x402 agent registry',
      mimeType: 'application/json',
      payTo: PAYMENT_ADDRESS,
      maxTimeoutSeconds: 300,
      asset: 'sBTC',
      extra: {
        tokenContract: SBTC_CONTRACT,
      },
      outputSchema: {
        input: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Human-readable agent name' },
            endpoint: { type: 'string', description: 'Base URL for agent API' },
            capabilities: { type: 'array', items: { type: 'string' }, description: 'List of agent capabilities' },
            payment_address: { type: 'string', description: 'Stacks address for receiving payments' },
            payment_tokens: { type: 'array', items: { type: 'string', enum: ['STX', 'sBTC'] }, description: 'Accepted payment tokens' },
            metadata: { type: 'object', description: 'Additional agent metadata' },
            signature: { type: 'string', description: 'Signed message proving ownership' },
          },
          required: ['name', 'endpoint', 'capabilities', 'payment_address', 'signature'],
        },
        output: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            message: { type: 'string' },
            agent: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                owner: { type: 'string' },
                endpoint: { type: 'string' },
                capabilities: { type: 'array', items: { type: 'string' } },
                payment_address: { type: 'string' },
                payment_tokens: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
    }],
  });
});

// x402 discovery for /orchestrate endpoint
app.get('/orchestrate', (c) => {
  return c.json({
    x402Version: 1,
    name: 'x402 Agent Orchestration',
    accepts: [{
      scheme: 'exact',
      network: 'stacks',
      maxAmountRequired: PRICING.orchestration.toString(),
      resource: '/orchestrate',
      description: 'Execute multi-agent task chains with automatic agent discovery and routing',
      mimeType: 'application/json',
      payTo: PAYMENT_ADDRESS,
      maxTimeoutSeconds: 300,
      asset: 'sBTC',
      extra: {
        tokenContract: SBTC_CONTRACT,
      },
      outputSchema: {
        input: {
          type: 'object',
          properties: {
            tasks: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  capability: { type: 'string', description: 'Required capability for this task' },
                  input: { type: 'object', description: 'Input data for the task' },
                  max_payment: { type: 'number', description: 'Maximum payment in satoshis' },
                },
                required: ['capability', 'input'],
              },
              description: 'List of tasks to execute',
            },
            strategy: {
              type: 'string',
              enum: ['sequential', 'parallel', 'best_agent'],
              description: 'Execution strategy',
            },
          },
          required: ['tasks'],
        },
        output: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            orchestration: {
              type: 'object',
              properties: {
                strategy: { type: 'string' },
                tasks_requested: { type: 'number' },
                tasks_completed: { type: 'number' },
              },
            },
            results: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  capability: { type: 'string' },
                  agent_id: { type: 'string' },
                  success: { type: 'boolean' },
                  response: { type: 'object' },
                  time_ms: { type: 'number' },
                },
              },
            },
            total_time_ms: { type: 'number' },
            caller: { type: 'string' },
          },
        },
      },
    }],
  });
});

// ============================================
// Paid Endpoints (x402)
// ============================================

// Shared registration handler
async function handleRegistration(c: any) {
  const paymentTxid = c.req.header('X-Payment');

  if (!paymentTxid) {
    return paymentRequired(c, '/register', CONTRACT.registerPrice, CONTRACT.registerPriceSbtc);
  }

  const verification = await verifyPayment(paymentTxid);
  if (!verification.valid) {
    return c.json({
      error: 'Payment verification failed',
      details: verification.error,
    }, 403);
  }

  const body = await c.req.json() as RegisterAgentRequest;

  // Validate required fields
  if (!body.name || !body.endpoint || !body.capabilities?.length || !body.payment_address) {
    return c.json({
      error: 'Missing required fields',
      required: ['name', 'endpoint', 'capabilities', 'payment_address', 'signature'],
    }, 400);
  }

  // Signature verification (simplified for MVP)
  if (!body.signature) {
    return c.json({
      error: 'Signature required to prove ownership',
      message_to_sign: `Register agent: ${body.name} at ${body.endpoint}`,
    }, 400);
  }

  try {
    const agent = await registerAgent(c.env.DB, body, verification.sender!);

    return c.json({
      success: true,
      message: 'Agent registered successfully',
      agent,
    }, 201);
  } catch (error) {
    return c.json({
      error: 'Registration failed',
      details: String(error),
    }, 500);
  }
}

// x402 Payment Required response - sBTC only
function paymentRequired(c: any, resource: string, _priceStx: number, priceSbtc: number) {
  const nonce = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  return c.json({
    error: 'Payment Required',
    code: 'PAYMENT_REQUIRED',
    resource,
    nonce,
    expiresAt,
    network: 'mainnet',
    maxAmountRequired: priceSbtc.toString(),
    payTo: PAYMENT_ADDRESS,
    tokenType: 'sBTC',
    tokenContract: SBTC_CONTRACT,
    instructions: [
      '1. Call sBTC transfer with amount to recipient',
      '2. Wait for transaction confirmation',
      '3. Retry request with X-Payment header containing txid',
    ],
  }, 402);
}

// Verify sBTC payment
async function verifyPayment(txid: string): Promise<{ valid: boolean; sender?: string; error?: string }> {
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

    // Accept sBTC transfers
    if (tx.tx_type === 'contract_call') {
      if (!tx.contract_call?.contract_id?.includes('sbtc')) {
        return { valid: false, error: 'Not an sBTC transfer' };
      }
    }

    return { valid: true, sender: tx.sender_address };
  } catch (error) {
    return { valid: false, error: `Verification failed: ${error}` };
  }
}

// Register new agent (requires payment + signature) - x402 canonical endpoint
app.post('/register', handleRegistration);

// Legacy registration endpoint (same handler)
app.post('/agents', handleRegistration);

// Orchestrate multi-agent task
app.post('/orchestrate', async (c) => {
  const paymentTxid = c.req.header('X-Payment');

  if (!paymentTxid) {
    return paymentRequired(c, '/orchestrate', CONTRACT.orchestrationPrice, CONTRACT.orchestrationPriceSbtc);
  }

  const verification = await verifyPayment(paymentTxid);
  if (!verification.valid) {
    return c.json({
      error: 'Payment verification failed',
      details: verification.error,
    }, 403);
  }

  const body = await c.req.json() as OrchestrationRequest;

  if (!body.tasks?.length) {
    return c.json({
      error: 'No tasks provided',
      example: {
        tasks: [
          { capability: 'price_feed', input: { token: 'BTC' } },
          { capability: 'sentiment', input: { token: 'BTC' } },
        ],
        strategy: 'sequential',
      },
    }, 400);
  }

  const result = await orchestrate(
    c.env.DB,
    body,
    paymentTxid,
    verification.sender!
  );

  return c.json({
    success: result.success,
    orchestration: {
      strategy: body.strategy || 'sequential',
      tasks_requested: body.tasks.length,
      tasks_completed: result.results.filter(r => r.success).length,
    },
    results: result.results,
    total_time_ms: result.total_time_ms,
    caller: verification.sender,
  });
});

// Find best agent for capability
app.get('/find/:capability', async (c) => {
  const capability = c.req.param('capability');
  const token = (c.req.query('token') || 'STX') as 'STX' | 'sBTC';

  const agent = await findBestAgent(c.env.DB, capability, token);

  if (!agent) {
    return c.json({
      error: 'No agent found',
      capability,
      suggestion: 'Register an agent with this capability',
    }, 404);
  }

  return c.json({
    capability,
    best_agent: agent,
  });
});

// ============================================
// Seed Data (for demo)
// ============================================

app.post('/seed', async (c) => {
  // Seed some demo agents
  const demoAgents = [
    {
      name: 'Alpha Intelligence',
      endpoint: 'https://stx402-alpha.pbtc21.workers.dev',
      capabilities: ['market_analysis', 'price_aggregation', 'sentiment', 'yield_calculation'],
      payment_address: 'SPP5ZMH9NQDFD2K5CEQZ6P02AP8YPWMQ75TJW20M',
    },
    {
      name: 'STX402 Oracle',
      endpoint: 'https://stx402-endpoint.pbtc21.workers.dev',
      capabilities: ['price_feed', 'sentiment', 'oracle'],
      payment_address: 'SPP5ZMH9NQDFD2K5CEQZ6P02AP8YPWMQ75TJW20M',
    },
    {
      name: 'sBTC Yield Calculator',
      endpoint: 'https://sbtc-yield-x402.pbtc21.workers.dev',
      capabilities: ['yield_calculation', 'risk_assessment'],
      payment_address: 'SPP5ZMH9NQDFD2K5CEQZ6P02AP8YPWMQ75TJW20M',
    },
    {
      name: 'Meme Generator',
      endpoint: 'https://x402-meme.pbtc21.workers.dev',
      capabilities: ['image_generation', 'meme_creation'],
      payment_address: 'SPP5ZMH9NQDFD2K5CEQZ6P02AP8YPWMQ75TJW20M',
    },
  ];

  const results = [];

  for (const demo of demoAgents) {
    try {
      const agent = await registerAgent(c.env.DB, {
        ...demo,
        signature: 'demo-signature',
      }, 'SPP5ZMH9NQDFD2K5CEQZ6P02AP8YPWMQ75TJW20M');
      results.push({ success: true, agent: agent.name, id: agent.id });
    } catch (e) {
      results.push({ success: false, agent: demo.name, error: String(e) });
    }
  }

  return c.json({
    message: 'Demo agents seeded',
    results,
  });
});

export default app;
