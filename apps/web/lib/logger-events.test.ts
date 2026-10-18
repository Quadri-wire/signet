import test from 'node:test';
import assert from 'node:assert/strict';
import { attributeContractWithDeps, type AttributionDb } from './contract-attribution.ts';
import { loadContractSpec } from './server/contract-spec.ts';
import { exportContractDiagram } from './server/diagram-export.ts';
import { withV1 } from './api/v1/http.ts';
import { LruSpecCache, type SpecJson, InterfaceUnreadable } from '@signet/spec';
import { xdr } from '@stellar/stellar-sdk';
import { HORIZON_MAX_RECORDS } from './server/horizon.ts';

const ADDRESS = 'CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN';
const HASH = 'a'.repeat(64);

const SPEC: SpecJson = {
  schemaVersion: 1,
  wasmHash: HASH,
  sdkVersion: '16.1.0',
  entriesXdr: [],
  functions: [],
  types: [],
  errors: [],
  events: [],
  warnings: [],
};

function captureLogs() {
  const originalLog = console.log;
  const originalError = console.error;
  const events: Array<{ level: string; msg: string; payload: Record<string, unknown> }> = [];

  const intercept = (stream: 'stdout' | 'stderr') => (message?: unknown, ..._args: unknown[]) => {
    if (typeof message === 'string') {
      try {
        const parsed = JSON.parse(message);
        if (parsed && typeof parsed === 'object' && typeof parsed.msg === 'string') {
          events.push({
            level: parsed.lvl,
            msg: parsed.msg,
            payload: parsed,
          });
        }
      } catch {
        // Not a JSON log line
      }
    }
  };

  console.log = intercept('stdout');
  console.error = intercept('stderr');

  return {
    events,
    find(msg: string) {
      return events.find((e) => e.msg === msg);
    },
    filter(msg: string) {
      return events.filter((e) => e.msg === msg);
    },
    restore() {
      console.log = originalLog;
      console.error = originalError;
    },
  };
}

test('contract.attribution hit logs expected event name and field set', async () => {
  const cap = captureLogs();
  try {
    const db: AttributionDb = {
      findContract: async () => ({
        address: ADDRESS,
        network: 'testnet',
        deployerPubkey: 'GDEPLOYER',
        deployTxHash: '0x123',
        deployedAt: new Date(),
        wasmHash: HASH,
        walletId: 'w1',
        walletPubkey: 'GWALLET',
      }),
    };

    const res = await attributeContractWithDeps('alice', ADDRESS, { db, network: 'testnet' });
    assert.equal(res.status, 'attributed');

    const ev = cap.find('contract.attribution');
    assert.ok(ev, 'expected contract.attribution event');
    assert.equal(ev.level, 'info');

    const expectedKeys = ['ts', 'lvl', 'msg', 'handle', 'address', 'status', 'source', 'capped', 'ms'];
    for (const key of expectedKeys) {
      assert.ok(key in ev.payload, `missing field: ${key}`);
    }
    assert.equal(ev.payload.handle, 'alice');
    assert.equal(ev.payload.address, ADDRESS);
    assert.equal(ev.payload.status, 'attributed');
    assert.equal(ev.payload.source, 'database');
    assert.equal(ev.payload.capped, false);
    assert.equal(typeof ev.payload.ms, 'number');
  } finally {
    cap.restore();
  }
});

test('contract.attribution miss logs expected event name and field set', async () => {
  const cap = captureLogs();
  try {
    const db: AttributionDb = {
      findContract: async () => null,
    };

    const res = await attributeContractWithDeps('alice', ADDRESS, { db, network: 'testnet' });
    assert.equal(res.status, 'not-attributed');

    const ev = cap.find('contract.attribution');
    assert.ok(ev, 'expected contract.attribution event');
    assert.equal(ev.level, 'info');

    assert.equal(ev.payload.handle, 'alice');
    assert.equal(ev.payload.address, ADDRESS);
    assert.equal(ev.payload.status, 'not-attributed');
    assert.equal(ev.payload.source, 'database');
    assert.equal(ev.payload.capped, false);
    assert.equal(typeof ev.payload.ms, 'number');
  } finally {
    cap.restore();
  }
});

