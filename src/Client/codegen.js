// Turns the blocks into the program a developer would write with the UnderAutomation Fanuc SDK, in C# and in Python.
// Works on the JSON saved by Blockly, like blocks.js.

const n = value => String(+(+value).toFixed(3));
const checked = value => value === true || value === 'TRUE';
/** X + dx when the block follows the pallet, X otherwise */
const shifted = (f, pallet) => ['X', 'Y', 'Z'].map(axis => n(f[axis]) + (pallet ? ` + d${axis.toLowerCase()}` : ''));

// Python: one module per class
const PY_MODULES = {
  JointMotionJRepTpInstruction: 'rmi.tp_instructions.joint_motion_j_rep_tp_instruction',
  LinearMotionTpInstruction: 'rmi.tp_instructions.linear_motion_tp_instruction',
  LinearRelativeTpInstruction: 'rmi.tp_instructions.linear_relative_tp_instruction',
  WaitTimeTpInstruction: 'rmi.tp_instructions.wait_time_tp_instruction',
  WaitDinTpInstruction: 'rmi.tp_instructions.wait_din_tp_instruction',
  RmiJointSpeedType: 'rmi.data.rmi_joint_speed_type',
  RmiLinearSpeedType: 'rmi.data.rmi_linear_speed_type',
  RmiTerminationType: 'rmi.data.rmi_termination_type',
  RmiOnOff: 'rmi.data.rmi_on_off',
  CartesianPositionWithUserFrame: 'common.cartesian_position_with_user_frame',
  JointsPosition: 'common.joints_position',
};

const EMIT = {
  csharp: {
    motion(cls, speedType, f, target) {
      const term = +f.CNT ? `TermType = RmiTerminationType.Cnt, TermValue = ${+f.CNT}` : 'TermType = RmiTerminationType.Fine';
      return [
        `robot.Rmi.SendTpInstruction(new ${cls}`,
        '{',
        `    SpeedType = ${speedType}, Speed = ${n(f.SPEED)}, ${term},`,
        `    ${target}`,
        '});',
      ];
    },
    joints: f => `Joints = new JointsPosition(${[1, 2, 3, 4, 5, 6].map(i => n(f['J' + i])).join(', ')})`,
    target: xyzwpr => `Target = new CartesianPositionWithUserFrame(${xyzwpr.join(', ')}, active.Tool, active.Frame)`,
    wait: f => [`robot.Rmi.SendTpInstruction(new WaitTimeTpInstruction { Seconds = ${n(f.SECONDS)} });`],
    waitDi: f => [`robot.Rmi.SendTpInstruction(new WaitDinTpInstruction { PortNumber = ${f.PORT}, Value = RmiOnOff.${f.VALUE} });`],
    setDo: f => ['WaitAll(); // an output is written at once: let the motions before it finish', `robot.Rmi.WriteDOUT(${f.PORT}, RmiOnOff.${f.VALUE});`],
    repeat: (f, v, body) => [`for (int ${v} = 0; ${v} < ${f.TIMES}; ${v}++)`, '{', ...indent(body), '}'],
    pallet: (f, body) => [
      `for (int layer = 0; layer < ${f.LAYERS}; layer++)`,
      `for (int row = 0; row < ${f.ROWS}; row++)`,
      `for (int col = 0; col < ${f.COLS}; col++)`,
      '{',
      `    double dx = col * ${n(f.DX)}, dy = row * ${n(f.DY)}, dz = layer * ${n(f.DZ)}; // position of the cell on the pallet`,
      ...indent(body),
      '}',
    ],
  },

  python: {
    motion(cls, speedType, f, target) {
      const cnt = +f.CNT;
      return [
        `move = ${cls}()`,
        `move.speed_type = ${speedType}`,
        `move.speed = ${n(f.SPEED)}`,
        `move.term_type = RmiTerminationType.${cnt ? 'Cnt' : 'Fine'}`,
        ...(cnt ? [`move.term_value = ${cnt}`] : []),
        `move.${target}`,
        'robot.rmi.send_tp_instruction(move)',
      ];
    },
    joints: f => `joints = JointsPosition(${[1, 2, 3, 4, 5, 6].map(i => n(f['J' + i])).join(', ')})`,
    target: xyzwpr => `target = CartesianPositionWithUserFrame(${xyzwpr.join(', ')}, active.tool, active.frame)`,
    wait: f => ['wait = WaitTimeTpInstruction()', `wait.seconds = ${n(f.SECONDS)}`, 'robot.rmi.send_tp_instruction(wait)'],
    waitDi: f => ['wait = WaitDinTpInstruction()', `wait.port_number = ${f.PORT}`, `wait.value = RmiOnOff.${f.VALUE}`, 'robot.rmi.send_tp_instruction(wait)'],
    setDo: f => ['wait_all()  # an output is written at once: let the motions before it finish', `robot.rmi.write_dout(${f.PORT}, RmiOnOff.${f.VALUE})`],
    repeat: (f, v, body) => [`for ${v} in range(${f.TIMES}):`, ...indent(body.length ? body : ['pass'])],
    pallet: (f, body) => [
      `for layer in range(${f.LAYERS}):`,
      `    for row in range(${f.ROWS}):`,
      `        for col in range(${f.COLS}):`,
      ...indent([
        `dx, dy, dz = col * ${n(f.DX)}, row * ${n(f.DY)}, layer * ${n(f.DZ)}  # position of the cell on the pallet`,
        ...body,
      ], 3),
    ],
  },
};

