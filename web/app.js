import { routeGraphEdge } from './graph-routing.js';

const $ = id => document.getElementById(id);
const sample = '请写一个 Python 程序读取 CSV 销售数据。缺失的销售额保持缺失，计算平均值时排除缺失值；输出平均值和有效数据条数。请用 [10, 缺失, 20] 演示。';
const params = new URLSearchParams(location.search);
const code = params.get('code') || '';
let authenticated = false;

let original = null;
let plans = {};
let input = '';
let mode = 'text';
let selectedNode = null;
let selectedEdge = null;
let positions = {};
let outputText = '';
let activeWire = null;
let pendingStart = null;
const clone = value => JSON.parse(JSON.stringify(value));
const svgNS = 'http://www.w3.org/2000/svg';

function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('show'), 4500);
}

function setBusy(on, label) {
  for (const id of ['analyze', 'generate']) $(id).disabled = on || !authenticated;
  $('loading').classList.toggle('hidden', !on);
  if (label) $('loadingTitle').textContent = label;
}

async function api(route, body) {
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${code}` };
  const response = await fetch(`/api/${route}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401) showAuthNotice();
    throw new Error(data.error || '请求失败');
  }
  if (!data.jobId) return data;
  for (let i = 0; i < 240; i++) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    const poll = await fetch(`/api/job/${encodeURIComponent(data.jobId)}`, { headers: { Authorization: `Bearer ${code}` } });
    const job = await poll.json();
    if (!poll.ok) {
      if (poll.status === 401) showAuthNotice();
      throw new Error(job.error || '查询任务失败');
    }
    if (job.status === 'complete') return job.result;
    if (job.status === 'failed') throw new Error(job.error || '模型处理失败');
  }
  throw new Error('模型处理时间过长，请重试');
}

function normalize(raw) {
  const steps = Array.isArray(raw.steps) ? raw.steps : [];
  const normalized = steps.map((step, index) => ({
    id: String(step.id || `s${index + 1}`),
    label: String(step.label || `步骤 ${index + 1}`),
    detail: String(step.detail || ''),
    module: String(step.module || '')
  }));
  const ids = new Set(normalized.map(step => step.id));
  return {
    summary: String(raw.summary || ''),
    steps: normalized,
    edges: (Array.isArray(raw.edges) ? raw.edges : []).filter(edge => ids.has(edge.from) && ids.has(edge.to) && edge.from !== edge.to).map(edge => ({ from: String(edge.from), to: String(edge.to), fromPort: edge.fromPort === 'left' ? 'left' : 'right', toPort: edge.toPort === 'right' ? 'right' : 'left' })),
    assumptions: (Array.isArray(raw.assumptions) ? raw.assumptions : []).map((a, index) => ({
      id: String(a.id || `a${index + 1}`),
      title: String(a.title || '未命名假设'),
      value: String(a.value || ''),
      source: typeof a.source === 'string' && input.includes(a.source) ? a.source : '',
      status: ['conflict', 'uncertain', 'supported'].includes(a.status) ? a.status : 'uncertain',
      reason: String(a.reason || ''),
      impact: String(a.impact || ''),
      alternatives: Array.isArray(a.alternatives) ? a.alternatives.map(option => typeof option === 'string' ? { label: option, impact: String(a.impact || '具体影响可在反馈中询问') } : { label: String(option.label || option.value || ''), impact: String(option.impact || '') }).filter(option => option.label) : [],
      reviewed: false,
      stepId: ids.has(a.stepId) ? String(a.stepId) : (normalized[0]?.id || '')
    }))
  };
}

function textFromPlan(plan) {
  return [plan.summary, ...plan.steps.map((step, index) => `${index + 1}. ${step.label}\n   ${step.detail}`),
    ...(plan.assumptions.length ? ['\n关键假设：', ...plan.assumptions.map((a, index) => `${index + 1}. ${a.title}：${a.value}`)] : [])].join('\n');
}

function markChanged() {
  const plan = plans[mode];
  const changed = JSON.stringify(plan) !== JSON.stringify(mode === 'text' ? textFromPlan(original) : original);
  $('statusTitle').textContent = changed ? '已有审查修改' : '等待审查';
  $('statusText').textContent = changed ? '当前模式的修改会进入代码生成；Assumption Lens 中的影响会即时更新。' : '可在当前界面直接修改计划。';
  const count = mode === 'text' ? original.steps.length : plan.steps.length;
  const assumptions = mode === 'text' ? original.assumptions.length : plan.assumptions.length;
  $('stats').replaceChildren();
  const labels = [`${count} 个任务步骤`, `${assumptions} 个实现决策`];
  if (mode === 'lens') labels.push(`${plan.assumptions.filter(item => !item.reviewed).length} 个待办决策`);
  for (const label of labels) {
    const span = document.createElement('span');
    span.textContent = label;
    $('stats').append(span);
  }
}

function showMode(next) {
  mode = next;
  for (const tab of document.querySelectorAll('.tab')) tab.classList.toggle('active', tab.dataset.mode === mode);
  for (const name of ['text', 'graph', 'lens']) $(`${name}View`).classList.toggle('hidden', name !== mode);
  $('outputPanel').classList.add('hidden');
  if (mode === 'text') $('textPlan').value = plans.text;
  if (mode === 'graph') renderGraph();
  if (mode === 'lens') renderLensV2();
  markChanged();
}

function layout() {
  const canvas = $('graphCanvas');
  const width = Math.max(canvas.clientWidth, 420);
  const cols = width >= 780 ? 3 : width >= 540 ? 2 : 1;
  const cell = width / cols;
  positions = {};
  plans.graph.steps.forEach((step, index) => {
    const row = Math.floor(index / cols);
    positions[step.id] = { x: Math.max(34, Math.round(index % cols * cell + (cell - 190) / 2)), y: 34 + row * 142 };
  });
  canvas.style.minHeight = `${Math.max(410, 80 + Math.ceil(plans.graph.steps.length / cols) * 142)}px`;
}

function portPoint(id, side) {
  const position = positions[id];
  if (!position) return null;
  const node = [...$('nodes').children].find(element => element.dataset.nodeId === id);
  const height = node?.offsetHeight || 92;
  return { x: position.x + (side === 'right' ? 190 : 0), y: position.y + height / 2 };
}

function graphRectangles() {
  return plans.graph.steps.map(step => {
    const node = [...$('nodes').children].find(element => element.dataset.nodeId === step.id);
    const point = positions[step.id];
    return { id: step.id, x: point.x, y: point.y, w: 190, h: node?.offsetHeight || 92 };
  });
}