test('contract.attribution capped miss logs capped: true', async () => {
  const cap = captureLogs();
  try {
    const db: AttributionDb = {
      findContract: async () => undefined,
    };
    const horizon = {
      listWallets: async () => ['GCQZFJACBU5UII4ZDTFVVE3EPSGPOZYHMY2THOYJ57WYX6D2AQNEQINU'],
      listOperations: async () => ({
        operations: Array.from({ length: HORIZON_MAX_RECORDS + 1 }, () => ({
          type: 'payment',
          createdAt: new Date().toISOString(),
        })),
        truncated: true,
      }),
      getResultMetaXdr: async () => null,
    };

    const res = await attributeContractWithDeps('alice', ADDRESS, { db, horizon, network: 'testnet' });
    assert.equal(res.status, 'not-attributed');
    assert.equal(res.capped, true);

    const ev = cap.find('contract.attribution');
    assert.ok(ev, 'expected contract.attribution event');
    assert.equal(ev.level, 'info');

    assert.equal(ev.payload.handle, 'alice');
    assert.equal(ev.payload.address, ADDRESS);
    assert.equal(ev.payload.status, 'not-attributed');
    assert.equal(ev.payload.source, 'horizon');
    assert.equal(ev.payload.capped, true);
    assert.equal(typeof ev.payload.ms, 'number');
  } finally {
    cap.restore();
  }
});

test('spec.fetch miss (RPC) logs expected event name and field set', async () => {
  const cap = captureLogs();
  try {
    const resolve = async () => ({ spec: SPEC, source: 'rpc' as const, wasmHash: HASH });
    const result = await loadContractSpec(
      { address: ADDRESS, network: 'testnet', wasmHash: HASH },
      { resolve, appNetwork: 'testnet' },
    );
    assert.ok(result.ok);

    const ev = cap.find('spec.fetch');
    assert.ok(ev, 'expected spec.fetch event');
    assert.equal(ev.level, 'info');

    const expectedKeys = ['ts', 'lvl', 'msg', 'address', 'network', 'wasmHash', 'bytes', 'cacheHit', 'ms'];
    for (const key of expectedKeys) {
      assert.ok(key in ev.payload, `missing field: ${key}`);
    }
    assert.equal(ev.payload.address, ADDRESS);
    assert.equal(ev.payload.network, 'testnet');
    assert.equal(ev.payload.wasmHash, HASH);
    assert.equal(ev.payload.cacheHit, false);
    assert.equal(typeof ev.payload.bytes, 'number');
    assert.equal(typeof ev.payload.ms, 'number');
  } finally {
    cap.restore();
  }
});

test('spec.fetch hit (cache) logs cacheHit: true', async () => {
  const cap = captureLogs();
  try {
    const memory = new LruSpecCache<SpecJson>();
    await memory.set(HASH, SPEC);

    const result = await loadContractSpec(
      { address: ADDRESS, network: 'testnet', wasmHash: HASH },
      { caches: [memory], appNetwork: 'testnet', rpcUrl: 'http://127.0.0.1:1', allowHttp: true },
    );
    assert.ok(result.ok);

    const ev = cap.find('spec.fetch');
    assert.ok(ev, 'expected spec.fetch event');
    assert.equal(ev.level, 'info');

    assert.equal(ev.payload.address, ADDRESS);
    assert.equal(ev.payload.network, 'testnet');
    assert.equal(ev.payload.wasmHash, HASH);
    assert.equal(ev.payload.cacheHit, true);
    assert.equal(typeof ev.payload.bytes, 'number');
    assert.equal(typeof ev.payload.ms, 'number');
  } finally {
    cap.restore();
  }
});

