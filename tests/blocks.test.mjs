// node tests/blocks.test.mjs [output folder for the generated programs]
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { EXAMPLES, flatten, describe } from '../src/Client/blocks.js';
import { generate, blockCode } from '../src/Client/codegen.js';

// Pick & place: a repeat of 10 blocks, twice
const pick = flatten(EXAMPLES.pick());
assert.equal(pick.length, 20);
assert.deepEqual(pick[0], { id: pick[0].id, speed: 100, cnt: 0, type: 'linear_rel', v: [0, 0, -50, 0, 0, 0] });
assert.equal(pick[10].id, pick[0].id, 'the two passes of a loop point to the same block');
assert.deepEqual(pick[1], { id: pick[1].id, type: 'set_do', port: 1, on: true });
assert.equal(pick[3].cnt, 50);
pick.forEach(step => assert.ok(describe(step)));

// Palletizing 2 x 2 x 2: 8 cells of 10 steps, the place moves follow the cell
const pallet = flatten(EXAMPLES.pallet([500, 0, 400, 180, 0, 0]));
assert.equal(pallet.length, 80);
const places = pallet.filter((_, i) => i % 10 === 6).map(s => s.v.slice(0, 3));
assert.deepEqual(places, [
  [500, 120, 280], [560, 120, 280], [500, 180, 280], [560, 180, 280],
  [500, 120, 320], [560, 120, 320], [500, 180, 320], [560, 180, 320],
]);
assert.ok(pallet.filter((_, i) => i % 10 === 1).every(s => s.v.join() === '500,0,320,180,0,0'), 'the pick position does not move');

// A repeat inside a repeat, and what is refused
const nested = EXAMPLES.pick();
const loop = nested.blocks.blocks[0].inputs.BODY.block;
nested.blocks.blocks[0].inputs.BODY.block = { type: 'repeat', id: 'outer', fields: { TIMES: 3 }, inputs: { DO: { block: loop } } };
assert.equal(flatten(nested).length, 60);
assert.throws(() => flatten({ blocks: { blocks: [] } }), /no "Robot program"/);
assert.throws(() => flatten({ blocks: { blocks: [{ type: 'rmi_program', id: 'p' }] } }), /empty/);
loop.fields.TIMES = 1000;
assert.throws(() => flatten(nested), /more than 2000 steps/);
loop.fields.TIMES = 2;

// The generated programs: every block is there, in both languages
for (const lang of ['csharp', 'python']) {
  const code = generate(EXAMPLES.pallet([500, 0, 400, 180, 0, 0]), lang, '192.168.0.1', 10);
  assert.equal(code.match(/CartesianPositionWithUserFrame\(/g).length, 6);
  assert.match(code, /120 \+ dy/);
  assert.ok(blockCode(loop, lang).includes(lang === 'csharp' ? 'for (int i = 0; i < 2; i++)' : 'for i in range(2):'));
  if (process.argv[2]) {
    writeFileSync(`${process.argv[2]}/pallet.${lang === 'csharp' ? 'cs' : 'py'}`, code);
    writeFileSync(`${process.argv[2]}/nested.${lang === 'csharp' ? 'cs' : 'py'}`, generate(nested, lang, '192.168.0.1', 10));
  }
}
console.log('blocks and codegen OK');