function canvasPoint(event) {
  const rect = $('graphCanvas').getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function pathBetween(from, to) {
  const gap = Math.max(45, Math.min(100, Math.abs(to.x - from.x) / 2));
  const direction = to.x >= from.x ? 1 : -1;
  return `M ${from.x} ${from.y} C ${from.x + direction * gap} ${from.y}, ${to.x - direction * gap} ${to.y}, ${to.x} ${to.y}`;
}

function svgElement(tag, attributes = {}) {
  const element = document.createElementNS(svgNS, tag);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
  return element;
}

function edgeName(edge) {
  const from = plans.graph.steps.find(step => step.id === edge.from)?.label || edge.from;
  const to = plans.graph.steps.find(step => step.id === edge.to)?.label || edge.to;
  return `${from} → ${to}`;
}

function drawEdges() {
  const svg = $('edges');
  svg.replaceChildren();
  const canvas = $('graphCanvas');
  svg.setAttribute('viewBox', `0 0 ${canvas.clientWidth} ${canvas.clientHeight}`);
  const defs = svgElement('defs');
  const marker = svgElement('marker', { id: 'arrow', markerWidth: 9, markerHeight: 9, refX: 8, refY: 4.5, orient: 'auto' });
  marker.append(svgElement('path', { d: 'M0 0 L9 4.5 L0 9', fill: '#6f9e77' }));
  defs.append(marker);
  svg.append(defs);
  const rectangles = graphRectangles();
  plans.graph.edges.forEach((edge, index) => {
    const from = portPoint(edge.from, edge.fromPort || 'right');
    const to = portPoint(edge.to, edge.toPort || 'left');
    if (!from || !to) return;
    const d = routeGraphEdge(rectangles, edge.from, edge.fromPort || 'right', edge.to, edge.toPort || 'left', canvas.clientWidth, canvas.clientHeight);
    if (!d) return;
    const visible = svgElement('path', { d, class: index === selectedEdge ? 'graph-edge selected' : 'graph-edge', 'marker-end': 'url(#arrow)' });
    const hit = svgElement('path', { d, class: 'edge-hit', 'data-edge-index': index, role: 'button', tabindex: 0, 'aria-label': `选择连线 ${edgeName(edge)}` });
    hit.addEventListener('click', event => { event.stopPropagation(); selectedEdge = index; drawEdges(); });
    hit.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); selectedEdge = index; drawEdges(); } });
    svg.append(visible, hit);
    if (index === selectedEdge) {
      for (const [side, point] of [['from', from], ['to', to]]) {
        const portSide = side === 'from' ? (edge.fromPort || 'right') : (edge.toPort || 'left');
        const handle = svgElement('circle', { cx: point.x + (portSide === 'right' ? 8 : -8), cy: point.y, r: 9, class: 'edge-endpoint', 'aria-label': side === 'from' ? '拖动起点重新连接' : '拖动终点重新连接' });
        handle.addEventListener('pointerdown', event => { event.stopPropagation(); event.preventDefault(); startWire({ kind: 'rewire', edgeIndex: index, side }, event); });
        svg.append(handle);
      }
    }
  });
  if (activeWire) {
    const from = activeWire.kind === 'new' || activeWire.side === 'to' ? portPoint(activeWire.from, activeWire.fromPort) : activeWire.pointer;
    const to = activeWire.kind === 'new' || activeWire.side === 'to' ? activeWire.pointer : portPoint(activeWire.to, activeWire.toPort);
    if (from && to) svg.append(svgElement('path', { d: pathBetween(from, to), class: 'edge-preview' }));
  }
  const tools = $('edgeTools');
  const edge = plans.graph.edges[selectedEdge];
  if (!edge || mode !== 'graph') { tools.classList.add('hidden'); return; }
  const from = portPoint(edge.from, edge.fromPort || 'right');
  const to = portPoint(edge.to, edge.toPort || 'left');
  $('edgeName').textContent = edgeName(edge);
  tools.style.left = `${Math.max(8, Math.min(canvas.clientWidth - 180, (from.x + to.x) / 2 - 80))}px`;
  tools.style.top = `${Math.max(6, Math.min(canvas.clientHeight - 45, (from.y + to.y) / 2 - 44))}px`;
  tools.classList.remove('hidden');
}

function finishConnection(fromId, toId, fromPort = 'right', toPort = 'left', edgeIndex = null, side = 'to') {
  const plan = plans.graph;
  const from = edgeIndex === null || side === 'from' ? fromId : plan.edges[edgeIndex]?.from;
  const to = edgeIndex === null || side === 'to' ? toId : plan.edges[edgeIndex]?.to;
  if (!from || !to || from === to) return toast('请选择两个不同的节点');
  if (plan.edges.some((edge, index) => index !== edgeIndex && edge.from === from && edge.to === to)) return toast('这条连线已存在');
  if (edgeIndex === null) {
    plan.edges.push({ from, to, fromPort, toPort });
    selectedEdge = plan.edges.length - 1;
  } else {
    plan.edges[edgeIndex] = { from, to, fromPort: side === 'from' ? fromPort : plan.edges[edgeIndex].fromPort, toPort: side === 'to' ? toPort : plan.edges[edgeIndex].toPort };
    selectedEdge = edgeIndex;
  }
  pendingStart = null;
  renderGraph();
  markChanged();
}

function startWire(options, event) {
  const start = { x: event.clientX, y: event.clientY };
  activeWire = {
    ...options,
    from: options.kind === 'new' ? options.from : plans.graph.edges[options.edgeIndex].from,
    to: options.kind === 'new' ? null : plans.graph.edges[options.edgeIndex].to,
    fromPort: options.kind === 'new' ? options.fromPort : plans.graph.edges[options.edgeIndex].fromPort,
    toPort: options.kind === 'new' ? null : plans.graph.edges[options.edgeIndex].toPort,
    pointer: canvasPoint(event)
  };
  document.body.classList.add('wiring');
  drawEdges();
  const move = moveEvent => { activeWire.pointer = canvasPoint(moveEvent); drawEdges(); };
  const up = upEvent => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    document.body.classList.remove('wiring');
    const elements = document.elementsFromPoint(upEvent.clientX, upEvent.clientY);
    const targetPort = elements.find(element => element.classList?.contains('graph-port'));
    const target = targetPort?.closest('.graph-node') || elements.map(element => element.closest?.('.graph-node')).find(Boolean);
    const targetId = target?.dataset.nodeId;
    const targetSide = targetPort ? (targetPort.classList.contains('right') ? 'right' : 'left') : (target && upEvent.clientX > target.getBoundingClientRect().left + target.offsetWidth / 2 ? 'right' : 'left');
    const dragged = Math.hypot(upEvent.clientX - start.x, upEvent.clientY - start.y) > 5;
    const wire = activeWire;
    activeWire = null;
    if (targetId) {
      if (wire.kind === 'new') finishConnection(wire.from, targetId, wire.fromPort, targetSide);
      else if (wire.side === 'to') finishConnection(wire.from, targetId, wire.fromPort, targetSide, wire.edgeIndex, 'to');
      else finishConnection(targetId, wire.to, targetSide, wire.toPort, wire.edgeIndex, 'from');
    } else if (!dragged && wire.kind === 'new') {
      pendingStart = { id: wire.from, port: wire.fromPort };
      toast('已选择起点。点击另一个节点的任意连接点完成连线。');
      drawEdges();
    } else drawEdges();
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up, { once: true });
}

