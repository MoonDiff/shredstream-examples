//shredstream-client.ts
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import EventEmitter from 'events';
import path from 'path';
import fs from 'fs';
import { decodeShredstreamEntries } from './solana-entry-decoder';

// Resolve o diretório do .proto de forma robusta, sem depender de uma
// estrutura fixa de pastas.
function resolveProtoDir(): string {
  const candidates = [
    process.env.PROTO_DIR,
    path.resolve(__dirname, '../protos'),
    path.resolve(__dirname, './protos'),
    path.resolve(process.cwd(), 'protos'),
  ].filter(Boolean) as string[];

  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'shredstream.proto'))) return dir;
  }

  throw new Error(
    `shredstream.proto não encontrado. Tentei: ${candidates.join(', ')}\n` +
    `Crie a pasta 'protos/' com o arquivo shredstream.proto dentro`
  );
}

const PROTO_DIR = resolveProtoDir();

type DecodeStats = {
  payloadBytes: number;
  transactionCount: number;
};

export class ShredstreamClient extends EventEmitter {
  private client: any = null;
  private stream: any = null;
  private proxyTarget = '127.0.0.1:7777';
  private streamingCallback: ((tx: any, recvAtNs: bigint) => void) | null = null;
  private isConnecting = false;
  private targetBytes: Uint8Array[] = [];

  /**
   * Configura os pubkeys (DEV_TARGET/WARMUP_DEV_TARGET) usados para filtrar
   * transações em bytes brutos, ANTES do deserialize completo + Base58. Chame
   * uma vez no boot, antes de startStreaming(). Veja solana-entry-decoder.ts
   * para o racional completo da otimização.
   */
  setTargetKeys(keys: Uint8Array[]) {
    this.targetBytes = keys;
  }

  private findConstructorRecursive(obj: any, targetName: string): any {
    if (!obj || typeof obj !== 'object') return null;
    if (obj[targetName]) return obj[targetName];
    for (const key of Object.keys(obj)) {
      if (obj[key] && typeof obj[key] === 'object') {
        const found = this.findConstructorRecursive(obj[key], targetName);
        if (found) return found;
      }
    }
    return null;
  }

  async connect(port: number = 7777, maxAttempts = 30) {
    if (this.isConnecting) return;
    this.isConnecting = true;

    const host = '127.0.0.1';
    const resolvedPort = Number(port);
    this.proxyTarget = `${host}:${resolvedPort}`;

    let attempt = 0;
    while (attempt < maxAttempts) {
      attempt++;
      try {
        const packageDefinition = await protoLoader.load([path.join(PROTO_DIR, 'shredstream.proto')], {
          keepCase: true,
          longs: String,
          enums: String,
          defaults: true,
          oneofs: true,
          includeDirs: [PROTO_DIR],
        });
        const proto = grpc.loadPackageDefinition(packageDefinition) as any;

        const ClientConstructor =
          proto?.shredstream?.ShredstreamProxy ||
          this.findConstructorRecursive(proto, 'ShredstreamProxy');
        if (!ClientConstructor) throw new Error('ShredstreamProxy service not found in proto');

        await this.close();
        this.client = new ClientConstructor(this.proxyTarget, grpc.credentials.createInsecure(), {
          'grpc.keepalive_time_ms': 10_000,
          'grpc.keepalive_timeout_ms': 5_000,
          'grpc.keepalive_permit_without_calls': 1,
          'grpc.http2.min_time_between_pings_ms': 10_000,
          'grpc.http2.max_pings_without_data': 0,
          'grpc.max_receive_message_length': 64 * 1024 * 1024,
          'grpc.max_send_message_length': 64 * 1024 * 1024,
        });
        await new Promise<void>((resolve, reject) => {
          const deadline = Date.now() + 10000;
          this.client.waitForReady(deadline, (err: Error | undefined) => err ? reject(err) : resolve());
        });
        this.isConnecting = false;
        this.emit('connected');
        console.log(`Conectado em ${this.proxyTarget}`);
        return;
      } catch (err: any) {
        this.emit('connect-failed', { attempt, message: err?.message });
        console.warn(`Tentativa ${attempt} de conectar no proxy Shredstream falhou: ${err?.message}`);
        await new Promise(r => setTimeout(r, Math.min(5000, 500 * attempt)));
      }
    }

    this.isConnecting = false;
    throw new Error('Failed to connect to Shredstream after multiple attempts');
  }

  async startStreaming(callback: (tx: any, recvAtNs: bigint) => void) {
    this.streamingCallback = callback;
    if (!this.client) throw new Error('Client not created. Call connect() first.');

    try { if (this.stream && typeof this.stream.cancel === 'function') this.stream.cancel(); } catch (e) { }

    try {
      this.stream = this.client.SubscribeEntries({});
      this.emit('stream-created');

      this.stream.on('data', (data: any) => {
        const recvAtNs = process.hrtime.bigint();

        // Envelopar a decodificação em setImmediate libera a rede gRPC
        // para continuar recebendo pacotes sem dar timeout.
        setImmediate(() => {
          try {
            if (Buffer.isBuffer(data?.entries) || data?.entries instanceof Uint8Array) {
              const transactions = decodeShredstreamEntries(data.entries, this.targetBytes);
              const stats: DecodeStats = {
                payloadBytes: data.entries.length,
                transactionCount: transactions.length,
              };
              this.emit('entries-decoded', stats);

              for (let i = 0; i < transactions.length; i++) {
                try { this.streamingCallback && this.streamingCallback(transactions[i], recvAtNs); } catch (cbErr) { }
              }
              return;
            }

            const entries = Array.isArray(data?.entries) ? data.entries : [];
            let transactionCount = 0;
            for (let i = 0; i < entries.length; i++) {
              const txs = entries[i].transactions || [];
              for (let j = 0; j < txs.length; j++) {
                transactionCount += 1;
                try { this.streamingCallback && this.streamingCallback(txs[j], recvAtNs); } catch (cbErr) { }
              }
            }
            this.emit('entries-decoded', { payloadBytes: 0, transactionCount });
          } catch (err) {
            this.emit('processing-error', err);
          }
        });
      });

      this.stream.on('error', (err: Error) => {
        console.error('Erro no stream do Shredstream:', err.message);
        this.emit('stream-error', err);
        (async () => { await this.close(); })();
      });

      this.stream.on('end', () => {
        console.warn('Stream do Shredstream encerrou');
        this.emit('stream-end');
        (async () => { await this.close(); })();
      });
    } catch (err) {
      this.emit('stream-error', err as Error);
      throw err;
    }
  }

  async close() {
    if (this.stream) {
      try { this.stream.removeAllListeners?.(); } catch (e) { }
      try { if (typeof this.stream.cancel === 'function') this.stream.cancel(); } catch (e) { }
    }
    this.stream = null;

    if (this.client) {
      try { if (typeof this.client.close === 'function') this.client.close(); } catch (e) { }
    }
    this.client = null;
    this.streamingCallback = null;
  }

  isClientAlive() { return !!this.client; }
}
