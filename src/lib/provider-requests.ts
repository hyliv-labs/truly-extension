import { decodeFunctionData, parseAbi } from 'viem';
/**
 * Pure parsing for the wallet methods Lighter (and any EIP-1193 dapp) sends.
 *
 * Kept out of provider.ts so a bad payload fails here, with no chain read
 * and no approval window, and so the offline check can cover it.
 */

export class ProviderRequestError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = 'ProviderRequestError';
    this.code = code;
  }
}

export interface ParsedTypedData {
  readonly address: string;
  readonly domain: Record<string, unknown>;
  readonly types: Record<string, readonly { name: string; type: string }[]>;
  readonly primaryType: string;
  readonly message: Record<string, unknown>;
  /** What the approval window shows. Not what gets signed. */
  readonly summary: string;
}

const TYPED_METHODS = new Set(['eth_signTypedData_v3', 'eth_signTypedData_v4']);

/**
 * personal_sign is [message, address]. A few callers swap them. A 20-byte
 * message that itself looks like an address is treated as the standard order,
 * because that is what wallets actually send.
 */
export function parsePersonalSign(
  params: readonly unknown[],
  ownerAddress: string,
): { raw: `0x${string}`; address: string } {
  const [first, second] = params;
  const addressLike = (value: unknown): value is string =>
    typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);

  let raw: string | undefined;
  let address: string | undefined;
  if (addressLike(second) && typeof first === 'string') {
    raw = first;
    address = second;
  } else if (addressLike(first) && typeof second === 'string') {
    raw = second;
    address = first;
  }

  if (!raw || !address || !raw.startsWith('0x')) {
    throw new ProviderRequestError(-32602, 'personal_sign is missing a message or an address.');
  }
  if (address.toLowerCase() !== ownerAddress.toLowerCase()) {
    throw new ProviderRequestError(4100, 'Ghosty will only sign for the active owner.');
  }
  return { raw: raw as `0x${string}`, address };
}

/**
 * eth_signTypedData_v3 and v4 carry [address, json]. Some callers swap them.
 * v1 (`eth_signTypedData`) is a different encoding and is refused: guessing
 * would sign something the user did not see.
 */
export function parseTypedDataRequest(
  method: string,
  params: readonly unknown[],
  ownerAddress: string,
): ParsedTypedData {
  if (method === 'eth_signTypedData') {
    throw new ProviderRequestError(
      4200,
      'Ghosty supports eth_signTypedData_v4, not the older eth_signTypedData.',
    );
  }
  if (!TYPED_METHODS.has(method)) {
    throw new ProviderRequestError(4200, `Ghosty does not support ${method}.`);
  }

  const address = params.find(
    (value): value is string => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value),
  );
  const raw = params.find((value) => value !== address);
  if (!address || raw === undefined) {
    throw new ProviderRequestError(-32602, 'Typed data is missing an address or a payload.');
  }
  if (address.toLowerCase() !== ownerAddress.toLowerCase()) {
    throw new ProviderRequestError(4100, 'Ghosty will only sign for the active owner.');
  }

  const parsed = typeof raw === 'string' ? parseJson(raw) : raw;
  if (!parsed || typeof parsed !== 'object') {
    throw new ProviderRequestError(-32602, 'Typed data was not an object.');
  }

  const body = parsed as {
    domain?: Record<string, unknown>;
    types?: Record<string, readonly { name: string; type: string }[]>;
    primaryType?: string;
    message?: Record<string, unknown>;
  };

  if (!body.types || !body.primaryType || !body.message) {
    throw new ProviderRequestError(-32602, 'Typed data is missing types, primaryType, or message.');
  }

  const domain = { ...(body.domain ?? {}) };
  if (typeof domain.chainId === 'string') {
    domain.chainId = Number(domain.chainId);
  }

  // viem builds the domain type itself. Leaving EIP712Domain in `types`
  // makes it throw, and the dapp sees a failure that names neither field.
  const types = { ...body.types };
  delete types.EIP712Domain;

  // Only what is signed is shown, message first. Keys the types do not list
  // are not hashed, so showing them (as the raw JSON did) let a site push the
  // real spender or amount out of view with junk.
  const summary = signedSummary(body.primaryType, types, domain, body.message);

  return {
    address,
    domain,
    types,
    primaryType: body.primaryType,
    message: body.message,
    summary,
  };
}

export interface ParsedTransaction {
  readonly to: `0x${string}`;
  readonly data?: `0x${string}`;
  readonly value: bigint;
  /** Gas limit the site already chose, when it sent one. */
  readonly gas?: bigint;
  readonly summary: string;
}

/** eth_sendTransaction's single parameter. Contract creation is refused. */
export function parseTransactionRequest(
  params: readonly unknown[],
  ownerAddress: string,
): ParsedTransaction {
  const tx = params[0];
  if (!tx || typeof tx !== 'object') {
    throw new ProviderRequestError(-32602, 'Ghosty expected a transaction object.');
  }

  const body = tx as {
    from?: string;
    to?: string;
    data?: string;
    value?: string | number | bigint;
    gas?: string | number | bigint;
    chainId?: string | number;
  };

  if (body.from && body.from.toLowerCase() !== ownerAddress.toLowerCase()) {
    throw new ProviderRequestError(4100, 'Ghosty will only send transactions from the active owner.');
  }

  if (body.chainId !== undefined) {
    const chainId = typeof body.chainId === 'string' ? Number(body.chainId) : body.chainId;
    if (chainId !== 42161) {
      throw new ProviderRequestError(4902, 'Ghosty only sends transactions on Arbitrum One.');
    }
  }

  if (typeof body.to !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(body.to)) {
    throw new ProviderRequestError(
      -32602,
      'Ghosty needs a transaction recipient. It will not deploy a contract.',
    );
  }

  const data = body.data === undefined ? undefined : asHex(body.data, 'calldata');
  const value = asBigint(body.value);
  const gas = body.gas === undefined ? undefined : asBigint(body.gas);

  const call = data ? describeCall(data) : null;
  const summary = [
    ...(call ? [call] : []),
    `To: ${body.to}`,
    `Value: ${formatEth(value)}`,
    data ? `Data: ${fullData(data)}` : 'Data: none',
  ].join('\n');

  return { to: body.to as `0x${string}`, data, value, gas, summary };
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new ProviderRequestError(-32602, 'Typed data was not valid JSON.');
  }
}