function renderGraph() {
  const plan = plans.graph;
  if (!Object.keys(positions).length) layout();
  const host = $('nodes');
  host.replaceChildren();
  for (const step of plan.steps) {
    if (!positions[step.id]) positions[step.id] = { x: 24, y: 30 + plan.steps.indexOf(step) * 142 };
    const node = document.createElement('div');
    node.className = `graph-node${selectedNode === step.id ? ' selected' : ''}`;
    node.dataset.nodeId = step.id;
    node.style.left = `${positions[step.id].x}px`;
    node.style.top = `${positions[step.id].y}px`;
    const small = document.createElement('small');
    small.textContent = step.id.toUpperCase();
    const title = document.createElement('strong');
    title.textContent = step.label;
    const detail = document.createElement('p');
    detail.textContent = step.detail;
    const makePort = side => {
      const port = document.createElement('button');
      port.type = 'button';
      port.className = `graph-port ${side}`;
      port.title = `拖动${side === 'left' ? '左' : '右'}侧圆点连接，或点击选择端点`;
      port.setAttribute('aria-label', `${step.label} ${side === 'left' ? '左' : '右'}侧连接点`);
      port.addEventListener('pointerdown', event => {
        event.stopPropagation();
        event.preventDefault();
        if (pendingStart) finishConnection(pendingStart.id, step.id, pendingStart.port, side);
        else startWire({ kind: 'new', from: step.id, fromPort: side }, event);
      });
      return port;
    };
    node.append(makePort('left'), small, title, detail, makePort('right'));
    let start = null;
    let moved = false;
    node.addEventListener('pointerdown', event => {
      if (event.button !== 0 || event.target.closest('.graph-port')) return;
      start = { x: event.clientX, y: event.clientY, ox: positions[step.id].x, oy: positions[step.id].y };
      moved = false;
      node.setPointerCapture(event.pointerId);
    });
    node.addEventListener('pointermove', event => {
      if (!start) return;
      const dx = event.clientX - start.x, dy = event.clientY - start.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
      if (!moved) return;
      const next = {
        x: Math.max(32, Math.min($('graphCanvas').clientWidth - 222, start.ox + dx)),
        y: Math.max(6, Math.min($('graphCanvas').clientHeight - node.offsetHeight - 6, start.oy + dy))
      };
      const collision = plan.steps.some(other => {
        if (other.id === step.id) return false;
        const point = positions[other.id];
        return point && next.x < point.x + 208 && next.x + 208 > point.x && next.y < point.y + (host.querySelector(`[data-node-id="${CSS.escape(other.id)}"]`)?.offsetHeight || 92) + 18 && next.y + node.offsetHeight + 18 > point.y;
      });
      if (collision) return;
      positions[step.id] = next;
      node.style.left = `${positions[step.id].x}px`;
      node.style.top = `${positions[step.id].y}px`;
      drawEdges();
    });
    node.addEventListener('pointerup', () => {
      if (!start) return;
      start = null;
      if (moved) return;
      selectedNode = step.id;
      $('nodeLabel').value = step.label;
      $('nodeDetail').value = step.detail;
      $('nodeEditor').classList.remove('hidden');
      renderGraph();
    });
    host.append(node);
  }
  if (selectedEdge !== null && !plan.edges[selectedEdge]) selectedEdge = null;
  drawEdges();
}

function deleteSelectedEdge() {
  if (selectedEdge === null) return;
  plans.graph.edges.splice(selectedEdge, 1);
  selectedEdge = null;
  renderGraph();
  markChanged();
}

function buildModules(plan) {
  const steps = plan.steps;
  const fallbackSize = Math.max(1, Math.ceil(steps.length / Math.min(3, Math.max(1, Math.ceil(steps.length / 2)))));
  const modules = [];
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    const title = step.module || `阶段 ${Math.floor(index / fallbackSize) + 1}`;
    let module = modules.find(item => item.title === title);
    if (!module) {
      module = { id: `module-${modules.length}`, title, steps: [] };
      modules.push(module);
    }
    module.steps.push(step);
  }
  return modules;
}

let selectedLensModule = null;
let selectedLensStep = null;
let lensImpactQueue = Promise.resolve();
let pendingLensStep = null;
let lensWire = null;
let lensModulePositions = {};
let lensStepPositions = {};
let fixedStepIds = new Set();
let fixedModules = new Set();
let fixedEdges = new Set();
let lensChats = {};
let chatPreset = {};
const edgeKey = edge => `${edge.from}\u0000${edge.to}`;
function confirmCriticalChange(title, consequence) {
  return new Promise(resolve => {
    const overlay = $('criticalWarning');
    $('criticalWarningTitle').textContent = title;
    $('criticalWarningText').textContent = consequence;
    overlay.classList.remove('hidden');
    const finish = accepted => {
      overlay.classList.add('hidden');
      $('criticalCancel').onclick = null;
      $('criticalProceed').onclick = null;
      document.removeEventListener('keydown', onKey);
      resolve(accepted);
    };
    const onKey = event => { if (event.key === 'Escape') finish(false); };
    $('criticalCancel').onclick = () => finish(false);
    $('criticalProceed').onclick = () => finish(true);
    document.addEventListener('keydown', onKey);
    $('criticalCancel').focus();
  });
}
const pendingForStep = id => plans.lens.assumptions.filter(decision => decision.stepId === id && !decision.reviewed).length;

function dragLensNode(node, canvas, rect, rectangles, positions, redraw) {
  let start = null;
  node.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.target.closest('button')) return;
    start = { x: event.clientX, y: event.clientY, left: rect.x, top: rect.y, moved: false };
    node.setPointerCapture(event.pointerId);
  });
  node.addEventListener('pointermove', event => {
    if (!start) return;
    const dx = event.clientX - start.x, dy = event.clientY - start.y;
    if (Math.hypot(dx, dy) > 4) start.moved = true;
    if (!start.moved) return;
    const x = Math.max(24, Math.min(canvas.clientWidth - rect.w - 24, start.left + dx));
    const y = Math.max(14, Math.min(canvas.clientHeight - rect.h - 14, start.top + dy));
    if (rectangles.some(other => other !== rect && x < other.x + other.w + 16 && x + rect.w + 16 > other.x && y < other.y + other.h + 16 && y + rect.h + 16 > other.y)) return;
    rect.x = x;
    rect.y = y;
    positions[rect.id] = { x, y };
    node.style.left = `${x}px`;
    node.style.top = `${y}px`;
    redraw();
  });
  node.addEventListener('pointerup', () => {
    if (start?.moved) {
      node.dataset.dragged = 'true';
      setTimeout(() => { node.dataset.dragged = ''; }, 0);
    }
    start = null;
  });
  node.addEventListener('pointercancel', () => { start = null; });
}

