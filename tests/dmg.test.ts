import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createDmg, detachDmg } from '../scripts/desktop/dmg.ts';

const busy = () =>
  Object.assign(new Error('hdiutil exited with 1'), {
    stderr: 'hdiutil: create failed - Resource busy\n',
  });

test('DMG creation retries Resource busy, removing partial images before each attempt', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'printwitness-dmg-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const destination = join(root, 'output.dmg');
  await writeFile(destination, 'previous image');
  let attempts = 0;
  const delays: number[] = [];
  await createDmg(
    root,
    destination,
    async (args) => {
      assert.deepEqual(args, [
        'create',
        '-volname',
        'PrintWitness',
        '-srcfolder',
        root,
        '-format',
        'UDZO',
        destination,
      ]);
      await assert.rejects(stat(destination), { code: 'ENOENT' });
      attempts++;
      await writeFile(destination, attempts === 3 ? 'complete' : 'partial');
      if (attempts < 3) throw busy();
      return { stdout: '', stderr: '' };
    },
    async (ms) => {
      delays.push(ms);
    },
  );
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [1000, 2000]);
  assert.equal(await readFile(destination, 'utf8'), 'complete');
});

for (const [name, error, expectedAttempts] of [
  ['persistent Resource busy', busy(), 3],
  [
    'a different hdiutil failure',
    Object.assign(new Error('failed'), {
      stderr: 'hdiutil: create failed - No space left on device',
    }),
    1,
  ],
  ['a process launch failure', Object.assign(new Error('spawn failed'), { code: 'ENOENT' }), 1],
] as const) {
  test(`DMG creation propagates ${name}`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'printwitness-dmg-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    let attempts = 0;
    await assert.rejects(
      createDmg(
        root,
        join(root, 'output.dmg'),
        async () => {
          attempts++;
          await writeFile(join(root, 'output.dmg'), 'partial');
          throw error;
        },
        async () => {},
      ),
      (actual) => actual === error,
    );
    assert.equal(attempts, expectedAttempts);
    await assert.rejects(stat(join(root, 'output.dmg')), { code: 'ENOENT' });
  });
}

test('DMG detach retries Resource busy and then forces the unmount', async () => {
  const calls: string[][] = [];
  const delays: number[] = [];
  await detachDmg(
    '/mount',
    async (args) => {
      calls.push(args);
      if (!args.includes('-force'))
        throw Object.assign(new Error('exit 16'), {
          stderr: 'hdiutil: couldn\'t unmount "disk3" - Resource busy\n',
        });
    },
    async (ms) => {
      delays.push(ms);
    },
  );
  assert.deepEqual(calls, [
    ['detach', '/mount'],
    ['detach', '/mount'],
    ['detach', '/mount'],
    ['detach', '-force', '/mount'],
  ]);
  assert.deepEqual(delays, [1000, 2000, 3000]);
});

test('DMG detach succeeds after a transient busy volume without forcing', async () => {
  let attempts = 0;
  await detachDmg(
    '/mount',
    async (args) => {
      assert(!args.includes('-force'));
      if (++attempts < 2) throw Object.assign(new Error('exit 16'), { stderr: 'Resource busy' });
    },
    async () => {},
  );
  assert.equal(attempts, 2);
});

test('DMG detach does not retry other failures', async () => {
  const error = Object.assign(new Error('exit 1'), {
    stderr: 'hdiutil: detach failed - No such file',
  });
  let attempts = 0;
  await assert.rejects(
    detachDmg(
      '/mount',
      async () => {
        attempts++;
        throw error;
      },
      async () => {},
    ),
    (actual) => actual === error,
  );
  assert.equal(attempts, 1);
});
