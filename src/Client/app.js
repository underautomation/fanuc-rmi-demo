// The page: Blockly editor, REST client of the backend (.NET or Python, same API), live state of the robot.
/* global Blockly */
import { BLOCKS, TOOLBOX, EXAMPLES, flatten, describe } from './blocks.js';
import { generate, blockCode } from './codegen.js';
import { SNIPPETS } from './snippets.js';
import { CONNECT_HINTS, runHints, readiness } from './hints.js';
import { createMock } from './mock.js';

const LOCAL_BACKEND = 'http://localhost:16080';
const $ = id => document.getElementById(id);
const escape = text => String(text).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const store = {
  get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private window */ } },
};

// ---------------------------------------------------------------- backend
function createRest(base) {
  const call = async (method, path, body) => {
    const response = await fetch(`${base}/api${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body && JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(data.error ?? `HTTP ${response.status}`), { code: data.code });
    return data;
  };
  return {
    info: () => call('GET', '/info'),
    saveConfig: config => call('PUT', '/config', config),
    connect: ip => call('POST', '/connect', { ip }),
    disconnect: () => call('POST', '/disconnect'),
    state: () => call('GET', '/state'),
    run: (steps, override) => call('POST', '/run', { steps, override }),
    pause: () => call('POST', '/pause'),
    continue: () => call('POST', '/continue'),
    abort: () => call('POST', '/abort'),
    reset: () => call('POST', '/reset'),
  };
}

/** A backend serves this page, or runs on this PC. Otherwise: demo mode. */
async function detectBackend() {
  for (const base of new Set([location.origin, LOCAL_BACKEND])) {
    try {
      const response = await fetch(`${base}/api/info`, { signal: AbortSignal.timeout(1500) });
      const info = await response.json();
      if (info.backend) return { client: createRest(base), info };
    } catch { /* next */ }
  }
  return null;
}

let client = createMock();
let info = { backend: 'demo', license: {}, config: {} };
let state = { connected: false, run: { state: 'idle', steps: [] } };
let connectError = null;   // { message, code } of the last failed connection
let actionError = null;    // message of the last failed button
let sentSteps = null;      // the steps of the last run, shown with their status until the blocks change
let failedPolls = 0;

async function useBackend(found) {
  client = found ? found.client : createMock();
  info = found ? found.info : await client.info();
  connectError = null;
  if (found && info.config.ip) $('ip').value = info.config.ip;
  render();
}

// ---------------------------------------------------------------- editor
Blockly.common.defineBlocksWithJsonArray(BLOCKS);
const workspace = Blockly.inject('blockly', {
  toolbox: TOOLBOX,
  renderer: 'zelos',
  trashcan: true,
  move: { scrollbars: true, drag: true, wheel: true },
  zoom: { controls: true, startScale: 0.8, minScale: 0.4, maxScale: 1.5 },
  grid: { spacing: 24, length: 2, colour: '#d7dce3', snap: true },
});
const save = () => Blockly.serialization.workspaces.save(workspace);
const load = saved => { Blockly.serialization.workspaces.load(saved, workspace); workspace.scroll(0, 0); };

try { load(store.get('workspace') ?? EXAMPLES.pick()); } catch { load(EXAMPLES.pick()); }

workspace.addChangeListener(event => {
  if (event.isUiEvent) return;
  store.set('workspace', save());
  if (!['running', 'paused'].includes(state.run.state)) sentSteps = null;
  renderSteps();
  renderCode();
});

Blockly.ContextMenuRegistry.registry.register({
  id: 'show_sdk_code',
  weight: 0,
  scopeType: Blockly.ContextMenuRegistry.ScopeType.BLOCK,
  displayText: 'Show SDK code',
  preconditionFn: () => 'enabled',
  callback: scope => {
    const block = Blockly.serialization.blocks.save(scope.block, { addNextBlocks: false });
    showCode({
      title: scope.block.type === 'rmi_program' ? 'Robot program' : 'This block, with the SDK',
      text: scope.block.getTooltip() || 'The code of this block and of the blocks inside it.',
      doc: 'https://underautomation.com/fanuc/documentation/rmi-motion',
      csharp: blockCode(block, 'csharp'),
      python: blockCode(block, 'python'),
    });
  },
});

function currentSteps() {
  try { return { steps: flatten(save()) }; } catch (e) { return { steps: [], error: e.message }; }
}

// ---------------------------------------------------------------- rendering
const running = () => ['running', 'paused'].includes(state.run.state);
const demo = () => !!client.demo;

function render() {
  const badge = $('mode');
  badge.className = `badge ${demo() ? 'demo' : 'live'}`;
  const license = info.license.daysLeft != null ? `trial, ${info.license.daysLeft} days left` : info.license.state?.toLowerCase();
  badge.textContent = demo() ? 'Demo mode · simulated robot'
    : `${info.backend === 'dotnet' ? '.NET' : 'Python'} backend · SDK ${info.sdkVersion} · ${license}`;
  badge.title = demo() ? 'No backend found on this PC: click Connect to get one' : 'This backend drives the robot with the UnderAutomation Fanuc SDK';

  $('connect').textContent = !demo() && state.connected ? 'Disconnect' : 'Connect';
  $('ip').disabled = !demo() && state.connected;
  $('settings').hidden = demo();

  // Checklist: what the robot needs before it can move
  let items;
  if (demo()) {
    items = [
      { ok: true, text: 'Simulated robot, in your browser' },
      { ok: null, text: 'Not connected to a real robot', fix: 'Press Connect to download the .NET or the Python backend.' },
    ];
  } else if (state.connected) {
    items = readiness(state.controller);
  } else if (connectError) {
    const [title, ...fixes] = CONNECT_HINTS[connectError.code] ?? CONNECT_HINTS.error;
    items = [{ ok: false, text: title, fix: fixes.join(' '), detail: connectError.message }];
  } else {
    items = [{ ok: null, text: state.notice ?? 'Not connected', fix: 'Enter the IP address of the robot, then press Connect. The robot needs the option R912 (RMI).' }];
  }
  $('checklist').innerHTML = items.map(item => `
    <li class="${item.ok === true ? 'ok' : item.ok === false ? 'ko' : 'info'}">
      <span>${escape(item.text)}</span>
      ${item.ok !== true && item.fix ? `<small>${escape(item.fix)}</small>` : ''}
      ${item.detail ? `<small class="detail">${escape(item.detail)}</small>` : ''}
    </li>`).join('');

  const p = state.connected && state.position;
  $('position').innerHTML = p ? `
    <div>${['X', 'Y', 'Z', 'W', 'P', 'R'].map((axis, i) => `<span><i>${axis}</i>${p.cartesian[i].toFixed(1)}</span>`).join('')}</div>
    <div>${p.joints.map((j, i) => `<span><i>J${i + 1}</i>${j.toFixed(1)}</span>`).join('')}</div>
    <small>UTOOL ${p.tool} · UFRAME ${p.frame}</small>` : '';

  const ready = state.connected;
  $('run').disabled = !ready || running();
  $('pause').disabled = state.run.state !== 'running';
  $('continue').disabled = state.run.state !== 'paused';
  $('abort').disabled = !running();
  $('reset').disabled = !ready;
  $('teach').disabled = !ready;

  // Outcome of the last run, with what to do next
  const message = $('runMessage'), run = state.run;
  const failure = actionError ?? (run.state === 'error' ? run.error : null);
  message.hidden = !failure && !['done', 'aborted', 'paused'].includes(run.state);
  message.className = `message ${failure ? 'ko' : run.state === 'done' ? 'ok' : ''}`;
  message.innerHTML = failure
    ? `<b>${escape(failure)}</b>${(actionError ? [] : runHints(`${run.error} ${state.controller?.lastError ?? ''}`)).map(h => `<span>${escape(h)}</span>`).join('')}`
    : run.state === 'done' ? 'Sequence completed.' : run.state === 'aborted' ? 'Sequence aborted.' : 'Paused. Press Continue to resume.';

  renderSteps();
  // The block that the robot is executing
  const current = running() ? run.steps.find(s => !['Completed', 'Error'].includes(s.status)) : null;
  markRunning(current?.id);
}

let runningBlock = null;
/** Zelos only embosses a highlighted block: a class makes the running block obvious */
function markRunning(id) {
  const block = id ? workspace.getBlockById(id) : null;
  if (block === runningBlock) return;
  runningBlock?.getSvgRoot()?.classList.remove('running');
  block?.getSvgRoot().classList.add('running');
  runningBlock = block;
}

function renderSteps() {
  const preview = currentSteps();
  const steps = sentSteps ?? preview.steps;
  const status = sentSteps ? state.run.steps : [];
  const current = running() ? status.findIndex(s => !['Completed', 'Error'].includes(s.status)) : -1;
  const html = steps.length
    ? steps.map((step, i) => {
      const s = status[i]?.status ?? 'Pending';
      return `<li class="${s}${i === current ? ' current' : ''}" title="${escape(status[i]?.error ?? '')}"><code>${escape(describe(step))}</code><em>${s}</em></li>`;
    }).join('')
    : `<li class="empty">${escape(preview.error ?? '')}</li>`;
  const list = $('steps');
  if (list.innerHTML !== html) {
    list.innerHTML = html;
    list.querySelector('.current')?.scrollIntoView({ block: 'nearest' });
  }
}

// ---------------------------------------------------------------- code
let tab = 'steps';
let lang = store.get('lang', null); // of the pop-ups: the last tab chosen, else the language of the backend

function highlight(code, language) {
  const comment = language === 'python' ? /#.*$/ : /\/\/.*$/;
  const tokens = new RegExp(`(${comment.source})|("(?:[^"\\\\]|\\\\.)*")|\\b(var|new|for|foreach|in|int|double|bool|string|void|if|def|from|import|range|True|False|not|and|using)\\b|\\b(\\d+(?:\\.\\d+)?)\\b`, 'gm');
  return escape(code).replace(/&quot;/g, '"').replace(tokens, (m, c, s, k, n) =>
    c ? `<span class="c">${c}</span>` : s ? `<span class="s">${s}</span>` : k ? `<span class="k">${k}</span>` : `<span class="n">${n}</span>`);
}

function renderCode() {
  if (tab === 'steps') return;
  $('code').innerHTML = highlight(generate(save(), tab, $('ip').value.trim(), +$('override').value), tab);
}

function selectTab(name) {
  tab = name;
  document.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  $('steps').hidden = name !== 'steps';
  $('code').hidden = $('copyCode').hidden = name === 'steps';
  renderCode();
}
document.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => selectTab(b.dataset.tab)));