async function beginLensStepWire(graph, svg, step, index, side, event) {
  if (pendingLensStep) {
    const from = pendingLensStep;
    pendingLensStep = null;
    if (from.id !== step.id && !plans.lens.edges.some(edge => edge.from === from.id && edge.to === step.id)) {
      if (plans.lens.steps.findIndex(item => item.id === from.id) >= plans.lens.steps.findIndex(item => item.id === step.id) && !await confirmCriticalChange('调整步骤顺序', '这条连接指向较早的步骤，可能形成循环依赖，改变任务执行顺序和最终代码结构。')) return;
      const before = clone(plans.lens);
      plans.lens.edges.push({ from: from.id, to: step.id, fromPort: from.side, toPort: side });
      renderLensV2();
      explainLensChange(before, `新增步骤关系「${plans.lens.steps.find(item => item.id === from.id)?.label} → ${step.label}」`);
    } else renderLensV2();
    return;
  }
  const rect = graph.getBoundingClientRect();
  const sourceNode = [...graph.querySelectorAll('.lens-detail-node')][index];
  const source = { x: sourceNode.offsetLeft + (side === 'right' ? 190 : 0), y: sourceNode.offsetTop + sourceNode.offsetHeight / 2 };
  const start = { x: event.clientX, y: event.clientY };
  const preview = svgElement('path', { class: 'edge-preview' });
  svg.append(preview);
  const move = next => {
    const point = { x: next.clientX - rect.left, y: next.clientY - rect.top };
    preview.setAttribute('d', pathBetween(source, point));
  };
  const up = async next => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    preview.remove();
    const dragged = Math.hypot(next.clientX - start.x, next.clientY - start.y) > 5;
    const target = document.elementsFromPoint(next.clientX, next.clientY).find(element => element.classList?.contains('lens-step-port'));
    const box = target?.closest('.lens-detail-node');
    const targetId = box?.dataset.stepId;
    if (dragged && targetId && targetId !== step.id && !plans.lens.edges.some(edge => edge.from === step.id && edge.to === targetId)) {
      if (plans.lens.steps.findIndex(item => item.id === step.id) >= plans.lens.steps.findIndex(item => item.id === targetId) && !await confirmCriticalChange('调整步骤顺序', '这条连接指向较早的步骤，可能形成循环依赖，改变任务执行顺序和最终代码结构。')) return;
      const before = clone(plans.lens);
      const targetSide = target.classList.contains('right') ? 'right' : 'left';
      plans.lens.edges.push({ from: step.id, to: targetId, fromPort: side, toPort: targetSide });
      renderLensV2();
      explainLensChange(before, `新增步骤关系「${step.label} → ${plans.lens.steps.find(item => item.id === targetId)?.label}」`);
    } else if (!dragged) {
      pendingLensStep = { id: step.id, side };
      toast('已选择起点，请点击目标步骤的连接点。');
    }
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up, { once: true });
}

function appendLensLog(change, detail = '') {
  const feed = $('lensImpactFeed');
  const item = document.createElement('article');
  item.className = 'lens-impact-item';
  const heading = document.createElement('strong');
  heading.textContent = change;
  const body = document.createElement('p');
  body.textContent = detail;
  item.append(heading, body);
  feed.insertBefore(item, feed.children[2] || null);
  return body;
}

function explainLensChange(before, change) {
  markChanged();
  const after = clone(plans.lens);
  const body = appendLensLog(change, '正在分析这次变更可能造成的影响…');
  lensImpactQueue = lensImpactQueue.then(async () => {
    try {
      const result = await api('impact', { input, before, after, change });
      body.textContent = result.output || '模型没有给出解释。';
    } catch (error) {
      body.textContent = `解释暂不可用：${error.message}`;
    }
  });
}

function lensModuleRelations(modules) {
  const byStep = new Map(modules.flatMap(module => module.steps.map(step => [step.id, module.title])));
  const relations = new Map();
  for (const edge of plans.lens.edges) {
    const from = byStep.get(edge.from), to = byStep.get(edge.to);
    if (!from || !to || from === to) continue;
    const key = `${from}\u0000${to}`;
    if (!relations.has(key)) relations.set(key, { from, to, fromPort: edge.fromPort || 'right', toPort: edge.toPort || 'left' });
  }
  return [...relations.values()];
}

function renderLensV2() {
  const modules = buildModules(plans.lens);
  if (!modules.some(module => module.title === selectedLensModule)) selectedLensModule = modules[0]?.title || null;
  if (!modules.find(module => module.title === selectedLensModule)?.steps.some(step => step.id === selectedLensStep)) selectedLensStep = null;
  const canvas = $('lensTree'), host = $('lensNodes');
  host.replaceChildren();
  const width = Math.max(canvas.clientWidth, 300);
  const twoColumns = width >= 450;
  canvas.style.height = `${Math.max(280, modules.length * 132 + 45)}px`;
  const rectangles = modules.map((module, index) => ({
    id: module.title,
    x: Math.max(24, Math.min(width - 214, lensModulePositions[module.title]?.x ?? (twoColumns ? (index % 2 ? width - 230 : 38) : Math.max(34, (width - 190) / 2)))),
    y: Math.max(14, Math.min(canvas.clientHeight - 102, lensModulePositions[module.title]?.y ?? (32 + index * 132))), w: 190, h: 88
  }));
  for (const [index, module] of modules.entries()) {
    const rect = rectangles[index];
    const node = document.createElement('div');
    const pending = module.steps.reduce((total, step) => total + pendingForStep(step.id), 0);
    node.className = `lens-coarse-node${selectedLensModule === module.title ? ' active' : ''}${pending ? ' needs-review' : ''}${fixedModules.has(module.title) ? ' fixed' : ''}`;
    node.dataset.module = module.title;
    node.style.left = `${rect.x}px`;
    node.style.top = `${rect.y}px`;
    const label = document.createElement('small');
    label.textContent = `模块 ${String(index + 1).padStart(2, '0')}`;
    const title = document.createElement('strong');
    title.textContent = module.title;
    const count = document.createElement('span');
    count.textContent = `${module.steps.length} 个步骤${pending ? ` · ${pending} 个待办决策` : ''}`;
    const remove = document.createElement('button');
    remove.className = 'lens-node-delete';
    remove.textContent = '×';
    remove.title = `删除模块 ${module.title}`;
    remove.onclick = async event => {
      event.stopPropagation();
      if (fixedModules.has(module.title) && !await confirmCriticalChange(`删除关键模块「${module.title}」？`, `这会同时删除其中的 ${module.steps.length} 个步骤、相关连接和决策，可能使任务流程不完整。你仍可继续删除。`)) return;
      const before = clone(plans.lens);
      const ids = new Set(module.steps.map(step => step.id));
      fixedModules.delete(module.title);
      for (const id of ids) fixedStepIds.delete(id);
      plans.lens.steps = plans.lens.steps.filter(step => !ids.has(step.id));
      plans.lens.edges = plans.lens.edges.filter(edge => !ids.has(edge.from) && !ids.has(edge.to));
      plans.lens.assumptions = plans.lens.assumptions.filter(a => !ids.has(a.stepId));
      delete lensModulePositions[module.title];
      selectedLensModule = null;
      renderLensV2();
      explainLensChange(before, `删除模块「${module.title}」及其步骤和关系`);
    };
    const makePort = side => {
      const port = document.createElement('button');
      port.className = `lens-module-port ${side}`;
      port.title = `从${side === 'left' ? '左' : '右'}侧连接模块`;
      port.setAttribute('aria-label', `${module.title} ${side === 'left' ? '左' : '右'}侧连接点`);
      port.onclick = event => event.stopPropagation();
      port.onpointerdown = event => {
        event.preventDefault();
        event.stopPropagation();
        beginLensModuleWire(module.title, side, event);
      };
      return port;
    };
    node.append(makePort('left'), label, title, count, remove, makePort('right'));
    node.onclick = () => { if (node.dataset.dragged === 'true') return; selectedLensModule = module.title; renderLensV2(); };
    host.append(node);
    dragLensNode(node, canvas, rect, rectangles, lensModulePositions, () => drawLensModuleEdges(rectangles));
  }
  drawLensModuleEdges(rectangles);
  renderLensDetailV2(modules.find(module => module.title === selectedLensModule));
}

