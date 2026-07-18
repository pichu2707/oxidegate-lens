// test/sdk-response.test.mjs
//
// Unit tests for lib/sdk-response.mjs's `unwrapSdkResponse`. The defect this
// guards against: an openapi-fetch style result tuple `{ data, error }`
// where `data` is legitimately `undefined` on a non-2xx response was being
// treated as a legitimate empty success because `'data' in value` is true
// even when the value is `undefined`. `error` was never inspected. See the
// module's own header comment for the full contract these tests hold it to.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unwrapSdkResponse } from '../lib/sdk-response.mjs';

test('unwrapSdkResponse: success tuple with populated data -> returns data', () => {
  const result = unwrapSdkResponse({ data: ['a', 'b'], error: undefined });
  assert.deepEqual(result, ['a', 'b']);
});

test('unwrapSdkResponse: legit empty success (data undefined, no error) -> returns undefined, does NOT throw', () => {
  assert.doesNotThrow(() => {
    const result = unwrapSdkResponse({ data: undefined, error: undefined });
    assert.equal(result, undefined);
  });
});

test('unwrapSdkResponse: error tuple with object body -> throws Error with .message from body.message and .cause the original body', () => {
  const body = { data: undefined, error: { message: 'boom', name: 'X' } };
  assert.throws(
    () => unwrapSdkResponse(body),
    (err) => {
      assert.ok(err instanceof Error);
      assert.equal(err.message, 'boom');
      assert.equal(err.cause, body.error);
      return true;
    },
  );
});

test('unwrapSdkResponse: error tuple with string error -> throws Error with that string as message', () => {
  assert.throws(
    () => unwrapSdkResponse({ error: 'nope' }),
    (err) => {
      assert.ok(err instanceof Error);
      assert.equal(err.message, 'nope');
      return true;
    },
  );
});

test('unwrapSdkResponse: error already an Error instance -> throws that SAME instance, not a wrapper', () => {
  const original = new Error('already an error');
  assert.throws(
    () => unwrapSdkResponse({ error: original }),
    (err) => {
      assert.strictEqual(err, original);
      return true;
    },
  );
});

test('unwrapSdkResponse: non-string, message-less error object -> throws Error whose message is the JSON string of the body', () => {
  const errorBody = { code: 500 };
  assert.throws(
    () => unwrapSdkResponse({ error: errorBody }),
    (err) => {
      assert.ok(err instanceof Error);
      assert.equal(err.message, JSON.stringify(errorBody));
      return true;
    },
  );
});

test('unwrapSdkResponse: raw plain object without data/error keys -> returned unchanged (same reference)', () => {
  const raw = { foo: 1 };
  assert.strictEqual(unwrapSdkResponse(raw), raw);
});

test('unwrapSdkResponse: array value -> returned unchanged (same reference)', () => {
  const raw = [1, 2, 3];
  assert.strictEqual(unwrapSdkResponse(raw), raw);
});

test('unwrapSdkResponse: null -> returned unchanged', () => {
  assert.equal(unwrapSdkResponse(null), null);
});

test('unwrapSdkResponse: undefined -> returned unchanged', () => {
  assert.equal(unwrapSdkResponse(undefined), undefined);
});
