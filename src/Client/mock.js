// Demo mode: a simulated robot in the browser, with the same interface as the REST client of app.js.
// It lets a visitor try the page before a backend runs on the PC. Nothing here talks to a robot.

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function createMock() {
  const position = { cartesian: [500, 0, 400, 180, 0, 0], joints: [0, 20, -30, 0, -60, 0], tool: 1, frame: 0 };
  let run = { state: 'idle', error: null, steps: [] };
  let runId = 0, override = 10;

  async function play(steps, id) {
    const stopped = () => id !== runId;
    for (let i = 0; i < steps.length && !stopped(); i++) {
      // Like the SDK: 8 instructions in the buffer of the controller, the others wait on the PC
      run.steps.forEach((s, k) => { if (k > i) s.status = k - i < 8 ? 'ControllerQueued' : 'LocalQueued'; });
      run.steps[i].status = 'Executing';
      const step = steps[i], from = step.type === 'joint' ? position.joints : position.cartesian;
      const to = step.type === 'joint' ? step.v : step.type === 'linear' ? step.v : step.type === 'linear_rel' ? from.map((x, k) => x + step.v[k]) : from;
      const distance = Math.hypot(...to.slice(0, 3).map((x, k) => x - from[k]));
      const seconds = step.type === 'wait' ? Math.min(step.seconds, 3)
        : step.type === 'joint' ? 150 / (step.speed * override)
        : to === from ? 0.3 : distance / (step.speed * override / 100);
      const start = [...from], ticks = Math.max(1, Math.round(Math.min(Math.max(seconds, 0.2), 3) / 0.05));
      for (let t = 1; t <= ticks && !stopped(); t++) {
        while (run.state === 'paused' && !stopped()) await sleep(50);
        await sleep(50);
        to.forEach((x, k) => { from[k] = start[k] + (x - start[k]) * t / ticks; });
      }
      if (!stopped()) run.steps[i].status = 'Completed';
    }
    if (!stopped()) run.state = 'done';
  }

  return {
    demo: true,
    info: async () => ({ backend: 'demo', license: {}, config: {} }),
    saveConfig: async () => { throw new Error('Start a backend to save settings'); },
    connect: async () => { },
    disconnect: async () => { },
    state: async () => ({
      connected: true,
      controller: { servoReady: true, tpEnabled: false, rmiRunning: run.state === 'running', override, hold: false, singleStep: false, lastError: null, rmiVersion: 'demo' },
      position: structuredClone(position),
      run: structuredClone(run),
    }),
    run: async (steps, percent) => {
      override = percent;
      run = { state: 'running', error: null, steps: steps.map(s => ({ id: s.id, status: 'Pending', error: null })) };
      play(steps, ++runId);
    },
    pause: async () => { if (run.state === 'running') run.state = 'paused'; },
    continue: async () => { if (run.state === 'paused') run.state = 'running'; },
    abort: async () => { runId++; if (['running', 'paused'].includes(run.state)) run.state = 'aborted'; },
    reset: async () => { },
  };
}