function drawLensModuleEdges(rectangles) {
  const svg = $('lensEdges'), canvas = $('lensTree');
  svg.replaceChildren();
  svg.setAttribute('viewBox', `0 0 ${canvas.clientWidth} ${canvas.clientHeight}`);
  for (const relation of lensModuleRelations(buildModules(plans.lens))) {
    const from = rectangles.find(rect => rect.id === relation.from);
    const to = rectangles.find(rect => rect.id === relation.to);
    if (!from || !to) continue;
    const d = routeGraphEdge(rectangles, from.id, relation.fromPort, to.id, relation.toPort, canvas.clientWidth, canvas.clientHeight);
    if (!d) continue;
    svg.append(svgElement('path', { d, class: 'lens-edge' }));
    const hit = svgElement('path', { d, class: 'edge-hit', role: 'button', tabindex: 0, 'aria-label': `删除模块关系 ${relation.from} 到 ${relation.to}` });
    hit.onclick = async () => {
      const stepToModule = new Map(buildModules(plans.lens).flatMap(module => module.steps.map(step => [step.id, module.title])));
      if (plans.lens.edges.some(edge => fixedEdges.has(edgeKey(edge)) && stepToModule.get(edge.from) === relation.from && stepToModule.get(edge.to) === relation.to) && !await confirmCriticalChange(`删除关键连接「${relation.from} → ${relation.to}」？`, '这会切断初始任务流程中的模块依赖，后续模块可能失去输入或执行顺序。你仍可继续删除。')) return;
      const before = clone(plans.lens);
      for (const edge of plans.lens.edges) if (stepToModule.get(edge.from) === relation.from && stepToModule.get(edge.to) === relation.to) fixedEdges.delete(edgeKey(edge));
      plans.lens.edges = plans.lens.edges.filter(edge => !(stepToModule.get(edge.from) === relation.from && stepToModule.get(edge.to) === relation.to));
      renderLensV2();
      explainLensChange(before, `删除模块关系「${relation.from} → ${relation.to}」`);
    };
    hit.onkeydown = event => { if (event.key === 'Enter') hit.click(); };
    svg.append(hit);
  }
  if (lensWire) {
    const rect = rectangles.find(item => item.id === lensWire.module);
    if (rect) {
      const start = { x: rect.x + (lensWire.side === 'right' ? rect.w : 0), y: rect.y + rect.h / 2 };
      svg.append(svgElement('path', { d: pathBetween(start, lensWire.pointer), class: 'edge-preview' }));
    }
  }
}

function beginLensModuleWire(moduleTitle, side, event) {
  const rect = $('lensTree').getBoundingClientRect();
  lensWire = { module: moduleTitle, side, pointer: { x: event.clientX - rect.left, y: event.clientY - rect.top } };
  const move = next => {
    lensWire.pointer = { x: next.clientX - rect.left, y: next.clientY - rect.top };
    drawLensModuleEdges(buildModules(plans.lens).map((module, index) => ({
      id: module.title, x: $('lensNodes').children[index]?.offsetLeft || 0, y: $('lensNodes').children[index]?.offsetTop || 0, w: 190, h: 88
    })));
  };
  const up = async next => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', up);
    const elements = document.elementsFromPoint(next.clientX, next.clientY);
    const port = elements.find(element => element.classList?.contains('lens-module-port'));
    const target = port?.closest('.lens-coarse-node') || elements.map(element => element.closest?.('.lens-coarse-node')).find(Boolean);
    const to = target?.dataset.module;
    const targetSide = port?.classList.contains('right') ? 'right' : 'left';
    lensWire = null;
    if (to && to !== moduleTitle) {
      const modules = buildModules(plans.lens);
      const first = modules.find(item => item.title === moduleTitle)?.steps.at(-1);
      const second = modules.find(item => item.title === to)?.steps[0];
      if (first && second && !plans.lens.edges.some(edge => edge.from === first.id && edge.to === second.id)) {
        if (plans.lens.steps.findIndex(item => item.id === first.id) >= plans.lens.steps.findIndex(item => item.id === second.id) && !await confirmCriticalChange('调整模块顺序', '这条连接指向较早的模块，可能造成循环依赖或改变原有执行顺序。你仍可继续连接。')) { renderLensV2(); return; }
        const before = clone(plans.lens);
        plans.lens.edges.push({ from: first.id, to: second.id, fromPort: side, toPort: targetSide });
        renderLensV2();
        explainLensChange(before, `新增模块关系「${moduleTitle} → ${to}」`);
      } else renderLensV2();
    } else renderLensV2();
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', up, { once: true });
}

function renderLensChat(host, contextKey, context) {
  const panel = document.createElement('section');
  panel.className = 'lens-chat';
  const heading = document.createElement('h5');
  heading.textContent = `询问 Assumption Lens · ${context.label}`;
  panel.append(heading);
  if (chatPreset[contextKey]) {
    const preset = document.createElement('div');
    preset.className = 'chat-preset';
    preset.textContent = `当前讨论方案：${chatPreset[contextKey]}`;
    panel.append(preset);
  }
  const history = document.createElement('div');
  history.className = 'lens-chat-history';
  for (const message of lensChats[contextKey] || []) {
    const bubble = document.createElement('p');
    bubble.className = `chat-message ${message.role}`;
    bubble.textContent = message.text;
    history.append(bubble);
  }
  panel.append(history);
  const form = document.createElement('form');
  form.className = 'lens-chat-form';
  const question = document.createElement('textarea');
  question.rows = 2;
  question.placeholder = '就这个模块、步骤或选中的方案继续提问…';
  const send = document.createElement('button');
  send.type = 'submit';
  send.className = 'secondary small';
  send.textContent = '发送追问 ↗';
  form.append(question, send);
  form.onsubmit = event => {
    event.preventDefault();
    const text = question.value.trim();
    if (!text) return;
    if (!lensChats[contextKey]) lensChats[contextKey] = [];
    lensChats[contextKey].push({ role: 'user', text }, { role: 'assistant', text: '正在回答…' });
    const reply = lensChats[contextKey].at(-1);
    const preset = chatPreset[contextKey] || '';
    const plan = clone(plans.lens);
    renderLensV2();
    lensImpactQueue = lensImpactQueue.then(async () => {
      try {
        const result = await api('ask', { input, plan, context, preset, question: text });
        reply.text = result.output || '暂时没有得到回答。';
      } catch (error) { reply.text = `追问失败：${error.message}`; }
      if (mode === 'lens') renderLensV2();
    });
  };
  panel.append(form);
  host.append(panel);
}

