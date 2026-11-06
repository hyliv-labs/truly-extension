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
    throw new ProviderRequestError(4100, 'Truly will only sign for the active owner.');
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
      'Truly supports eth_signTypedData_v4, not the older eth_signTypedData.',
    );
  }
  if (!TYPED_METHODS.has(method)) {
    throw new ProviderRequestError(4200, `Truly does not support ${method}.`);
  }

  const address = params.find(
    (value): value is string => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value),
  );
  const raw = params.find((value) => value !== address);
  if (!address || raw === undefined) {
    throw new ProviderRequestError(-32602, 'Typed data is missing an address or a payload.');
  }
  if (address.toLowerCase() !== ownerAddress.toLowerCase()) {
    throw new ProviderRequestError(4100, 'Truly will only sign for the active owner.');
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

  const summary = truncate(
    JSON.stringify(
      { primaryType: body.primaryType, domain, message: body.message },
      null,
      2,
    ),
  );

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
  readonly summary: string;
}

/** eth_sendTransaction's single parameter. Contract creation is refused. */
export function parseTransactionRequest(
  params: readonly unknown[],
  ownerAddress: string,
): ParsedTransaction {
  const tx = params[0];
  if (!tx || typeof tx !== 'object') {
    throw new ProviderRequestError(-32602, 'Truly expected a transaction object.');
  }

  const body = tx as {
    from?: string;
    to?: string;
    data?: string;
    value?: string | number | bigint;
    chainId?: string | number;
  };

  if (body.from && body.from.toLowerCase() !== ownerAddress.toLowerCase()) {
    throw new ProviderRequestError(4100, 'Truly will only send transactions from the active owner.');
  }

  if (body.chainId !== undefined) {
    const chainId = typeof body.chainId === 'string' ? Number(body.chainId) : body.chainId;
    if (chainId !== 42161) {
      throw new ProviderRequestError(4902, 'Truly only sends transactions on Arbitrum One.');
    }
  }

  if (typeof body.to !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(body.to)) {
    throw new ProviderRequestError(
      -32602,
      'Truly needs a transaction recipient. It will not deploy a contract.',
    );
  }

  const data = body.data === undefined ? undefined : asHex(body.data, 'calldata');
  const value = asBigint(body.value);

  const summary = [
    `To: ${body.to}`,
    `Value: ${formatEth(value)}`,
    data ? `Data: ${previewData(data)}` : 'Data: none',
  ].join('\n');

  return { to: body.to as `0x${string}`, data, value, summary };
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
    throw new ProviderRequestError(-32602, 'Truly could not read the transaction value.');
  }
}

function formatEth(value: bigint): string {
  const whole = value / 10n ** 18n;
  const frac = (value % 10n ** 18n).toString().padStart(18, '0').slice(0, 6).replace(/0+$/, '');
  return frac ? `${whole}.${frac} ETH` : `${whole} ETH`;
}

function previewData(data: string): string {
  if (data === '0x') return 'none';
  const bytes = (data.length - 2) / 2;
  return `${data.slice(0, 18)}… (${bytes} bytes)`;
}

function truncate(value: string): string {
  return value.length > 4000 ? `${value.slice(0, 4000)}\n…` : value;
}