async function copy(button, text) {
  await navigator.clipboard.writeText(text);
  button.textContent = 'Copied';
  setTimeout(() => { button.textContent = 'Copy'; }, 1200);
}
$('copyCode').addEventListener('click', e => copy(e.target, $('code').textContent));

// The pop-up of a </> button or of a block
let shown = null;
function showCode(snippet) {
  shown = snippet;
  $('codeTitle').textContent = snippet.title;
  $('codeText').textContent = snippet.text;
  $('codeDoc').href = snippet.doc;
  showLang(lang ?? (info.backend === 'python' ? 'python' : 'csharp'));
  $('codeDialog').showModal();
}
function showLang(name) {
  document.querySelectorAll('[data-lang]').forEach(b => b.classList.toggle('active', b.dataset.lang === name));
  $('codeSnippet').innerHTML = highlight(shown[name], name);
}
document.querySelectorAll('[data-lang]').forEach(b => b.addEventListener('click', () => {
  lang = b.dataset.lang;
  store.set('lang', lang);
  showLang(lang);
}));
$('copySnippet').addEventListener('click', e => copy(e.target, $('codeSnippet').textContent));
document.addEventListener('click', e => {
  const button = e.target.closest('[data-snippet]');
  if (button) showCode(SNIPPETS[button.dataset.snippet]);
});