function renderLensDetailV2(module) {
  const host = $('lensInspector');
  host.replaceChildren();
  if (!module) {
    host.innerHTML = '<div class="inspector-empty"><span>⌕</span><strong>暂无模块</strong><p>点击“添加模块”构建任务图。</p></div>';
    return;
  }
  const kicker = document.createElement('span');
  kicker.className = 'kicker';
  kicker.textContent = '模块内部 / DETAIL GRAPH';
  const title = document.createElement('h4');
  title.textContent = module.title;
  const moduleName = document.createElement('label');
  moduleName.textContent = '模块名称';
  const moduleInput = document.createElement('input');
  moduleInput.value = module.title;
  moduleInput.onchange = async () => {
    const next = moduleInput.value.trim();
    if (!next || next === module.title) return;
    if (buildModules(plans.lens).some(item => item.title === next)) return toast('模块名称已存在');
    if (fixedModules.has(module.title) && !await confirmCriticalChange(`调整关键模块「${module.title}」？`, '改变初始模块名称可能影响对整体任务阶段的理解，以及最终代码的组织方式。你仍可继续修改。')) { moduleInput.value = module.title; return; }
    const before = clone(plans.lens);
    for (const step of module.steps) step.module = next;
    if (fixedModules.delete(module.title)) fixedModules.add(next);
    if (lensModulePositions[module.title]) {
      lensModulePositions[next] = lensModulePositions[module.title];
      delete lensModulePositions[module.title];
    }
    selectedLensModule = next;
    renderLensV2();
    explainLensChange(before, `将模块「${module.title}」重命名为「${next}」`);
  };
  moduleName.append(moduleInput);
  const intro = document.createElement('p');
  intro.className = 'inspector-reason';
  intro.textContent = '点击步骤查看行为。拖动连接点创建依赖；点击连线可删除。';
  const add = document.createElement('button');
  add.className = 'secondary small';
  add.textContent = '＋ 添加步骤';
  add.onclick = () => {
    const before = clone(plans.lens);
    const id = `s${Date.now()}`;
    const last = module.steps.at(-1);
    const index = plans.lens.steps.findIndex(step => step.id === last.id);
    plans.lens.steps.splice(index + 1, 0, { id, label: '新步骤', detail: '描述这一步的具体行为', module: module.title });
    renderLensV2();
    explainLensChange(before, `在模块「${module.title}」添加步骤`);
  };
  host.append(kicker, title, moduleName, intro, add);
  const graph = document.createElement('div');
  graph.className = 'lens-detail-graph';
  const graphHeight = Math.max(150, module.steps.length * 120 + 25);
  graph.style.height = `${graphHeight}px`;
  host.append(graph);
  const graphWidth = graph.clientWidth;
  const nodeX = Math.max(25, (graphWidth - 190) / 2);
  const svg = svgElement('svg', { viewBox: `0 0 ${graphWidth} ${graphHeight}` });
  graph.append(svg);
  const rects = module.steps.map((step, index) => ({ id: step.id, x: lensStepPositions[step.id]?.x ?? nodeX, y: lensStepPositions[step.id]?.y ?? (22 + index * 120), w: 190, h: 77 }));
  const edgePaths = [];
  const redrawDetailEdges = () => {
    for (const item of edgePaths) {
      const d = routeGraphEdge(rects, item.edge.from, item.edge.fromPort || 'right', item.edge.to, item.edge.toPort || 'left', graphWidth, graphHeight);
      item.visible.setAttribute('d', d);
      item.hit.setAttribute('d', d);
    }
  };
  for (const [index, step] of module.steps.entries()) {
    const box = document.createElement('div');
    box.className = `lens-detail-node${selectedLensStep === step.id ? ' active' : ''}${pendingForStep(step.id) ? ' needs-review' : ''}${fixedStepIds.has(step.id) ? ' fixed' : ''}`;
    box.dataset.stepId = step.id;
    box.style.left = `${rects[index].x}px`;
    box.style.top = `${rects[index].y}px`;
    const name = document.createElement('strong');
    name.textContent = step.label;
    const detail = document.createElement('small');
    detail.textContent = step.detail;
    const remove = document.createElement('button');
    remove.className = 'lens-node-delete';
    remove.textContent = '×';
    remove.title = `删除步骤 ${step.label}`;
    remove.onclick = async event => {
      event.stopPropagation();
      if (fixedStepIds.has(step.id) && !await confirmCriticalChange(`删除关键步骤「${step.label}」？`, '这会移除该步骤、与它相连的依赖及关联决策，可能使后续步骤无法得到所需输入。你仍可继续删除。')) return;
      const before = clone(plans.lens);
      fixedStepIds.delete(step.id);
      plans.lens.steps = plans.lens.steps.filter(item => item.id !== step.id);
      plans.lens.edges = plans.lens.edges.filter(edge => edge.from !== step.id && edge.to !== step.id);
      plans.lens.assumptions = plans.lens.assumptions.filter(a => a.stepId !== step.id);
      delete lensStepPositions[step.id];
      renderLensV2();
      explainLensChange(before, `删除步骤「${step.label}」及其连接`);
    };
    for (const side of ['left', 'right']) {
      const port = document.createElement('button');
      port.className = `lens-step-port ${side}`;
      port.title = `连接${side === 'left' ? '左' : '右'}侧端点`;
      port.onclick = event => event.stopPropagation();
      port.onpointerdown = event => {
        event.preventDefault();
        event.stopPropagation();
        beginLensStepWire(graph, svg, step, index, side, event);
      };
      box.append(port);
    }
    box.append(name, detail, remove);
    box.onclick = () => { if (box.dataset.dragged === 'true') return; selectedLensStep = step.id; renderLensV2(); };
    graph.append(box);
    dragLensNode(box, graph, rects[index], rects, lensStepPositions, redrawDetailEdges);
  }
  const ids = new Set(module.steps.map(step => step.id));
  for (const edge of plans.lens.edges.filter(item => ids.has(item.from) && ids.has(item.to))) {
    const d = routeGraphEdge(rects, edge.from, edge.fromPort || 'right', edge.to, edge.toPort || 'left', graphWidth, graphHeight);
    if (!d) continue;
    const visible = svgElement('path', { d, class: 'lens-edge' });
    svg.append(visible);
    const hit = svgElement('path', { d, class: 'edge-hit', role: 'button', tabindex: 0, 'aria-label': '删除步骤关系' });
    hit.onclick = async () => {
      if (fixedEdges.has(edgeKey(edge)) && !await confirmCriticalChange('删除关键步骤连接？', '这会改变初始步骤之间的依赖，可能导致执行顺序或数据流发生变化。你仍可继续删除。')) return;
      const before = clone(plans.lens);
      fixedEdges.delete(edgeKey(edge));
      plans.lens.edges = plans.lens.edges.filter(item => item !== edge);
      renderLensV2();
      explainLensChange(before, `删除步骤关系「${plans.lens.steps.find(item => item.id === edge.from)?.label} → ${plans.lens.steps.find(item => item.id === edge.to)?.label}」`);
    };
    hit.onkeydown = event => { if (event.key === 'Enter') hit.click(); };
    svg.append(hit);
    edgePaths.push({ edge, visible, hit });
  }
  const selectedStep = module.steps.find(step => step.id === selectedLensStep);
  if (selectedStep) {
    const editor = document.createElement('div');
    editor.className = 'lens-step-editor';
    const label = document.createElement('label');
    label.textContent = '步骤名称';
    const name = document.createElement('input');
    name.value = selectedStep.label;
    name.onchange = async () => {
      if (!name.value.trim() || name.value.trim() === selectedStep.label) return;
      if (fixedStepIds.has(selectedStep.id) && !await confirmCriticalChange(`修改关键步骤「${selectedStep.label}」？`, '步骤名称用于表达任务意图，改变后可能影响其他步骤对它的理解及最终代码组织。你仍可继续修改。')) { name.value = selectedStep.label; return; }
      const before = clone(plans.lens);
      selectedStep.label = name.value.trim() || selectedStep.label;
      renderLensV2();
      explainLensChange(before, `修改步骤「${selectedStep.label}」的名称`);
    };
    label.append(name);
    const detailLabel = document.createElement('label');
    detailLabel.textContent = '步骤行为';
    const detail = document.createElement('textarea');
    detail.rows = 3;
    detail.value = selectedStep.detail;
    detail.onchange = async () => {
      if (detail.value === selectedStep.detail) return;
      if (fixedStepIds.has(selectedStep.id) && !await confirmCriticalChange(`修改关键步骤「${selectedStep.label}」的行为？`, '改变这一行为可能影响与它相连的输入、输出和后续实现。你仍可继续修改。')) { detail.value = selectedStep.detail; return; }
      const before = clone(plans.lens);
      selectedStep.detail = detail.value;
      renderLensV2();
      explainLensChange(before, `修改步骤「${selectedStep.label}」的行为`);
    };
    detailLabel.append(detail);
    editor.append(label, detailLabel);
    host.append(editor);
  }
  const decisions = plans.lens.assumptions.filter(a => ids.has(a.stepId));
  if (decisions.length) {
    const heading = document.createElement('h5');
    heading.textContent = `实现决策 · ${decisions.filter(item => !item.reviewed).length} 项待审核`;
    host.append(heading);
    for (const decision of decisions) {
      const card = document.createElement('div');
      card.className = `lens-decision${decision.reviewed ? ' reviewed' : ' pending'}`;
      const label = document.createElement('strong');
      label.textContent = `${decision.reviewed ? '已审核' : '待办决策'} · ${decision.title}`;
      const current = document.createElement('p');
      current.textContent = `当前方案：${decision.value || '尚未决定'}`;
      card.append(label, current);
      for (const option of decision.alternatives) {
        const row = document.createElement('div');
        row.className = 'decision-option';
        const name = document.createElement('strong');
        name.textContent = option.label;
        const impact = document.createElement('small');
        impact.textContent = `预期作用：${option.impact || '可点击“反馈”追问具体影响'}`;
        const actions = document.createElement('div');
        const feedback = document.createElement('button');
        feedback.type = 'button';
        feedback.className = 'quiet small';
        feedback.textContent = '反馈 · 追问';
        feedback.onclick = () => {
          selectedLensStep = decision.stepId;
          chatPreset[`step:${decision.stepId}`] = `${decision.title}：${option.label}。预期作用：${option.impact}`;
          renderLensV2();
          $('lensInspector').querySelector('.lens-chat textarea')?.focus();
        };
        const apply = document.createElement('button');
        apply.type = 'button';
        apply.className = 'secondary small';
        apply.textContent = '采用此方案';
        apply.onclick = () => {
          decision.value = option.label;
          decision.reviewed = true;
          renderLensV2();
          markChanged();
          appendLensLog(`采用预设方案「${decision.title}：${option.label}」`, '已写入计划；该决策完成审核。');
        };
        actions.append(feedback, apply);
        row.append(name, impact, actions);
        card.append(row);
      }
      const custom = document.createElement('div');
      custom.className = 'decision-custom';
      const value = document.createElement('textarea');
      value.rows = 2;
      value.placeholder = '自定义实现方式…';
      const feedbackInput = document.createElement('textarea');
      feedbackInput.rows = 2;
      feedbackInput.placeholder = '希望 Assumption Lens 重点评估什么影响？';
      const submit = document.createElement('button');
      submit.type = 'button';
      submit.className = 'secondary small';
      submit.textContent = '采用并评估自定义方案';
      submit.onclick = () => {
        if (!value.value.trim() || !feedbackInput.value.trim()) return toast('请写出自定义方案和希望评估的问题');
        const before = clone(plans.lens);
        decision.value = value.value.trim();
        decision.reviewed = true;
        renderLensV2();
        explainLensChange(before, `采用自定义方案「${decision.title}：${decision.value}」；用户反馈：${feedbackInput.value.trim()}`);
      };
      custom.append(value, feedbackInput, submit);
      const source = document.createElement('small');
      source.textContent = decision.source ? `需求依据：「${decision.source}」` : '原始需求未明确说明';
      card.append(custom, source);
      host.append(card);
    }
  }
  const contextStep = module.steps.find(step => step.id === selectedLensStep);
  renderLensChat(host, contextStep ? `step:${contextStep.id}` : `module:${module.title}`, contextStep ? { type: 'step', id: contextStep.id, label: contextStep.label, detail: contextStep.detail, module: module.title } : { type: 'module', label: module.title, steps: module.steps });
}

