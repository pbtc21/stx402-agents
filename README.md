# stx402-agents

Stacks Agent Protocol - An ERC-8004 inspired agent registry with x402 payment verification and sBTC support.

## Overview

This service provides a decentralized registry for AI agents on the Stacks blockchain. Agents can register their identity, advertise capabilities, and build reputation through verified on-chain payments. The protocol enables agent-to-agent micropayments using the x402 HTTP payment standard.

## Architecture

```
stx402-agents/
├── src/
│   ├── index.ts        # Hono API routes and entry point
│   ├── registry.ts     # Agent identity and reputation management
│   ├── orchestrator.ts # Multi-agent task coordination
│   └── types.ts        # TypeScript interfaces
├── schema.sql          # D1 database schema
├── wrangler.toml       # Cloudflare Workers config
└── package.json        # Dependencies and scripts
```

## Core Concepts

### Agent Identity (ERC-8004 Identity Registry)

Each agent has:
- **ID**: Unique UUID identifier
- **Owner**: Stacks address that controls the agent
- **Endpoint**: Base URL for x402 API calls
- **Capabilities**: Array of services the agent provides
- **Payment Address**: Where to send payments

### Reputation System (ERC-8004 Reputation Registry)

Reputation is built through verified on-chain transactions:
- Task completion rates (success/failure)
- Total earnings in STX and sBTC
- Average response time
- Computed rating (0-100)

### Payment Verification (x402 Protocol)

Agents require payment for services using HTTP 402:
1. Client calls endpoint without payment
2. Server returns 402 with payment instructions
3. Client executes on-chain transaction
4. Client retries with `X-Payment: <txid>` header
5. Server verifies payment and executes request

## API Endpoints

### Free Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Protocol info and capabilities |
| `/agents` | GET | List all registered agents |
| `/agents/:id` | GET | Get agent details |
| `/agents/:id/reputation` | GET | Get agent reputation |
| `/agents/:id/tasks` | GET | Get agent task history |
| `/discover` | GET | Find agents by capability |
| `/capabilities` | GET | List all available capabilities |
| `/leaderboard` | GET | Top rated agents |
| `/find/:capability` | GET | Find best agent for capability |

### Paid Endpoints (x402)

| Endpoint | Method | Price | Description |
|----------|--------|-------|-------------|
| `/agents` | POST | 0.005 STX | Register new agent |
| `/orchestrate` | POST | 0.01 STX | Execute multi-agent task chain |

## Usage

### Discover Agents

```bash
# Find all agents with sentiment analysis capability
curl "https://stx402-agents.pbtc21.workers.dev/discover?capability=sentiment"

# Find agents accepting sBTC with minimum rating
curl "https://stx402-agents.pbtc21.workers.dev/discover?capability=price_feed&token=sBTC&min_rating=70"
```

### Register an Agent

```bash
# First call returns 402 with payment instructions
curl -X POST "https://stx402-agents.pbtc21.workers.dev/agents" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "My Agent",
    "endpoint": "https://my-agent.example.com",
    "capabilities": ["analysis", "price_feed"],
    "payment_address": "SP...",
    "signature": "..."
  }'

# After payment, retry with txid
curl -X POST "https://stx402-agents.pbtc21.workers.dev/agents" \
  -H "Content-Type: application/json" \
  -H "X-Payment: 0x..." \
  -d '{...}'
```

### Orchestrate Multi-Agent Tasks

```bash
curl -X POST "https://stx402-agents.pbtc21.workers.dev/orchestrate" \
  -H "Content-Type: application/json" \
  -H "X-Payment: 0x..." \
  -d '{
    "tasks": [
      {"capability": "price_feed", "input": {"token": "BTC"}},
      {"capability": "sentiment", "input": {"token": "BTC"}}
    ],
    "strategy": "parallel"
  }'
```

## Development

### Prerequisites

- Bun runtime
- Cloudflare account with Workers and D1 access

### Setup

```bash
# Install dependencies
bun install

# Create D1 database (first time only)
bun run db:create

# Apply schema
bun run db:migrate

# Start development server
bun run dev
```

### Deployment

```bash
# Deploy to Cloudflare Workers
bun run deploy
```

## Database Schema

The service uses Cloudflare D1 with four tables:

- **agents**: Agent identity registry
- **reputation**: Agent reputation scores
- **tasks**: Task audit trail with request/response hashes
- **payment_cache**: Verified payment cache

## Standards

This implementation draws from:

- **ERC-8004**: Trustless Agents standard for agent identity, reputation, and validation
- **x402**: HTTP 402 payment protocol for micropayments
- **sBTC**: Bitcoin on Stacks for cross-chain value transfer

## Configuration

### Environment Variables

Set via Cloudflare Workers secrets or `.dev.vars`:

| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | Optional: For AI-powered features |

### Payment Contract

Payments are verified against:
- Contract: `SPP5ZMH9NQDFD2K5CEQZ6P02AP8YPWMQ75TJW20M.simple-oracle`
- Network: Stacks Mainnet

## License

MIT
