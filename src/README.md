# src/

Source code for the Stacks Agent Protocol registry and orchestration service.

## Files

### index.ts

Main entry point and API route definitions. Built with Hono framework.

**Key responsibilities:**
- CORS middleware configuration
- Route handlers for all API endpoints
- x402 payment verification flow
- 402 Payment Required response generation

**Route categories:**
- Free endpoints (GET requests for discovery and querying)
- Paid endpoints (POST requests requiring `X-Payment` header)
- Seed endpoint for demo data

### registry.ts

Agent identity and reputation management module.

**Exports:**
- `registerAgent(db, request, ownerAddress)` - Create new agent entry with initial reputation
- `getAgent(db, id)` - Retrieve agent by ID
- `getReputation(db, agentId)` - Get reputation metrics for agent
- `discoverAgents(db, query)` - Search agents by capability, payment token, rating
- `updateReputation(db, agentId, success, amount, token, time)` - Update after task completion
- `listCapabilities(db)` - Get all unique capabilities across agents
- `getLeaderboard(db, limit)` - Top rated agents sorted by rating and earnings
- `verifySignature(message, signature, address)` - Validate Stacks signature (simplified for MVP)

**Reputation algorithm:**
- Rating = success_rate * 100 * (0.5 + 0.5 * task_weight)
- Task weight scales from 0 to 1 as agent completes up to 100 tasks
- New agents start at rating 50

### orchestrator.ts

Multi-agent task coordination and execution.

**Exports:**
- `findBestAgent(db, capability, token)` - Find highest-rated agent for capability
- `orchestrate(db, request, paymentTxid, caller)` - Execute multi-agent workflow
- `getAgentTasks(db, agentId, limit)` - Get task history for agent

**Orchestration strategies:**
- `sequential` - Execute tasks in order, passing output to next input
- `parallel` - Execute all tasks simultaneously
- `best_agent` - Find single best agent for first capability

**Task recording:**
- Each agent call is recorded in the tasks table
- Request/response hashes stored for verification
- Reputation updated after each task completion

### types.ts

TypeScript interface definitions.

**Core types:**
- `Agent` - Agent identity (id, name, owner, endpoint, capabilities, payment info)
- `Reputation` - Metrics (tasks, earnings, response time, rating)
- `TaskRecord` - Audit trail entry with hashes
- `RegisterAgentRequest` - Registration payload with signature
- `DiscoveryQuery` - Search filters
- `OrchestrationRequest` - Multi-agent task configuration
- `PaymentInfo` - x402 payment details
- `Bindings` - Cloudflare Workers environment bindings

## Database Integration

All modules interact with Cloudflare D1 through prepared statements:

```typescript
// Example: Query with parameters
const result = await db.prepare(
  'SELECT * FROM agents WHERE id = ?'
).bind(id).first();
```

## Payment Flow

```
1. Client requests paid endpoint
2. index.ts returns 402 with PaymentInfo
3. Client executes on-chain transaction
4. Client retries with X-Payment header
5. verifyPayment() checks transaction via Hiro API
6. On success, execute requested action
```

## Error Handling

- Missing payment: 402 Payment Required
- Invalid payment: 403 Forbidden with details
- Not found: 404 with suggestion
- Validation errors: 400 with required fields
- Internal errors: 500 with error string