async function startAnalysis() {
  input = $('request').value.trim();
  if (input.length < 5) return toast('请先输入完整需求');
  setBusy(true, 'Assumption Lens 正在提取分层任务结构…');
  try {
    const result = await api('analyze', { input });
    original = normalize(result);
    plans = { text: textFromPlan(original), graph: clone(original), lens: clone(original) };
    fixedStepIds = new Set(original.steps.map(step => step.id));
    fixedModules = new Set(buildModules(original).map(module => module.title));
    fixedEdges = new Set(original.edges.map(edgeKey));
    lensChats = {};
    chatPreset = {};
    positions = {};
    selectedNode = null;
    selectedEdge = null;
    selectedLensModule = null;
    selectedLensStep = null;
    lensModulePositions = {};
    lensStepPositions = {};
    pendingLensStep = null;
    $('lensImpactFeed').innerHTML = '<span class="kicker">操作日志</span><p>新增、修改、删除记录会显示在这里；需要追问时请使用节点旁的对话窗口。</p>';
    $('sourceText').textContent = input;
    $('workspace').classList.remove('hidden');
    showMode('lens');
    $('workspace').scrollIntoView({ behavior: 'smooth', block: 'start' });
    toast('分析完成，可以从模块展开查看细节。');
  } catch (error) { toast(error.message); }
  finally { setBusy(false); }
}

