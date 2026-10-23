import { describe, expect, it } from 'bun:test';
import { canonicalize, sha256Hex } from '../../src/shared/json/canonical';
import { decodeCursor, encodeCursor, InvalidCursorError } from '../../src/shared/cursor';
import {
  computeOpeningPayloadHash,
  computeWagerPayloadHash,
} from '../../src/contexts/wagering/application/dto/payload-hash';

const base = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1',
  walletId: '0192f291-27dd-7d3f-8071-5f8685deef37',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: 'BET',
};

describe('JSON canônico, payloadHash e cursor (UT-51…UT-53)', () => {
  it('UT-51 canonicaliza com chaves ordenadas, aninhamento e unicode', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalize({ a: { d: null, c: [1, 2] } })).toBe(
      '{"a":{"c":[1,2],"d":null}}',
    );
    expect(canonicalize({ a: 'çãé' })).toBe('{"a":"çãé"}');
    expect(canonicalize({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(sha256Hex('abc')).toHaveLength(64);
    expect(() => canonicalize({ a: Number.POSITIVE_INFINITY })).toThrow();
  });

  it('UT-52 payloadHash normaliza amount e ignora header/transporte', () => {
    const withWhole = computeWagerPayloadHash({
      ...base,
      money: { amount: '25', currency: 'BRL' },
      referenceExternalTransactionId: null,
    });
    const withScale = computeWagerPayloadHash({
      ...base,
      money: { amount: '25.00', currency: 'BRL' },
      referenceExternalTransactionId: null,
    });
    expect(withWhole).toBe(withScale);

    const differentKind = computeWagerPayloadHash({
      ...base,
      kind: 'WIN',
      money: { amount: '25.00', currency: 'BRL' },
      referenceExternalTransactionId: null,
    });
    expect(differentKind).not.toBe(withScale);

    const withReference = computeWagerPayloadHash({
      ...base,
      money: { amount: '25.00', currency: 'BRL' },
      referenceExternalTransactionId: 'transaction-122',
    });
    expect(withReference).not.toBe(withScale);

    const opening = computeOpeningPayloadHash({
      walletId: base.walletId,
      playerId: base.playerId,
      amount: '1000',
      currency: 'BRL',
    });
    const openingScaled = computeOpeningPayloadHash({
      walletId: base.walletId,
      playerId: base.playerId,
      amount: '1000.00',
      currency: 'BRL',
    });
    expect(opening).toBe(openingScaled);
  });

  it('UT-53 cursor é opaco, estável e valida entradas', () => {
    const cursor = { walletVersion: 3, entryId: '0192f291-27dd-7d3f-8071-5f8685deef37' };
    const encoded = encodeCursor(cursor);
    expect(encoded).not.toContain('{');
    expect(decodeCursor(encoded)).toEqual(cursor);
    expect(() => decodeCursor('nao-base64')).toThrow(InvalidCursorError);
    const invalidShape = Buffer.from(JSON.stringify({ v: 0, i: 'x' })).toString(
      'base64url',
    );
    expect(() => decodeCursor(invalidShape)).toThrow(InvalidCursorError);
  });
});
