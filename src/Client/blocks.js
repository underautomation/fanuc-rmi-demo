// The blocks of the editor, and how a workspace becomes the flat list of steps sent to the backend.
// Everything here works on the JSON saved by Blockly, so it also runs in Node: see blocks.test.mjs

const num = (name, value, min, max, precision = 0.001) => ({ type: 'field_number', name, value, min, max, precision });
const TERM = { type: 'field_dropdown', name: 'CNT', options: [['FINE', '0'], ['CNT 25', '25'], ['CNT 50', '50'], ['CNT 100', '100']] };
const ON_OFF = { type: 'field_dropdown', name: 'VALUE', options: [['ON', 'ON'], ['OFF', 'OFF']] };
const statement = { previousStatement: null, nextStatement: null };

export const BLOCKS = [
  {
    type: 'rmi_program', message0: 'Robot program %1 %2', colour: 30,
    args0: [{ type: 'input_dummy' }, { type: 'input_statement', name: 'BODY' }],
    tooltip: 'The sequence that runs on the robot',
  },
  {
    type: 'move_joint', ...statement, colour: 210,
    message0: 'Move joint to  J1 %1 J2 %2 J3 %3 J4 %4 J5 %5 J6 %6 %7 at %8 %%  %9',
    args0: [...[1, 2, 3, 4, 5, 6].map(i => num('J' + i, 0, -360, 360)), { type: 'input_dummy' }, num('SPEED', 10, 1, 100, 1), TERM],
    tooltip: 'Joint motion to joint angles in degrees (JointMotionJRepTpInstruction)',
  },
  {
    type: 'move_linear', ...statement, colour: 210,
    message0: 'Move linear to  X %1 Y %2 Z %3 %4 W %5 P %6 R %7 %8 at %9 mm/s  %10  + pallet offset %11',
    args0: [num('X', 500), num('Y', 0), num('Z', 400), { type: 'input_dummy' }, num('W', 180), num('P', 0), num('R', 0), { type: 'input_dummy' },
      num('SPEED', 100, 1, 2000, 1), TERM, { type: 'field_checkbox', name: 'PALLET', checked: false }],
    tooltip: 'Linear motion to a Cartesian position, in the active tool and user frame (LinearMotionTpInstruction)',
  },
  {
    type: 'move_relative', ...statement, colour: 210,
    message0: 'Move linear by  X %1 Y %2 Z %3 mm at %4 mm/s  %5',
    args0: [num('X', 0), num('Y', 0), num('Z', 50), num('SPEED', 100, 1, 2000, 1), TERM],
    tooltip: 'Linear motion relative to the current position (LinearRelativeTpInstruction)',
  },
  {
    type: 'wait_time', ...statement, colour: 160, message0: 'Wait %1 s', args0: [num('SECONDS', 0.5, 0, 3600)],
    tooltip: 'WAIT instruction (WaitTimeTpInstruction)',
  },
  {
    type: 'wait_di', ...statement, colour: 160, message0: 'Wait until DI[ %1 ] is %2', args0: [num('PORT', 1, 1, 32767, 1), ON_OFF],
    tooltip: 'Waits for a digital input (WaitDinTpInstruction)',
  },
  {
    type: 'set_do', ...statement, colour: 160, message0: 'Set DO[ %1 ] %2', args0: [num('PORT', 1, 1, 32767, 1), ON_OFF],
    tooltip: 'Writes a digital output, a gripper for example (WriteDOUT)',
  },
  {
    type: 'repeat', ...statement, colour: 120, message0: 'Repeat %1 times %2 %3',
    args0: [num('TIMES', 2, 1, 1000, 1), { type: 'input_dummy' }, { type: 'input_statement', name: 'DO' }],
  },
  {
    type: 'pallet', ...statement, colour: 120,
    message0: 'For each cell of a pallet  %1 rows × %2 columns × %3 layers %4 pitch  X %5 Y %6 Z %7 mm %8 %9',
    args0: [num('ROWS', 2, 1, 50, 1), num('COLS', 2, 1, 50, 1), num('LAYERS', 1, 1, 50, 1), { type: 'input_dummy' },
      num('DX', 100), num('DY', 100), num('DZ', 50), { type: 'input_dummy' }, { type: 'input_statement', name: 'DO' }],
    tooltip: 'Runs the blocks inside once per cell. The moves with "+ pallet offset" are shifted to the cell.',
  },
];

export const TOOLBOX = {
  kind: 'categoryToolbox',
  contents: [
    { kind: 'category', name: 'Motion', colour: 210, contents: ['move_relative', 'move_linear', 'move_joint'].map(type => ({ kind: 'block', type })) },
    { kind: 'category', name: 'Wait & I/O', colour: 160, contents: ['wait_time', 'wait_di', 'set_do'].map(type => ({ kind: 'block', type })) },
    { kind: 'category', name: 'Loops', colour: 120, contents: ['repeat', 'pallet'].map(type => ({ kind: 'block', type })) },
  ],
};

export const MAX_STEPS = 2000;
const checked = value => value === true || value === 'TRUE';

/** The cells of a pallet block, layer by layer: [{ x, y, z }] in mm */
export function palletCells(f) {
  const cells = [];
  for (let layer = 0; layer < f.LAYERS; layer++)
    for (let row = 0; row < f.ROWS; row++)
      for (let col = 0; col < f.COLS; col++)
        cells.push({ x: col * f.DX, y: row * f.DY, z: layer * f.DZ });
  return cells;
}

/**
 * Saved workspace -> flat list of steps for POST /api/run. Loops are unrolled and pallet offsets applied here,
 * so a backend only translates one step into one call of the SDK.
 */