async function generate() {
  if (!original) return;
  if (mode === 'lens' && plans.lens.assumptions.some(item => !item.reviewed)) return toast('还有待办决策。请在高亮节点中采用方案后再生成。');
  setBusy(true, 'Assumption Lens 正在根据审查结果生成代码…');
  try {
    if (mode === 'lens') await lensImpactQueue;
    const result = await api('generate', { input, plan: plans[mode], mode });
    outputText = result.output;
    $('output').textContent = outputText;
    $('outputPanel').classList.remove('hidden');
    $('outputPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    toast('生成完成');
  } catch (error) { toast(error.message); }
  finally { setBusy(false); }
}

$('sample').onclick = () => { $('request').value = sample; toast('已载入缺失值示例'); };
$('analyze').onclick = startAnalysis;
$('generate').onclick = generate;
for (const button of document.querySelectorAll('.tab')) button.onclick = () => showMode(button.dataset.mode);
$('saveText').onclick = () => { plans.text = $('textPlan').value; markChanged(); toast('文字计划已应用'); };
$('textPlan').addEventListener('input', () => { plans.text = $('textPlan').value; markChanged(); });
$('addNode').onclick = () => {
  const plan = plans.graph;
  const id = `s${Math.max(0, ...plan.steps.map(step => Number(step.id.replace(/\D/g, '')) || 0)) + 1}`;
  const nextY = Math.max(34, ...Object.values(positions).map(point => point.y + 142));
  plan.steps.push({ id, label: '新任务', detail: '请描述这一步的具体行为', module: '' });
  positions[id] = { x: 34, y: nextY };
  $('graphCanvas').style.minHeight = `${nextY + 130}px`;
  selectedNode = id;
  renderGraph();
  $('nodeEditor').classList.remove('hidden');
  $('nodeLabel').value = '新任务';
  $('nodeDetail').value = '请描述这一步的具体行为';
  markChanged();
};
$('resetLayout').onclick = () => { layout(); renderGraph(); };
$('closeEditor').onclick = () => { $('nodeEditor').classList.add('hidden'); selectedNode = null; renderGraph(); };
$('saveNode').onclick = () => {
  const step = plans.graph.steps.find(item => item.id === selectedNode);
  if (!step) return;
  step.label = $('nodeLabel').value.trim() || step.label;
  step.detail = $('nodeDetail').value.trim();
  renderGraph();
  markChanged();
  toast('节点已更新');
};
$('deleteNode').onclick = () => {
  plans.graph.steps = plans.graph.steps.filter(step => step.id !== selectedNode);
  plans.graph.edges = plans.graph.edges.filter(edge => edge.from !== selectedNode && edge.to !== selectedNode);
  delete positions[selectedNode];
  selectedNode = null;
  selectedEdge = null;
  $('nodeEditor').classList.add('hidden');
  renderGraph();
  markChanged();
};
$('deleteEdge').onclick = deleteSelectedEdge;
document.addEventListener('keydown', event => {
  if (mode !== 'graph' || selectedEdge === null || !['Delete', 'Backspace'].includes(event.key)) return;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
  event.preventDefault();
  deleteSelectedEdge();
});
$('graphCanvas').addEventListener('pointerdown', event => {
  if (event.target === $('graphCanvas')) { selectedEdge = null; pendingStart = null; drawEdges(); }
});
$('addLensModule').onclick = () => {
  if (!plans.lens) return;
  const before = clone(plans.lens);
  const id = `s${Date.now()}`;
  const title = `新模块 ${buildModules(plans.lens).length + 1}`;
  plans.lens.steps.push({ id, label: '新步骤', detail: '描述此模块的目标与行为', module: title });
  selectedLensModule = title;
  renderLensV2();
  explainLensChange(before, `新增模块「${title}」`);
};
$('copyOutput').onclick = async () => {
  try { await navigator.clipboard.writeText(outputText); toast('已复制'); }
  catch { toast('浏览器无法复制，请手动选中结果'); }
};

let currentShareUrl = '';
function showAuthNotice() {
  authenticated = false;
  $('authNotice').classList.remove('hidden');
  $('shareStatus').textContent = '当前链接已失效';
  $('shareUrl').value = '请使用本次启动窗口中的完整网址';
  $('copyShare').disabled = true;
  currentShareUrl = '';
  setBusy(false);
}
async function refreshHealth() {
  try {
    const response = await fetch('/api/health');
    const data = await response.json();
    $('model').textContent = data.provider === 'deepseek' ? `DeepSeek API · ${data.model}` : data.model;
    $('connection').textContent = '● 服务已连接';
    $('connection').classList.remove('error');
    if (!code || !(await fetch('/api/session-check', { headers: { Authorization: `Bearer ${code}` } })).ok) {
      showAuthNotice();
      clearInterval(healthTimer);
      return;
    }
    authenticated = true;
    $('authNotice').classList.add('hidden');
    $('analyze').disabled = !$('loading').classList.contains('hidden');
    $('generate').disabled = !$('loading').classList.contains('hidden');
    let url = data.publicUrl || data.lanUrl || '';
    if (url) url += `${url.includes('?') ? '&' : '?'}code=${encodeURIComponent(code)}`;
    currentShareUrl = url;
    $('shareStatus').textContent = data.publicUrl ? '临时公网链接已就绪' : data.lanUrl ? '局域网链接已就绪' : '正在创建分享链接';
    $('shareUrl').value = url || '启动后会在这里显示可分享的网址';
    $('copyShare').disabled = !url;
    if (data.publicUrl) clearInterval(healthTimer);
  } catch {
    $('connection').textContent = '● 无法连接';
    $('connection').classList.add('error');
  }
}
$('shareUrl').onclick = () => $('shareUrl').select();
$('copyShare').onclick = async () => {
  if (!currentShareUrl) return;
  try { await navigator.clipboard.writeText(currentShareUrl); toast('分享网址已复制'); }
  catch {
    const field = $('shareUrl');
    field.select();
    if (document.execCommand('copy')) toast('分享网址已复制');
    else toast('请按 Ctrl+C 复制已选中的网址');
  }
};
const healthTimer = setInterval(refreshHealth, 2500);
refreshHealth();
