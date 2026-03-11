/**
 * Smoke tests for verifySignature in registry.ts.
 *
 * Test vectors are derived from a known private key
 * (0x4242...4201) using @noble/secp256k1 signAsync with
 * the Bitcoin Signed Message prefix + double-SHA256 scheme.
 *
 * Run:  bun test
 */
import { describe, it, expect } from 'bun:test';
import { verifySignature } from './registry';

// ---------------------------------------------------------------------------
// c32encode smoke tests (addresses SlyHarp review point #3: hand-rolled encoder)
// These vectors are cross-checked against the @stacks/transactions reference
// output for the same inputs (version=22, data=20-byte hash160).
//
// The c32encode function is not exported; we validate it indirectly through
// verifySignature → pubkeyToStacksAddress → c32encode.  The KNOWN_ADDRESS
// constant below is the expected output for privKey=0x4242...4201 and has
// been verified against the @stacks/transactions c32address() utility offline.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Fixed test vectors (generated offline from privKey = 0x4242...4201)
// ---------------------------------------------------------------------------

// The Stacks SP address derived from the compressed public key of privKey
const KNOWN_ADDRESS = 'SP2RSVSTWNZ4EQ1V229N96PVNPEGB7SKPT1V201MYB';

const MESSAGE = 'test-agent-registration';

// Native noble format: recovery byte 0/1 (prefix encodes recovery = 1)
const SIG_NATIVE =
  'AU9UuJZ0xCZLmvkS+4sSR70+siZrnIXzok1VFM/+RjhhYyhPxVhO6ILGSW8jU4OZx+kDb2WC1VOuXuNRX9aE/U4=';

// Leather / Xverse compressed style: recovery byte 31/32 (prefix encodes recovery+31)
const SIG_WALLET_31 =
  'IE9UuJZ0xCZLmvkS+4sSR70+siZrnIXzok1VFM/+RjhhYyhPxVhO6ILGSW8jU4OZx+kDb2WC1VOuXuNRX9aE/U4=';

// Ethereum / Bitcoin legacy style: recovery byte 27/28 (prefix encodes recovery+27)
const SIG_WALLET_27 =
  'HE9UuJZ0xCZLmvkS+4sSR70+siZrnIXzok1VFM/+RjhhYyhPxVhO6ILGSW8jU4OZx+kDb2WC1VOuXuNRX9aE/U4=';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('verifySignature', () => {
  it('accepts a native noble 0/1 recovery byte', async () => {
    const ok = await verifySignature(MESSAGE, SIG_NATIVE, KNOWN_ADDRESS);
    expect(ok).toBe(true);
  });

  it('accepts a wallet-style 31/32 recovery byte (Leather / Xverse)', async () => {
    const ok = await verifySignature(MESSAGE, SIG_WALLET_31, KNOWN_ADDRESS);
    expect(ok).toBe(true);
  });

  it('accepts a wallet-style 27/28 recovery byte (Ethereum / Bitcoin legacy)', async () => {
    const ok = await verifySignature(MESSAGE, SIG_WALLET_27, KNOWN_ADDRESS);
    expect(ok).toBe(true);
  });

  it('rejects a signature for a different message', async () => {
    const ok = await verifySignature('different-message', SIG_NATIVE, KNOWN_ADDRESS);
    expect(ok).toBe(false);
  });

  it('rejects a signature for a different address', async () => {
    const wrongAddress = 'SP000000000000000000002Q6VF78';
    const ok = await verifySignature(MESSAGE, SIG_NATIVE, wrongAddress);
    expect(ok).toBe(false);
  });

  it('rejects an empty signature', async () => {
    const ok = await verifySignature(MESSAGE, '', KNOWN_ADDRESS);
    expect(ok).toBe(false);
  });

  it('rejects an empty address', async () => {
    const ok = await verifySignature(MESSAGE, SIG_NATIVE, '');
    expect(ok).toBe(false);
  });

  it('rejects malformed base64', async () => {
    const ok = await verifySignature(MESSAGE, 'not-valid-base64!!!', KNOWN_ADDRESS);
    expect(ok).toBe(false);
  });

  it('rejects a truncated signature (not 65 bytes)', async () => {
    // base64 of 32 zero bytes
    const shortSig = btoa(String.fromCharCode(...new Uint8Array(32)));
    const ok = await verifySignature(MESSAGE, shortSig, KNOWN_ADDRESS);
    expect(ok).toBe(false);
  });

  it('is case-insensitive on the address', async () => {
    const ok = await verifySignature(MESSAGE, SIG_NATIVE, KNOWN_ADDRESS.toLowerCase());
    expect(ok).toBe(true);
  });

  // -------------------------------------------------------------------------
  // c32encode regression guard (SlyHarp review point #3).
  //
  // c32encode is a private function — we test it indirectly through the full
  // address-recovery pipeline.  KNOWN_ADDRESS was cross-verified against the
  // @stacks/transactions c32address(22, hash160) reference for the same
  // compressed public key.  If c32encode regresses, this assertion catches it.
  //
  // Why not depend on @stacks/transactions directly?
  //   This module runs on Cloudflare Workers (edge runtime).  Adding a large
  //   Node.js package for a single utility would balloon the bundle size.
  //   The hand-rolled encoder is ~25 lines and the logic is well-understood.
  //   These tests provide the safety net instead.
  // -------------------------------------------------------------------------
  it('derives an SP-prefix Stacks mainnet address (c32 version 22)', async () => {
    // verifySignature recovers the address from the signature and compares it.
    // A successful match proves c32encode produced a correct SP-prefix address.
    const ok = await verifySignature(MESSAGE, SIG_NATIVE, KNOWN_ADDRESS);
    expect(ok).toBe(true);
    expect(KNOWN_ADDRESS).toMatch(/^SP/);
  });
});
