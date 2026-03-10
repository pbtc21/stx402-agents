// Agent Registry - Identity and Reputation management
import type { Agent, Reputation, RegisterAgentRequest, DiscoveryQuery, Bindings } from './types';
import { recoverPublicKey } from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';

const HIRO_API = 'https://api.hiro.so';

// c32check alphabet used by Stacks addresses
const C32_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Convert a Uint8Array to a hex string without relying on Buffer. */
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Encode bytes to a Stacks c32check address string.
 *  c32check = S + versionChar + base32(version || data || checksum4) */
function c32encode(version: number, data: Uint8Array): string {
  // checksum = first 4 bytes of SHA256(SHA256(version || data))
  const versionedData = new Uint8Array(1 + data.length);
  versionedData[0] = version;
  versionedData.set(data, 1);
  const checksum = sha256(sha256(versionedData)).slice(0, 4);

  // payload = version(1) || data(20) || checksum(4)  →  25 bytes total
  const payload = new Uint8Array(1 + data.length + 4);
  payload[0] = version;
  payload.set(data, 1);
  payload.set(checksum, 1 + data.length);

  // Encode payload as a BigInt then convert to base-32 using the c32 alphabet
  let num = BigInt('0x' + bytesToHex(payload));
  const digits: number[] = [];
  while (num > 0n) {
    digits.unshift(Number(num % 32n));
    num = num / 32n;
  }

  const versionChar = C32_ALPHABET[version];
  const body = digits.map(d => C32_ALPHABET[d]).join('');
  return `S${versionChar}${body}`;
}

/** Derive a Stacks mainnet single-sig (SP-prefix) address from a compressed public key.
 *  Version 22 (0x16) → SP-prefix. */
function pubkeyToStacksAddress(pubkeyBytes: Uint8Array): string {
  const hash160 = ripemd160(sha256(pubkeyBytes));
  return c32encode(22, hash160);
}

/** Hash a message using the Bitcoin Signed Message prefix, then double-SHA256.
 *  Stacks wallets (Leather/Xverse) use this same scheme via @stacks/transactions. */
function hashStructuredMessage(message: string): Uint8Array {
  const prefix = '\x18Bitcoin Signed Message:\n';
  const messageBytes = new TextEncoder().encode(message);
  const prefixBytes = new TextEncoder().encode(prefix);

  // Compact-size varint encoding of message length
  const lenBytes: number[] = [];
  let len = messageBytes.length;
  while (len >= 0x80) {
    lenBytes.push((len & 0x7f) | 0x80);
    len >>= 7;
  }
  lenBytes.push(len);

  const buf = new Uint8Array(prefixBytes.length + lenBytes.length + messageBytes.length);
  buf.set(prefixBytes, 0);
  buf.set(lenBytes, prefixBytes.length);
  buf.set(messageBytes, prefixBytes.length + lenBytes.length);

  return sha256(sha256(buf));
}

/**
 * Verify a Stacks message signature cryptographically.
 *
 * The signature must be a base64-encoded 65-byte recoverable ECDSA signature:
 *   byte[0]      = raw recovery flag from wallet (may be 0/1, 27/28, or 31/32)
 *   bytes[1..64] = compact signature (r || s, 32 bytes each)
 *
 * This is the format produced by @stacks/transactions signMessage() and the
 * Leather / Xverse wallet signing APIs. Wallets typically emit:
 *   27/28 = uncompressed-style recovery flag (Bitcoin legacy)
 *   31/32 = compressed-style recovery flag (Stacks / Leather)
 *   0/1   = raw recovery bit (noble/secp256k1 native)
 *
 * Verification steps:
 *   1. Build the double-SHA256 hash of the Bitcoin-prefixed message.
 *   2. Normalise the recovery flag to 0/1 (noble/secp256k1 v2+ requirement).
 *   3. Recover the secp256k1 public key using compact sig (64 bytes) + recovery.
 *   4. Derive the Stacks SP/SM address from the recovered compressed public key.
 *   5. Compare against the caller's claimed address.
 *
 * @param message   The exact plaintext that was signed.
 * @param signature Base64-encoded 65-byte recoverable Stacks signature.
 * @param address   The claimed Stacks (SP/SM) address that produced the signature.
 * @returns true only if cryptographic verification succeeds and addresses match.
 */
export async function verifySignature(message: string, signature: string, address: string): Promise<boolean> {
  if (!signature || !address) return false;

  try {
    // Decode base64 → 65 bytes: [rawRecovery(1)] + [r(32)] + [s(32)]
    const sigBytes = Uint8Array.from(atob(signature), c => c.charCodeAt(0));
    if (sigBytes.length !== 65) return false;

    const msgHash = hashStructuredMessage(message);

    // Normalise the recovery flag:
    //   27/28 → 0/1  (Ethereum / Bitcoin-legacy uncompressed style)
    //   31/32 → 0/1  (Stacks / Leather compressed style)
    //   0/1   → 0/1  (noble native — pass through)
    const rawFlag = sigBytes[0];
    const recovery = rawFlag >= 27 ? (rawFlag - 27) % 2 : rawFlag % 2;

    // Extract the compact 64-byte sig (r || s) and prepend the normalised
    // recovery byte so noble/secp256k1 v3 can parse it as 'recovered' format.
    const compactSig = sigBytes.subarray(1); // 64 bytes: r || s
    const recoveredSig = new Uint8Array(65);
    recoveredSig[0] = recovery;
    recoveredSig.set(compactSig, 1);

    // @noble/secp256k1 v3 API (installed: ^3.0.0):
    //   recoverPublicKey(signature, message, opts)
    //   - signature: 65-byte 'recovered' format [recovery(0/1)] + [r(32)] + [s(32)]
    //   - message:   pre-computed hash bytes (prehash: false skips the internal sha256)
    //
    // NOTE: This differs from the v2 API which was recoverPublicKey(msgHash, sig, recovery).
    // v3 always expects the 'recovered' 65-byte format; the recovery id is embedded in
    // byte[0] rather than passed as a separate argument.
    const pubkeyBytes = recoverPublicKey(recoveredSig, msgHash, { prehash: false });

    // Derive Stacks address from the recovered compressed public key.
    // NOTE: c32encode is a hand-rolled implementation. If @stacks/transactions
    // becomes available in this edge runtime, prefer its c32checkEncode() for
    // a battle-tested reference implementation.
    const recoveredAddress = pubkeyToStacksAddress(pubkeyBytes);

    // Case-insensitive compare (c32 produces uppercase; be defensive)
    return recoveredAddress.toUpperCase() === address.toUpperCase();
  } catch {
    // Reject on any crypto error: malformed base64, invalid point, wrong length, etc.
    return false;
  }
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