// ---------------------------------------------------------------- actions
/** Runs the action of a button, and shows its error next to the Run buttons */
async function act(action) {
  actionError = null;
  try { await action(); } catch (e) { actionError = e.message; }
  await poll();
}

$('connect').addEventListener('click', async () => {
  if (demo()) return $('backendDialog').showModal();
  const button = $('connect');
  button.disabled = true;
  connectError = null;
  try {
    if (state.connected) await client.disconnect();
    else {
      button.textContent = 'Connecting…';
      await client.connect($('ip').value.trim());
    }
  } catch (e) {
    connectError = { message: e.message, code: e.code };
  }
  button.disabled = false;
  await poll();
});
$('ip').addEventListener('keydown', e => { if (e.key === 'Enter') $('connect').click(); });
$('ip').addEventListener('input', renderCode);

$('retryBackend').addEventListener('click', async () => {
  const found = await detectBackend();
  const message = $('backendMessage');
  message.hidden = !!found;
  message.className = 'message ko';
  message.textContent = `No backend answers on ${LOCAL_BACKEND}. Is it started? Did your browser block the access to the local network?`;
  if (found) {
    await useBackend(found);
    $('backendDialog').close();
  }
});

$('override').addEventListener('input', () => {
  $('overrideValue').textContent = `${$('override').value} %`;
  renderCode();
});