export function flatten(saved) {
  const program = saved?.blocks?.blocks?.find(b => b.type === 'rmi_program');
  if (!program) throw new Error('The workspace has no "Robot program" block');
  const steps = [];
  walk(program.inputs?.BODY?.block, { x: 0, y: 0, z: 0 });
  if (!steps.length) throw new Error('The robot program is empty: drag blocks into it');
  return steps;

  function walk(block, offset) {
    for (; block; block = block.next?.block) {
      const f = block.fields ?? {}, id = block.id;
      if (block.enabled === false || block.disabledReasons?.length) continue;
      const motion = { id, speed: Math.round(f.SPEED), cnt: Number(f.CNT) };
      switch (block.type) {
        case 'move_joint': steps.push({ ...motion, type: 'joint', v: [f.J1, f.J2, f.J3, f.J4, f.J5, f.J6] }); break;
        case 'move_linear': {
          const o = checked(f.PALLET) ? offset : { x: 0, y: 0, z: 0 };
          steps.push({ ...motion, type: 'linear', v: [f.X + o.x, f.Y + o.y, f.Z + o.z, f.W, f.P, f.R] });
          break;
        }
        case 'move_relative': steps.push({ ...motion, type: 'linear_rel', v: [f.X, f.Y, f.Z, 0, 0, 0] }); break;
        case 'wait_time': steps.push({ id, type: 'wait', seconds: f.SECONDS }); break;
        case 'wait_di': steps.push({ id, type: 'wait_di', port: f.PORT, on: f.VALUE === 'ON' }); break;
        case 'set_do': steps.push({ id, type: 'set_do', port: f.PORT, on: f.VALUE === 'ON' }); break;
        case 'repeat': for (let i = 0; i < f.TIMES; i++) walk(block.inputs?.DO?.block, offset); break;
        case 'pallet': for (const cell of palletCells(f)) walk(block.inputs?.DO?.block, cell); break;
      }
      if (steps.length > MAX_STEPS) throw new Error(`The sequence has more than ${MAX_STEPS} steps`);
    }
  }
}

/** One line of text per step, for the list of steps and the confirmation before a run */
export function describe(step) {
  const term = step.cnt ? `CNT${step.cnt}` : 'FINE';
  const v = (step.v ?? []).map(n => +n.toFixed(1));
  switch (step.type) {
    case 'joint': return `J  [${v.join(', ')}]°  ${step.speed}%  ${term}`;
    case 'linear': return `L  X${v[0]} Y${v[1]} Z${v[2]}  ${step.speed}mm/s  ${term}`;
    case 'linear_rel': return `L  +(${v[0]}, ${v[1]}, ${v[2]})  ${step.speed}mm/s  ${term}`;
    case 'wait': return `WAIT ${step.seconds}s`;
    case 'wait_di': return `WAIT DI[${step.port}]=${step.on ? 'ON' : 'OFF'}`;
    case 'set_do': return `DO[${step.port}]=${step.on ? 'ON' : 'OFF'}`;
  }
}

// ---------------------------------------------------------------- examples
let nextId = 0;
const block = (type, fields = {}, extra = {}) => ({ type, id: `ex${nextId++}`, fields, ...extra });
/** Chains blocks with their "next" connection */
const chain = blocks => blocks.reduceRight((next, b) => ({ ...b, ...(next && { next: { block: next } }) }), null);
const program = body => ({ blocks: { languageVersion: 0, blocks: [{ ...block('rmi_program', {}, { x: 30, y: 30, deletable: false }), inputs: { BODY: { block: chain(body) } } }] } });
const rel = (X, Y, Z, SPEED, CNT = '0') => block('move_relative', { X, Y, Z, SPEED, CNT });
const output = VALUE => block('set_do', { PORT: 1, VALUE });
const wait = SECONDS => block('wait_time', { SECONDS });

export const EXAMPLES = {
  /** Only relative moves, around the current position: safe to try on any robot */
  pick: () => program([
    block('repeat', { TIMES: 2 }, {
      inputs: {
        DO: {
          block: chain([
            rel(0, 0, -50, 100), output('ON'), wait(0.3), rel(0, 0, 50, 200, '50'),
            rel(0, 100, 0, 200, '50'),
            rel(0, 0, -50, 100), output('OFF'), wait(0.3), rel(0, 0, 50, 200, '50'),
            rel(0, -100, 0, 200),
          ]),
        },
      },
    }),
  ]),

  /** Picks at a fixed place and fills a 2 x 2 x 2 pallet, built around the given position [x, y, z, w, p, r] */
  pallet: ([x, y, z, w, p, r]) => {
    const round = n => Math.round(n * 10) / 10;
    const lin = (X, Y, Z, SPEED, CNT, PALLET = false) =>
      block('move_linear', { X: round(X), Y: round(Y), Z: round(Z), W: round(w), P: round(p), R: round(r), SPEED, CNT, PALLET });
    const [pickZ, placeY, placeZ] = [z - 80, y + 120, z - 120];
    return program([
      block('pallet', { ROWS: 2, COLS: 2, LAYERS: 2, DX: 60, DY: 60, DZ: 40 }, {
        inputs: {
          DO: {
            block: chain([
              lin(x, y, z, 300, '50'), lin(x, y, pickZ, 100, '0'), output('ON'), wait(0.2), lin(x, y, z, 300, '50'),
              lin(x, placeY, z, 300, '50', true), lin(x, placeY, placeZ, 100, '0', true), output('OFF'), wait(0.2), lin(x, placeY, z, 300, '50', true),
            ]),
          },
        },
      }),
    ]);
  },
};