function asHex(value: string, label: string): `0x${string}` {
  if (!/^0x[0-9a-fA-F]*$/.test(value)) {
    throw new ProviderRequestError(-32602, `Transaction ${label} was not hex.`);
  }
  return value as `0x${string}`;
}

function asBigint(value: string | number | bigint | undefined): bigint {
  if (value === undefined) return 0n;
  try {
    return BigInt(value);
  } catch {
    throw new ProviderRequestError(-32602, 'Ghosty could not read the transaction value.');
  }
}

function formatEth(value: bigint): string {
  const whole = value / 10n ** 18n;
  const frac = (value % 10n ** 18n).toString().padStart(18, '0').slice(0, 6).replace(/0+$/, '');
  return frac ? `${whole}.${frac} ETH` : `${whole} ETH`;
}

/** All of it up to 4 KB of hex, then the length. The decoded call above is what to read. */
function fullData(data: string): string {
  if (data === '0x') return 'none';
  const bytes = (data.length - 2) / 2;
  return data.length > 8194 ? `${data.slice(0, 8194)}… (${bytes} bytes)` : `${data} (${bytes} bytes)`;
}

const MAX_UINT = 2n ** 256n - 1n;
const KNOWN_CALLS = parseAbi([
  'function approve(address spender, uint256 amount)',
  'function transfer(address to, uint256 amount)',
  'function transferFrom(address from, address to, uint256 amount)',
  'function increaseAllowance(address spender, uint256 addedValue)',
  'function setApprovalForAll(address operator, bool approved)',
]);

/** The calls that hand tokens or allowances to someone, decoded so the user sees who and how much. */
export function describeCall(data: `0x${string}`): string | null {
  try {
    const { functionName, args } = decodeFunctionData({ abi: KNOWN_CALLS, data });
    const amount = (value: unknown) => (value === MAX_UINT ? 'UNLIMITED' : String(value));
    switch (functionName) {
      case 'approve':
        return `WARNING: approve lets ${args[0]} spend ${amount(args[1])} units of this token.`;
      case 'increaseAllowance':
        return `WARNING: increaseAllowance lets ${args[0]} spend ${amount(args[1])} more units of this token.`;
      case 'setApprovalForAll':
        return args[1] ? `WARNING: setApprovalForAll lets ${args[0]} move ALL of this collection.` : `setApprovalForAll revokes ${args[0]}.`;
      case 'transfer':
        return `Sends ${amount(args[1])} units of this token to ${args[0]}.`;
      case 'transferFrom':
        return `Moves ${amount(args[2])} units of this token from ${args[0]} to ${args[1]}.`;
    }
  } catch {
    return null;
  }
  return null;
}

/** Signatures that move money or grant spending without a transaction of their own. */
const RISKY_TYPED = /permit|withdraw|transfer|order|approve|send|delegate/i;

function signedSummary(
  primaryType: string,
  types: Record<string, readonly { name: string; type: string }[]>,
  domain: Record<string, unknown>,
  message: Record<string, unknown>,
): string {
  const lines: string[] = [];
  if (RISKY_TYPED.test(primaryType)) {
    lines.push(`WARNING: a signed ${primaryType} can move funds or grant spending with no further prompt. Check every field.`);
  }
  lines.push(`Signing: ${primaryType}`, 'Message:');
  render(primaryType, message, '  ', 0);
  lines.push('Domain:');
  for (const key of ['name', 'version', 'chainId', 'verifyingContract', 'salt']) {
    if (domain[key] !== undefined) lines.push(`  ${key}: ${show(domain[key])}`);
  }
  return lines.join('\n');

  function render(type: string, value: unknown, indent: string, depth: number): void {
    const fields = types[type];
    if (!fields || depth > 8 || !value || typeof value !== 'object') {
      lines.push(`${indent}${show(value)}`);
      return;
    }
    for (const field of fields) {
      const item = (value as Record<string, unknown>)[field.name];
      const base = field.type.replace(/\[\d*\]$/, '');
      if (types[base]) {
        lines.push(`${indent}${field.name}:`);
        if (Array.isArray(item)) item.forEach((entry, i) => { lines.push(`${indent}  [${i}]`); render(base, entry, `${indent}    `, depth + 1); });
        else render(base, item, `${indent}  `, depth + 1);
      } else {
        lines.push(`${indent}${field.name}: ${show(item)}`);
      }
    }
  }
}

function show(value: unknown): string {
  if (typeof value === 'string') {
    try {
      if (BigInt(value) === MAX_UINT) return 'UNLIMITED';
    } catch {
      // not a number
    }
    return value;
  }
  if (typeof value === 'bigint' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}