test('spec.decode.failed logs expected event name, warn level, and field set', async () => {
  const cap = captureLogs();
  try {
    const result = await loadContractSpec(
      { address: ADDRESS, network: 'testnet', wasmHash: HASH },
      {
        appNetwork: 'testnet',
        resolve: async () => {
          throw new InterfaceUnreadable('16.1.0', new Error('unsupported spec arm'));
        },
      },
    );
    assert.equal(result.ok, false);

    const ev = cap.find('spec.decode.failed');
    assert.ok(ev, 'expected spec.decode.failed event');
    assert.equal(ev.level, 'warn');

    const expectedKeys = ['ts', 'lvl', 'msg', 'wasmHash', 'sdkVersion', 'error'];
    for (const key of expectedKeys) {
      assert.ok(key in ev.payload, `missing field: ${key}`);
    }
    assert.equal(ev.payload.wasmHash, HASH);
    assert.equal(ev.payload.sdkVersion, '16.1.0');
    assert.ok(typeof ev.payload.error === 'string');
  } finally {
    cap.restore();
  }
});

test('spec.limit.exceeded logs expected event name, warn level, and field set', async () => {
  const cap = captureLogs();
  try {
    const entriesXdr = Array.from({ length: 61 }, (_, i) =>
      xdr.ScSpecEntry.scSpecEntryFunctionV0(
        new xdr.ScSpecFunctionV0({ doc: '', name: `function_${i}`, inputs: [], outputs: [] }),
      ).toXDR('base64'),
    );

    const deps = {
      attribute: async () => ({
        status: 'attributed' as const,
        source: 'database' as const,
        contract: {
          address: ADDRESS,
          network: 'testnet',
          wasmHash: HASH,
          deployerPubkey: '',
          deployTxHash: '',
          deployedAt: '',
        },
      }),
      loadSpec: async () => ({
        ok: true as const,
        spec: { ...SPEC, entriesXdr },
        wasmHash: HASH,
        source: 'memory' as const,
      }),
    };

    const req = new Request(`https://signet.example/p/alice/contract/${ADDRESS}/diagram.svg`);
    const res = await exportContractDiagram(req, { handle: 'alice', address: ADDRESS }, deps);
    assert.equal(res.status, 422);

    const ev = cap.find('spec.limit.exceeded');
    assert.ok(ev, 'expected spec.limit.exceeded event');
    assert.equal(ev.level, 'warn');

    const expectedKeys = ['ts', 'lvl', 'msg', 'address', 'limit', 'observed'];
    for (const key of expectedKeys) {
      assert.ok(key in ev.payload, `missing field: ${key}`);
    }
    assert.equal(ev.payload.address, ADDRESS);
    assert.equal(ev.payload.limit, 60);
    assert.equal(ev.payload.observed, 61);
  } finally {
    cap.restore();
  }
});

test('api.v1.request logs route, status, ms and contains no client IP, cookies, or auth tokens', async () => {
  const cap = captureLogs();
  try {
    const handler = withV1(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const req = new Request('http://localhost/api/v1/profiles/alice', {
      headers: {
        'x-forwarded-for': '198.51.100.42',
        cookie: 'sid=sensitive-cookie-value',
        authorization: 'Bearer sgk_test_secret_token',
      },
    });

    const res = await handler(req);
    assert.ok(res.status);

    const ev = cap.find('api.v1.request');
    assert.ok(ev, 'expected api.v1.request event');
    assert.equal(ev.level, 'info');

    assert.equal(ev.payload.route, '/api/v1/profiles/alice');
    assert.equal(ev.payload.status, res.status);
    assert.equal(typeof ev.payload.ms, 'number');

    // Strict privacy assertions
    assert.equal('ip' in ev.payload, false, 'must not include IP');
    assert.equal('clientIp' in ev.payload, false, 'must not include client IP');
    assert.equal('cookie' in ev.payload, false, 'must not include cookie');
    assert.equal('token' in ev.payload, false, 'must not include token');
    assert.equal('authorization' in ev.payload, false, 'must not include authorization');

    const rawJson = JSON.stringify(ev.payload);
    assert.ok(!rawJson.includes('198.51.100.42'), 'IP must not leak into log line');
    assert.ok(!rawJson.includes('sensitive-cookie-value'), 'cookie must not leak into log line');
    assert.ok(!rawJson.includes('sgk_test_secret_token'), 'token must not leak into log line');
  } finally {
    cap.restore();
  }
});
