const unique = values => [...new Set(values)].sort((a, b) => a - b);

export function routeGraphEdge(rectangles, fromId, fromSide, toId, toSide, width, height) {
  const from = rectangles.find(rect => rect.id === fromId);
  const to = rectangles.find(rect => rect.id === toId);
  if (!from || !to) return '';
  const port = (rect, side) => ({ x: rect.x + (side === 'right' ? rect.w : 0), y: rect.y + rect.h / 2 });
  const start = port(from, fromSide), end = port(to, toSide);
  const lead = (point, side) => ({ x: point.x + (side === 'right' ? 26 : -26), y: point.y });
  const a = lead(start, fromSide), b = lead(end, toSide);
  const blockers = rectangles.map(rect => ({ left: rect.x - 11, right: rect.x + rect.w + 11, top: rect.y - 11, bottom: rect.y + rect.h + 11 }));
  const xs = unique([6, width - 6, a.x, b.x, ...blockers.flatMap(box => [box.left - 7, box.right + 7])]);
  const ys = unique([6, height - 6, a.y, b.y, ...blockers.flatMap(box => [box.top - 7, box.bottom + 7])]);
  const valid = (x, y) => x >= 4 && x <= width - 4 && y >= 4 && y <= height - 4 && !blockers.some(box => x > box.left && x < box.right && y > box.top && y < box.bottom);
  const clear = (x1, y1, x2, y2) => !blockers.some(box => {
    if (x1 === x2) return x1 > box.left && x1 < box.right && Math.max(y1, y2) > box.top && Math.min(y1, y2) < box.bottom;
    return y1 > box.top && y1 < box.bottom && Math.max(x1, x2) > box.left && Math.min(x1, x2) < box.right;
  });
  const startX = xs.indexOf(a.x), startY = ys.indexOf(a.y);
  const endX = xs.indexOf(b.x), endY = ys.indexOf(b.y);
  const key = (x, y, dir) => `${x},${y},${dir}`;
  const queue = [{ x: startX, y: startY, dir: 0, cost: 0, score: 0 }];
  const best = new Map([[key(startX, startY, 0), 0]]);
  const previous = new Map();
  let goal = null;
  while (queue.length) {
    queue.sort((left, right) => left.score - right.score);
    const current = queue.shift();
    const currentKey = key(current.x, current.y, current.dir);
    if (current.cost !== best.get(currentKey)) continue;
    if (current.x === endX && current.y === endY) { goal = currentKey; break; }
    for (const [dx, dy, dir] of [[1, 0, 1], [-1, 0, 1], [0, 1, 2], [0, -1, 2]]) {
      const nx = current.x + dx, ny = current.y + dy;
      if (nx < 0 || nx >= xs.length || ny < 0 || ny >= ys.length) continue;
      if (!valid(xs[nx], ys[ny]) || !clear(xs[current.x], ys[current.y], xs[nx], ys[ny])) continue;
      const cost = current.cost + Math.abs(xs[nx] - xs[current.x]) + Math.abs(ys[ny] - ys[current.y]) + (current.dir && current.dir !== dir ? 18 : 0);
      const nextKey = key(nx, ny, dir);
      if (cost >= (best.get(nextKey) ?? Infinity)) continue;
      best.set(nextKey, cost);
      previous.set(nextKey, currentKey);
      queue.push({ x: nx, y: ny, dir, cost, score: cost + Math.abs(xs[nx] - xs[endX]) + Math.abs(ys[ny] - ys[endY]) });
    }
  }
  if (!goal) return '';
  const points = [];
  for (let cursor = goal; cursor; cursor = previous.get(cursor)) {
    const [x, y] = cursor.split(',').map(Number);
    points.push({ x: xs[x], y: ys[y] });
  }
  points.reverse();
  return [`M ${start.x} ${start.y}`, `L ${a.x} ${a.y}`, ...points.slice(1).map(point => `L ${point.x} ${point.y}`), `L ${end.x} ${end.y}`].join(' ');
}