$('run').addEventListener('click', async () => {
  const { steps, error } = currentSteps();
  if (error) { actionError = error; return render(); }
  const override = +$('override').value;
  if (!demo()) {
    const moves = steps.filter(s => ['joint', 'linear', 'linear_rel'].includes(s.type)).length;
    const outputs = [...new Set(steps.filter(s => s.type === 'set_do').map(s => `DO[${s.port}]`))];
    $('confirmText').textContent = `${steps.length} steps will be sent to ${$('ip').value}: ${moves} motions at ${override} % override`
      + (outputs.length ? `, and ${outputs.join(', ')} will be written.` : '.');
    const dialog = $('confirmDialog');
    dialog.returnValue = '';
    dialog.showModal();
    await new Promise(resolve => dialog.addEventListener('close', resolve, { once: true }));
    if (dialog.returnValue !== 'run') return;
  }
  sentSteps = steps;
  selectTab('steps');
  await act(() => client.run(steps, override));
});
for (const name of ['pause', 'continue', 'abort', 'reset'])
  $(name).addEventListener('click', () => act(() => client[name]()));

$('examples').addEventListener('change', e => {
  const name = e.target.value;
  e.target.value = '';
  if (!name) return;
  // The palletizing example is built around the position of the robot, so that its targets can be reached
  load(EXAMPLES[name](state.position?.cartesian ?? [500, 0, 400, 180, 0, 0]));
});

$('teach').addEventListener('click', () => {
  const block = Blockly.getSelected(), p = state.position;
  const fields = block?.type === 'move_linear' ? ['X', 'Y', 'Z', 'W', 'P', 'R'].map((f, i) => [f, p.cartesian[i]])
    : block?.type === 'move_joint' ? p.joints.map((j, i) => [`J${i + 1}`, j]) : null;
  if (!fields) {
    actionError = 'Select a "Move linear to" or a "Move joint to" block first.';
    return render();
  }
  actionError = null;
  fields.forEach(([name, value]) => block.setFieldValue(Math.round(value * 1000) / 1000, name));
  render();
});

$('settings').addEventListener('click', () => {
  $('licenseState').textContent = `License of the SDK on this PC: ${info.license.state}`
    + (info.license.daysLeft != null ? `, ${info.license.daysLeft} trial days left.` : '.');
  $('licensee').value = info.config.licensee ?? '';
  $('licenseKey').value = '';
  $('settingsDialog').showModal();
});
$('saveSettings').addEventListener('click', async () => {
  try {
    info = await client.saveConfig({ licensee: $('licensee').value, licenseKey: $('licenseKey').value || null });
    $('settingsDialog').close();
  } catch (e) {
    $('licenseState').textContent = e.message;
  }
  render();
});

// ---------------------------------------------------------------- live state
async function poll() {
  try {
    state = await client.state();
    failedPolls = 0;
    if (state.connected) connectError = null;
  } catch (e) {
    // A robot that does not answer keeps its backend: only a backend that is gone sends the page back to demo mode
    if (e instanceof TypeError && ++failedPolls >= 3) await useBackend(null);
    else if (!(e instanceof TypeError)) state = { ...state, connected: false, notice: e.message };
  }
  render();
}

await useBackend(await detectBackend());
selectTab('steps');
for (;;) {
  await poll();
  await new Promise(resolve => setTimeout(resolve, 300));
}
