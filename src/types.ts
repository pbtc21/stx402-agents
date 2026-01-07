// Types for Stacks Agent Protocol (ERC-8004 inspired)

// Agent identity - like ERC-8004 Identity Registry
export interface Agent {
  id: string;                    // Unique agent ID (UUID)
  name: string;                  // Human-readable name
  owner: string;                 // Stacks address that owns this agent
  endpoint: string;              // Base URL for x402 calls
  capabilities: string[];        // What this agent can do
  payment_address: string;       // Where to send payments
  payment_tokens: ('STX' | 'sBTC')[]; // Accepted payment tokens
  metadata: Record<string, any>; // Additional agent metadata
  created_at: string;
  updated_at: string;
}

// Agent reputation - like ERC-8004 Reputation Registry
export interface Reputation {
  agent_id: string;
  total_tasks: number;
  successful_tasks: number;
  failed_tasks: number;
  total_earned_stx: number;      // microSTX
  total_earned_sbtc: number;     // satoshis
  avg_response_time_ms: number;
  rating: number;                // 0-100 computed score
  last_activity: string;
}

// Task record - for validation/audit trail
export interface TaskRecord {
  id: string;
  requester_agent_id: string | null;  // null if human caller
  provider_agent_id: string;
  task_type: string;
  payment_txid: string;
  payment_amount: number;
  payment_token: 'STX' | 'sBTC';
  status: 'pending' | 'completed' | 'failed';
  request_hash: string;          // Hash of request for verification
  response_hash: string | null;  // Hash of response
  started_at: string;
  completed_at: string | null;
  error: string | null;
}

// Agent registration request
export interface RegisterAgentRequest {
  name: string;
  endpoint: string;
  capabilities: string[];
  payment_address: string;
  payment_tokens?: ('STX' | 'sBTC')[];
  metadata?: Record<string, any>;
  signature: string;             // Signed message proving ownership
}

// Discovery query
export interface DiscoveryQuery {
  capability?: string;
  payment_token?: 'STX' | 'sBTC';
  min_rating?: number;
  limit?: number;
}

// Orchestration request - chain multiple agents
export interface OrchestrationRequest {
  tasks: Array<{
    capability: string;
    input: any;
    max_payment?: number;
  }>;
  strategy: 'sequential' | 'parallel' | 'best_agent';
}

// x402 payment info
export interface PaymentInfo {
  contract: string;
  function: string;
  price: number;
  token: 'STX' | 'sBTC';
  recipient: string;
}

export type Bindings = {
  DB: D1Database;
  OPENAI_API_KEY?: string;
};
