import assert from 'node:assert/strict';
import { routeGraphEdge } from '../web/graph-routing.js';

const cases = [
  { name: '横向节点与中间障碍', rects: [{ id: 'a', x: 34, y: 30, w: 190, h: 92 }, { id: 'block', x: 280, y: 30, w: 190, h: 92 }, { id: 'b', x: 540, y: 30, w: 190, h: 92 }], from: 'a', fromSide: 'right', to: 'b', toSide: 'left', width: 800, height: 280 },
  { name: '右侧目标端口', rects: [{ id: 'a', x: 34, y: 30, w: 190, h: 92 }, { id: 'b', x: 540, y: 172, w: 190, h: 92 }], from: 'a', fromSide: 'right', to: 'b', toSide: 'right', width: 800, height: 320 },
  { name: '纵向步骤', rects: [{ id: 'a', x: 37, y: 22, w: 190, h: 77 }, { id: 'b', x: 37, y: 142, w: 190, h: 77 }, { id: 'c', x: 37, y: 262, w: 190, h: 77 }], from: 'a', fromSide: 'right', to: 'c', toSide: 'left', width: 280, height: 390 }
];

for (const sample of cases) {
  const path = routeGraphEdge(sample.rects, sample.from, sample.fromSide, sample.to, sample.toSide, sample.width, sample.height);
  assert.ok(path, `${sample.name} 应当有可行路径`);
  const points = [...path.matchAll(/[ML]\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g)].map(match => ({ x: Number(match[1]), y: Number(match[2]) }));
  const from = sample.rects.find(rect => rect.id === sample.from);
  const to = sample.rects.find(rect => rect.id === sample.to);
  assert.deepEqual(points[0], { x: from.x + (sample.fromSide === 'right' ? from.w : 0), y: from.y + from.h / 2 });
  assert.deepEqual(points.at(-1), { x: to.x + (sample.toSide === 'right' ? to.w : 0), y: to.y + to.h / 2 });
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1], b = points[index];
    assert.ok(a.x === b.x || a.y === b.y, `${sample.name} 只能使用正交线段`);
    for (const rect of sample.rects) {
      const crosses = a.x === b.x
        ? a.x > rect.x && a.x < rect.x + rect.w && Math.max(a.y, b.y) > rect.y && Math.min(a.y, b.y) < rect.y + rect.h
        : a.y > rect.y && a.y < rect.y + rect.h && Math.max(a.x, b.x) > rect.x && Math.min(a.x, b.x) < rect.x + rect.w;
      assert.ok(!crosses, `${sample.name} 的线段穿过 ${rect.id}`);
    }
  }
}

console.log(`${cases.length} 个连线路由场景通过`);
