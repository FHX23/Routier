import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { scanNextRoutes } from '../src/parsers/next/index.js';
import { exampleFromPattern, exampleFromSchema } from '../src/parsers/shared/examples.js';
import { customerSchema } from './fixtures/next-validation/lib/validations/customer.js';

test('exampleFromPattern produces strings that match common validation patterns', () => {
  const cases: [string, number?, number?][] = [
    [/^(\d{1,2}\.\d{3}\.\d{3}-[\dkK]|\d{7,8}-[\dkK])$/.source, 9, 12],
    [/^\+569\d{8}$/.source],
    [/^[A-Za-zÀ-ÿ\s]+$/.source, 1, 50],
    [/^[a-z0-9-]{3,20}$/.source],
    [/^(?=.*?[A-Z])(?=.*?[a-z])(?=.*?[0-9])(?=.*?[#?!@$%^&*-]).*$/.source, 8],
    [/^\d{4}-\d{2}-\d{2}$/.source],
    [/^[^@\s]+@[^@\s]+\.[^@\s]+$/.source],
  ];
  for (const [pattern, min, max] of cases) {
    const value = exampleFromPattern(pattern, min, max);
    assert.ok(value !== null, `no example for ${pattern}`);
    assert.match(value!, new RegExp(pattern), pattern);
    if (min !== undefined) assert.ok(value!.length >= min, `${pattern} too short: ${value}`);
    if (max !== undefined) assert.ok(value!.length <= max, `${pattern} too long: ${value}`);
  }
});

test('numeric and length constraints are respected', () => {
  assert.equal(exampleFromSchema({ type: 'number', minimum: 100 }), 100);
  assert.equal(exampleFromSchema({ type: 'integer', maximum: 5 }), 5);
  assert.equal((exampleFromSchema({ type: 'string', minLength: 9 }) as string).length, 9);
  assert.deepEqual(exampleFromSchema({ type: 'array', items: { type: 'string' }, minItems: 2 }), ['string', 'string']);
});

test('the example body inferred from a Zod schema passes that same schema', async () => {
  const routes = await scanNextRoutes({ cwd: path.resolve('tests/fixtures/next-validation') });
  const post = routes.find((route) => route.path === '/api/customers')?.methodsMetadata?.POST;
  assert.ok(post?.body, 'body should be inferred through named zod imports');

  const example = JSON.parse(post!.body!);
  const result = customerSchema.safeParse(example);
  assert.equal(result.success, true, JSON.stringify(result.success ? '' : result.error.issues));
  assert.equal(post!.bodySchema?.properties?.rut.pattern !== undefined, true);
  assert.equal(post!.bodySchema?.properties?.netPrice.minimum, 100);
});
