import { VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';

type ShortVecResult = { value: number; offset: number };

const PUMP_PROGRAM_BYTES = bs58.decode('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const PUMP_RELEVANT_DISCRIMINATORS = [
  Uint8Array.from([0x18, 0x1e, 0xc8, 0x28, 0x05, 0x1c, 0x07, 0x77]), 
  Uint8Array.from([0xd6, 0x90, 0x4c, 0xec, 0x5f, 0x8b, 0x31, 0xb4]), 
  Uint8Array.from([155, 234, 231, 146, 236, 158, 162, 30]), 
  Uint8Array.from([51, 230, 133, 164, 1, 127, 131, 173]), 
  Uint8Array.from([93, 246, 130, 60, 231, 233, 64, 178]), 
];
const PUMP_BUY_DISCRIMINATORS = [
  Uint8Array.from([102, 6, 61, 18, 1, 218, 235, 234]), 
  Uint8Array.from([56, 252, 116, 8, 158, 223, 205, 95]), 
];
const PASS_PUMP_BUYS =
  (process.env.FIRST_SLOT_BUNDLE_TRIGGER_ENABLED === '1' || process.env.FIRST_SLOT_BUNDLE_TRIGGER_ENABLED === 'true') ||
  ((process.env.FIRST_SLOT_BUNDLE_TRIGGER_ENABLED ?? '').toLowerCase() !== 'false' &&
    (process.env.WIDE_SCAN_ENABLED === '1' || process.env.WIDE_SCAN_ENABLED === 'true'));

export type DecodedShredstreamTransaction = {
  signature: string | null;
  signatures: string[];
  recentBlockhash: string;
  accountKeys: string[];
  compiledInstructions: {
    programIdIndex: number;
    accountKeyIndexes: number[];
    data: Uint8Array;
  }[];
  versionedTransaction: VersionedTransaction;
};

function ensureAvailable(bytes: Uint8Array, offset: number, length: number) {
  if (offset + length > bytes.length) {
    throw new Error('Unexpected end of Shredstream entry payload');
  }
}

function readU64LE(bytes: Uint8Array, offset: number): { value: number; offset: number } {
  ensureAvailable(bytes, offset, 8);
  const value = Number(Buffer.from(bytes.subarray(offset, offset + 8)).readBigUInt64LE(0));
  if (!Number.isSafeInteger(value)) throw new Error('u64 value exceeds safe integer range');
  return { value, offset: offset + 8 };
}

function readShortVec(bytes: Uint8Array, offset: number): ShortVecResult {
  let value = 0;
  let shift = 0;
  let pos = offset;

  for (let i = 0; i < 4; i++) {
    ensureAvailable(bytes, pos, 1);
    const current = bytes[pos++];
    value |= (current & 0x7f) << shift;
    if ((current & 0x80) === 0) return { value, offset: pos };
    shift += 7;
  }

  throw new Error('Invalid Solana shortvec length');
}

function findMeasuredTransactionAccountKeysOffset(bytes: Uint8Array, offset: number): { accountKeyCount: number; accountKeysOffset: number } {
  let pos = offset;

  const signatureCount = readShortVec(bytes, pos);
  pos = signatureCount.offset;
  ensureAvailable(bytes, pos, signatureCount.value * 64);
  pos += signatureCount.value * 64;

  ensureAvailable(bytes, pos, 1);
  const firstMessageByte = bytes[pos];
  const isVersioned = (firstMessageByte & 0x80) !== 0;
  if (isVersioned) pos += 1;

  ensureAvailable(bytes, pos, 3);
  pos += 3;

  const accountKeyCount = readShortVec(bytes, pos);
  pos = accountKeyCount.offset;
  ensureAvailable(bytes, pos, accountKeyCount.value * 32);

  return { accountKeyCount: accountKeyCount.value, accountKeysOffset: pos };
}

function rawAccountKeysIncludeAny(bytes: Uint8Array, accountKeysOffset: number, accountKeyCount: number, targets: Uint8Array[]): boolean {
  if (targets.length === 0) return false;
  for (let i = 0; i < accountKeyCount; i++) {
    const keyOffset = accountKeysOffset + i * 32;
    for (const target of targets) {
      let matches = true;
      for (let b = 0; b < 32; b++) {
        if (bytes[keyOffset + b] !== target[b]) {
          matches = false;
          break;
        }
      }
      if (matches) return true;
    }
  }
  return false;
}

function bytesEqualAt(bytes: Uint8Array, offset: number, target: Uint8Array): boolean {
  for (let i = 0; i < target.length; i++) {
    if (bytes[offset + i] !== target[i]) return false;
  }
  return true;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function rawAccountKeysIncludeAnyExcept(
  bytes: Uint8Array,
  accountKeysOffset: number,
  accountKeyCount: number,
  targets: Uint8Array[],
  excluded: Uint8Array
): boolean {
  const filtered = targets.filter(target => !sameBytes(target, excluded));
  return rawAccountKeysIncludeAny(bytes, accountKeysOffset, accountKeyCount, filtered);
}

function startsWithAny(data: Uint8Array, discriminators: Uint8Array[]): boolean {
  for (const discriminator of discriminators) {
    if (data.length < discriminator.length) continue;
    let matches = true;
    for (let i = 0; i < discriminator.length; i++) {
      if (data[i] !== discriminator[i]) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }
  return false;
}

function rawTransactionHasRelevantPumpInstruction(bytes: Uint8Array, offset: number): boolean {
  let pos = offset;

  const signatureCount = readShortVec(bytes, pos);
  pos = signatureCount.offset;
  ensureAvailable(bytes, pos, signatureCount.value * 64);
  pos += signatureCount.value * 64;

  ensureAvailable(bytes, pos, 1);
  const firstMessageByte = bytes[pos];
  const isVersioned = (firstMessageByte & 0x80) !== 0;
  if (isVersioned) pos += 1;

  ensureAvailable(bytes, pos, 3);
  pos += 3;

  const accountKeyCount = readShortVec(bytes, pos);
  pos = accountKeyCount.offset;
  const accountKeysOffset = pos;
  ensureAvailable(bytes, pos, accountKeyCount.value * 32);
  pos += accountKeyCount.value * 32;

  ensureAvailable(bytes, pos, 32);
  pos += 32;

  const instructionCount = readShortVec(bytes, pos);
  pos = instructionCount.offset;
  for (let i = 0; i < instructionCount.value; i++) {
    ensureAvailable(bytes, pos, 1);
    const programIdIndex = bytes[pos++];

    const accountIndexCount = readShortVec(bytes, pos);
    pos = accountIndexCount.offset;
    ensureAvailable(bytes, pos, accountIndexCount.value);
    pos += accountIndexCount.value;

    const dataLength = readShortVec(bytes, pos);
    pos = dataLength.offset;
    ensureAvailable(bytes, pos, dataLength.value);
    const data = bytes.subarray(pos, pos + dataLength.value);
    pos += dataLength.value;

    if (programIdIndex >= accountKeyCount.value) continue;
    const programOffset = accountKeysOffset + programIdIndex * 32;
    if (
      bytesEqualAt(bytes, programOffset, PUMP_PROGRAM_BYTES) &&
      (startsWithAny(data, PUMP_RELEVANT_DISCRIMINATORS) || (PASS_PUMP_BUYS && startsWithAny(data, PUMP_BUY_DISCRIMINATORS)))
    ) {
      return true;
    }
  }

  return false;
}

function measureVersionedTransaction(bytes: Uint8Array, offset: number): number {
  let pos = offset;

  const signatureCount = readShortVec(bytes, pos);
  pos = signatureCount.offset;
  ensureAvailable(bytes, pos, signatureCount.value * 64);
  pos += signatureCount.value * 64;

  ensureAvailable(bytes, pos, 1);
  const firstMessageByte = bytes[pos];
  const isVersioned = (firstMessageByte & 0x80) !== 0;
  if (isVersioned) pos += 1;

  ensureAvailable(bytes, pos, 3);
  pos += 3;

  const accountKeyCount = readShortVec(bytes, pos);
  pos = accountKeyCount.offset;
  ensureAvailable(bytes, pos, accountKeyCount.value * 32);
  pos += accountKeyCount.value * 32;

  ensureAvailable(bytes, pos, 32);
  pos += 32;

  const instructionCount = readShortVec(bytes, pos);
  pos = instructionCount.offset;
  for (let i = 0; i < instructionCount.value; i++) {
    ensureAvailable(bytes, pos, 1);
    pos += 1;

    const accountIndexCount = readShortVec(bytes, pos);
    pos = accountIndexCount.offset;
    ensureAvailable(bytes, pos, accountIndexCount.value);
    pos += accountIndexCount.value;

    const dataLength = readShortVec(bytes, pos);
    pos = dataLength.offset;
    ensureAvailable(bytes, pos, dataLength.value);
    pos += dataLength.value;
  }

  if (isVersioned) {
    const addressLookupCount = readShortVec(bytes, pos);
    pos = addressLookupCount.offset;
    for (let i = 0; i < addressLookupCount.value; i++) {
      ensureAvailable(bytes, pos, 32);
      pos += 32;

      const writableCount = readShortVec(bytes, pos);
      pos = writableCount.offset;
      ensureAvailable(bytes, pos, writableCount.value);
      pos += writableCount.value;

      const readonlyCount = readShortVec(bytes, pos);
      pos = readonlyCount.offset;
      ensureAvailable(bytes, pos, readonlyCount.value);
      pos += readonlyCount.value;
    }
  }

  return pos - offset;
}

function toDecodedTransaction(tx: VersionedTransaction): DecodedShredstreamTransaction {
  const message: any = tx.message as any;
  const accountKeys = (message.staticAccountKeys || message.accountKeys || [])
    .map((key: any) => key.toString());

  const compiledInstructions = (message.compiledInstructions || []).map((ix: any) => ({
    programIdIndex: ix.programIdIndex,
    accountKeyIndexes: Array.from(ix.accountKeyIndexes || ix.accounts || []),
    data: Uint8Array.from(ix.data || []),
  }));

  const signatures = tx.signatures.map(signature => bs58.encode(signature));
  return {
    signature: signatures[0] || null,
    signatures,
    recentBlockhash: message.recentBlockhash,
    accountKeys,
    compiledInstructions,
    versionedTransaction: tx,
  };
}

function parseEntry(
  bytes: Uint8Array,
  offset: number,
  targetBytes: Uint8Array[]
): { transactions: DecodedShredstreamTransaction[]; offset: number } {
  let pos = offset;
  const transactions: DecodedShredstreamTransaction[] = [];

  const numHashes = readU64LE(bytes, pos);
  pos = numHashes.offset;
  ensureAvailable(bytes, pos, 32);
  pos += 32;

  const transactionCount = readU64LE(bytes, pos);
  pos = transactionCount.offset;
  if (transactionCount.value > 50_000) throw new Error('Unreasonable transaction count in entry');

  for (let i = 0; i < transactionCount.value; i++) {
    const txLength = measureVersionedTransaction(bytes, pos);

    // Filtro rápido em bytes brutos: só paga deserialize+Base58 se a tx
    // realmente envolve um dos targets (DEV_TARGET/WARMUP_DEV_TARGET).
    if (targetBytes.length > 0) {
      const { accountKeyCount, accountKeysOffset } = findMeasuredTransactionAccountKeysOffset(bytes, pos);
      if (!rawAccountKeysIncludeAny(bytes, accountKeysOffset, accountKeyCount, targetBytes)) {
        pos += txLength;
        continue;
      }
      const matchedPumpProgram = rawAccountKeysIncludeAny(bytes, accountKeysOffset, accountKeyCount, [PUMP_PROGRAM_BYTES]);
      const matchedWalletTarget = rawAccountKeysIncludeAnyExcept(bytes, accountKeysOffset, accountKeyCount, targetBytes, PUMP_PROGRAM_BYTES);
      if (matchedPumpProgram && !matchedWalletTarget && !rawTransactionHasRelevantPumpInstruction(bytes, pos)) {
        pos += txLength;
        continue;
      }
    }

    const txBytes = bytes.subarray(pos, pos + txLength);
    transactions.push(toDecodedTransaction(VersionedTransaction.deserialize(txBytes)));
    pos += txLength;
  }

  return { transactions, offset: pos };
}

export function decodeShredstreamEntries(
  payload: Buffer | Uint8Array,
  targetBytes: Uint8Array[] = []
): DecodedShredstreamTransaction[] {
  const bytes = payload instanceof Buffer ? Uint8Array.from(payload) : payload;
  const entryCount = readU64LE(bytes, 0);
  if (entryCount.value > 100_000) throw new Error('Unreasonable entry count in Shredstream payload');

  let pos = entryCount.offset;
  const transactions: DecodedShredstreamTransaction[] = [];
  for (let i = 0; i < entryCount.value; i++) {
    const parsed = parseEntry(bytes, pos, targetBytes);
    transactions.push(...parsed.transactions);
    pos = parsed.offset;
  }

  return transactions;
}
