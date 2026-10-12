// What to check on the robot when something fails. One place for the whole page.

/** A failed connection, by the code of the backend */
export const CONNECT_HINTS = {
  unreachable: [
    'No answer from this address.',
    'Check the IP address: on the teach pendant, MENU > SETUP > Host Comm > TCP/IP.',
    'Check the Ethernet cable, and that your PC is on the same subnet as the robot.',
  ],
  no_rmi: [
    'The robot answers, but nothing listens on the RMI port (TCP 16001).',
    'The option R912 "Remote Motion Interface" is probably not installed: MENU > STATUS > Version ID > ORDER FI lists the options.',
    'If it was just installed, restart the controller. A firewall between your PC and the robot must let the port 16001 through.',
  ],
  busy: [
    'The controller does not serve this RMI session.',
    'Another RMI session is probably open: another backend of this demo, or another application. Close it, or restart the controller.',
  ],
  refused: [
    'The controller refused the RMI session.',
    'Reset the alarms on the teach pendant, abort the programs (FCTN > ABORT ALL), then connect again.',
  ],
  license: [
    'The trial period of the SDK is over on this PC.',
    'Enter your license key in Settings, or get one on underautomation.com/fanuc.',
  ],
  error: ['The connection failed.'],
};

/** A sequence that failed: hints from the message of the controller */
export function runHints(message = '') {
  if (/7015|selected TP program/i.test(message)) return [
    'RMI_MOVE is the program selected on the teach pendant.',
    'On the pendant: FCTN > ABORT (ALL), then SELECT another program, and run again.',
  ];
  if (/MOTN-0?1[78]|MOTN-023|limit|not reachable/i.test(message)) return [
    'A target is out of reach of the robot, or on a singularity.',
    'Correct the position, then run again: the alarm is reset and the RMI session restarted. "Use current position" copies a position that the robot can reach.',
  ];
  if (/2556943|Invalid controller state|2556937|not running/i.test(message)) return [
    'The controller is not ready for RMI.',
    'Check that the mode switch is on AUTO, the teach pendant switch is OFF and no alarm is active, then press Reset.',
    'If it still fails: FCTN > ABORT (ALL) on the pendant, and SELECT another program than RMI_MOVE.',
  ];
  if (/SRVO-00[1-7]|SRVO-037|emergency|fence|deadman/i.test(message)) return [
    'A safety input stops the robot: emergency stop, fence or enabling device.',
    'Release it, then press Reset.',
  ];
  return ['Press Reset to clear the alarm, then run again. The alarm is also shown on the teach pendant.'];
}

/** The checklist of a connected robot: [{ ok, text, fix }] from the controller part of GET /api/state */
export function readiness(controller) {
  const alarm = controller.lastError ? ` Last alarm: ${controller.lastError}.` : '';
  return [
    { ok: true, text: `Connected, RMI protocol v${controller.rmiVersion}` },
    { ok: !controller.tpEnabled, text: 'Teach pendant disabled', fix: 'Turn the switch of the teach pendant to OFF.' },
    { ok: controller.servoReady, text: 'Servos ready, no alarm', fix: `Release the emergency stops, then press Reset.${alarm}` },
    { ok: !controller.hold, text: 'Not in HOLD', fix: `The controller holds the motion after an error: press Reset.${alarm}` },
    { ok: !controller.singleStep, text: 'Step mode off', fix: 'Press the STEP key of the teach pendant to leave the single step mode.' },
    { ok: null, text: 'Mode switch on AUTO', fix: 'RMI cannot read the mode switch: check it on the controller.' },
  ];
}