function indent(lines, levels = 1) {
  return lines.map(line => (line ? '    '.repeat(levels) + line : line));
}

/** The lines of a chain of blocks. used collects the SDK classes, for the imports of Python. */
function emitChain(block, lang, used, depth = 0, inPallet = false) {
  const lines = [];
  for (; block; block = block.next?.block) {
    if (block.enabled === false || block.disabledReasons?.length) continue;
    if (lines.length) lines.push('');
    lines.push(...emitBlock(block, lang, used, depth, inPallet));
  }
  return lines;
}

function emitBlock(block, lang, used, depth = 0, inPallet = false) {
  const e = EMIT[lang], f = block.fields ?? {};
  const use = (...classes) => classes.forEach(c => used.add(c));
  const motion = (cls, speedType, target) => {
    use(cls, speedType.split('.')[0], 'RmiTerminationType');
    return e.motion(cls, speedType, f, target);
  };
  switch (block.type) {
    case 'move_joint':
      use('JointsPosition');
      return motion('JointMotionJRepTpInstruction', 'RmiJointSpeedType.Percent', e.joints(f));
    case 'move_linear':
      use('CartesianPositionWithUserFrame');
      return motion('LinearMotionTpInstruction', 'RmiLinearSpeedType.MmSec',
        e.target([...shifted(f, checked(f.PALLET) && inPallet), n(f.W), n(f.P), n(f.R)]));
    case 'move_relative':
      use('CartesianPositionWithUserFrame');
      return motion('LinearRelativeTpInstruction', 'RmiLinearSpeedType.MmSec', e.target([n(f.X), n(f.Y), n(f.Z), 0, 0, 0]));
    case 'wait_time': use('WaitTimeTpInstruction'); return e.wait(f);
    case 'wait_di': use('WaitDinTpInstruction', 'RmiOnOff'); return e.waitDi(f);
    case 'set_do': use('RmiOnOff', 'waitAll'); return e.setDo(f);
    case 'repeat': return e.repeat(f, 'ijk'[depth] ?? `i${depth}`, emitChain(block.inputs?.DO?.block, lang, used, depth + 1, inPallet));
    case 'pallet': return e.pallet(f, emitChain(block.inputs?.DO?.block, lang, used, depth, true));
    case 'rmi_program': return emitChain(block.inputs?.BODY?.block, lang, used);
    default: return [];
  }
}

/** The SDK code of one block, for its "Show SDK code" pop-up */
export function blockCode(block, lang) {
  return emitBlock(block, lang, new Set()).join('\n');
}

/** A complete program, ready to paste in a C# or Python project */
export function generate(saved, lang, ip, override) {
  const used = new Set();
  const program = saved?.blocks?.blocks?.find(b => b.type === 'rmi_program');
  const body = program ? emitBlock(program, lang, used) : [];
  ip = ip || '192.168.0.1';

  if (lang === 'csharp') {
    return [
      'using UnderAutomation.Fanuc;',
      'using UnderAutomation.Fanuc.Common;',
      'using UnderAutomation.Fanuc.Rmi.Data;',
      'using UnderAutomation.Fanuc.Rmi.TpInstructions;',
      '',
      '// Connect with the Remote Motion Interface (controller option R912)',
      'var robot = new FanucRobot();',
      `var parameters = new ConnectionParameters("${ip}");`,
      'parameters.Rmi.Enable = true;',
      'robot.Connect(parameters);',
      '',
      '// Start the RMI_MOVE program: controller in AUTO, teach pendant disabled',
      'robot.Rmi.Initialize();',
      `robot.Rmi.SetOverride(${override});`,
      'var active = robot.Rmi.GetUFrameUTool();',
      '',
      ...body,
      '',
      '// Wait for the end of the sequence, then always end the session',
      'WaitAll();',
      'robot.Rmi.Abort();',
      'robot.Disconnect();',
      '',
      'void WaitAll()',
      '{',
      '    foreach (var sent in robot.Rmi.Instructions) sent.WaitForCompletion();',
      '}',
    ].join('\n');
  }

  const imports = [...used].filter(c => PY_MODULES[c]).sort((a, b) => PY_MODULES[a].localeCompare(PY_MODULES[b]))
    .map(c => `from underautomation.fanuc.${PY_MODULES[c]} import ${c}`);
  return [
    'from underautomation.fanuc.fanuc_robot import FanucRobot',
    'from underautomation.fanuc.connection_parameters import ConnectionParameters',
    ...imports,
    '',
    '# Connect with the Remote Motion Interface (controller option R912)',
    'robot = FanucRobot()',
    `parameters = ConnectionParameters("${ip}")`,
    'parameters.rmi.enable = True',
    'robot.connect(parameters)',
    '',
    '',
    'def wait_all():',
    '    for sent in robot.rmi.instructions:',
    '        sent.wait_for_completion()',
    '',
    '',
    '# Start the RMI_MOVE program: controller in AUTO, teach pendant disabled',
    'robot.rmi.initialize()',
    `robot.rmi.set_override(${override})`,
    'active = robot.rmi.get_u_frame_u_tool()',
    '',
    ...body,
    '',
    '# Wait for the end of the sequence, then always end the session',
    'wait_all()',
    'robot.rmi.abort()',
    'robot.disconnect()',
  ].join('\n');
}

