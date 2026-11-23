// Month animals made of dots, drawn in a 100 × 60 box.
// Each animal is a list of strokes (outlines) plus single dots (eyes etc.).
// Strokes are turned into evenly spaced dots; the order of strokes is the
// order dots get coloured. Busy months add extra dots: first between the
// outline dots, then filling the shapes marked `fill`.
//
// To add your own drawn animal later: add another entry with its strokes.

const TAU = Math.PI * 2;

// ---------- shape helpers ----------
function ellipse(cx, cy, rx, ry, opts = {}) {
  const { from = 0, to = TAU, rot = 0, fill = false } = opts;
  const closed = Math.abs(to - from - TAU) < 1e-6;
  const pts = [];
  const n = 120;
  const cos = Math.cos(rot), sin = Math.sin(rot);
  for (let i = 0; i <= n; i++) {
    const a = from + ((to - from) * i) / n;
    const x = rx * Math.cos(a), y = ry * Math.sin(a);
    pts.push([cx + x * cos - y * sin, cy + x * sin + y * cos]);
  }
  if (closed) pts.pop();
  return { pts, closed, fill };
}
const circle = (cx, cy, r, opts) => ellipse(cx, cy, r, r, opts);
const line = (...pts) => ({ pts, closed: false, fill: false });
function smooth(pts, steps = 12) {
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    for (let k = 0; k < steps; k++) {
      const t = k / steps, t2 = t * t, t3 = t2 * t;
      out.push([0, 1].map((d) => 0.5 * (2 * p1[d] + (-p0[d] + p2[d]) * t + (2 * p0[d] - 5 * p1[d] + 4 * p2[d] - p3[d]) * t2 + (-p0[d] + 3 * p1[d] - 3 * p2[d] + p3[d]) * t3)));
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}
const curve = (...pts) => ({ pts: smooth(pts), closed: false, fill: false });
const shape = (pts, fill = false) => ({ pts, closed: true, fill });
const dots = (...pts) => ({ pts, single: true });
// An area that only gets filled with extra dots in busy months (no outline dots of its own).
const area = (pts, holes = []) => ({ pts, fillOnly: true, holes });
const halfEllipse = (cx, cy, rx, ry) => {
  const e = ellipse(cx, cy, rx, ry, { from: Math.PI, to: TAU }).pts;
  return [...e, [cx - rx, cy]];
};

// ---------- turning strokes into dots ----------
function resample(stroke, spacing) {
  const p = stroke.closed ? [...stroke.pts, stroke.pts[0]] : stroke.pts;
  const seg = [];
  let total = 0;
  for (let i = 1; i < p.length; i++) {
    const d = Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
    seg.push(d);
    total += d;
  }
  const count = Math.max(stroke.closed ? 3 : 2, Math.round(total / spacing) + (stroke.closed ? 0 : 1));
  const step = stroke.closed ? total / count : total / (count - 1);
  const out = [];
  let si = 0, acc = 0;
  for (let k = 0; k < count; k++) {
    const target = k * step;
    while (si < seg.length - 1 && acc + seg[si] < target) { acc += seg[si]; si++; }
    const t = seg[si] ? Math.min(1, (target - acc) / seg[si]) : 0;
    out.push([p[si][0] + (p[si + 1][0] - p[si][0]) * t, p[si][1] + (p[si + 1][1] - p[si][1]) * t]);
  }
  return out;
}

function inside(pt, poly) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

export function buildAnimal(def) {
  const spacing = def.spacing || 7;
  const base = [];
  const extra = [];
  const fills = [];
  for (const s of def.strokes) {
    if (s.single) { base.push(...s.pts); continue; }
    if (s.fillOnly) { fills.push({ pts: s.pts, holes: s.holes || [] }); continue; }
    const r = resample(s, s.spacing || spacing)
      .filter((pt) => base.every((q) => Math.hypot(pt[0] - q[0], pt[1] - q[1]) >= 4.6));
    if (!r.length) continue;
    base.push(...r);
    const pairs = s.closed ? r.length : r.length - 1;
    for (let i = 0; i < pairs; i++) {
      const a = r[i], b = r[(i + 1) % r.length];
      extra.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
    }
    if (s.fill) fills.push({ pts: s.pts, holes: [] });
  }
  const taken = [...base, ...extra];
  const free = (p, d) => taken.every((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) >= d);
  const inner = [];
  for (const { pts: poly, holes } of fills) {
    const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const found = [];
    for (let y = Math.min(...ys) + 3; y <= Math.max(...ys) - 3; y += 6) {
      for (let x = Math.min(...xs) + 3; x <= Math.max(...xs) - 3; x += 6) {
        const p = [x, y];
        if (inside(p, poly) && free(p, 5.5) && holes.every(([hx, hy, hr]) => Math.hypot(x - hx, y - hy) > hr)) { found.push(p); taken.push(p); }
      }
    }
    found.sort((a, b) => Math.hypot(a[0] - cx, a[1] - cy) - Math.hypot(b[0] - cx, b[1] - cy));
    inner.push(...found);
  }
  extra.push(...inner);
  return { name: def.name, base, extra };
}

// ---------- the twelve animals (index 0 = January) ----------
const DEFS = [
  { // January
    name: "Penguin",
    strokes: [
      // back of the neck, up over the crown, down the forehead to the beak
      curve([27, 58], [21, 45], [20, 31], [25, 18], [36, 8], [50, 5], [61, 8], [68, 16]),
      // beak: long and slim, curving slightly down to the tip
      curve([68, 16], [79, 17], [89, 20], [97, 25]),
      curve([97, 25], [88, 24], [78, 23], [69, 23]),
      // chin and throat down to the neck
      curve([69, 23], [64, 31], [60, 41], [58, 51], [58, 58]),
      // cheek patch behind the eye
      curve([41, 21], [42, 29], [47, 36], [54, 40]),
      dots([55, 15])
    ]
  },
  { // February
    name: "Owl",
    strokes: [
      // head: two soft "ear" corners with a dip between, down to a heart-shaped chin
      { ...curve([50, 58], [40, 54], [24, 46], [14, 32], [15, 15], [27, 4], [40, 6], [50, 12],
                 [60, 6], [73, 4], [85, 15], [86, 32], [76, 46], [60, 54], [50, 58]), spacing: 7.5 },
      // big round eyes with pupils
      circle(35, 31, 6.8, { spacing: 7 }),
      circle(65, 31, 6.8, { spacing: 7 }),
      dots([35, 31], [65, 31]),
      // eyebrows
      { ...curve([27, 18], [35, 14], [43, 18]), spacing: 7 },
      { ...curve([57, 18], [65, 14], [73, 18]), spacing: 7 },
      // small V beak
      { ...line([45, 41], [50, 50], [55, 41]), spacing: 5.4 }
    ]
  },
  { // March
    name: "Elephant",
    strokes: [
      // one outline: crown, forehead, down the trunk to its curled tip,
      // back up the inside of the trunk, under the jaw
      { ...curve(...[[62, 12], [48, 4], [34, 5], [25, 13], [21, 25], [18, 37], [18, 48], [22, 56], [29, 57], [32, 51], [28, 47], [27, 38], [30, 30], [36, 33], [46, 37], [56, 34], [62, 26]]), spacing: 6.5 },
      // big ear flap behind the head
      { ...curve(...[[60, 9], [72, 3], [85, 9], [90, 24], [85, 40], [72, 47], [62, 40]]), spacing: 7 },
      dots([39, 17]),
      area(smooth([...[[60, 9], [72, 3], [85, 9], [90, 24], [85, 40], [72, 47], [62, 40]], [62, 26], [62, 12], [60, 9]]))
    ]
  },
  { // April
    name: "Bunny",
    strokes: [
      // round head
      ellipse(51, 44, 20, 14.5, { spacing: 7 }),
      // two tall ears, the right one tilting outward
      { ...curve(...[[42, 30], [37, 17], [37, 6], [42, 2], [47, 7], [48, 19], [48, 29]]), spacing: 6.5 },
      { ...curve(...[[55, 29], [58, 17], [63, 7], [69, 6], [70, 13], [66, 23], [61, 31]]), spacing: 6.5 },
      // eyes, nose and a smile
      dots([43, 41], [59, 41], [51, 46]),
      { ...curve([45, 50], [51, 53.5], [57, 50]), spacing: 6 },
      area(smooth([[42, 30], [37, 17], [37, 6], [42, 2], [47, 7], [48, 19], [48, 29]])),
      area(smooth([[55, 29], [58, 17], [63, 7], [69, 6], [70, 13], [66, 23], [61, 31]]))
    ]
  },
  { // May
    name: "Butterfly",
    strokes: [
      // both wings in one outline: big rounded upper wings, smaller lower wings
      { ...curve(...[[50.0, 25], [45.0, 19], [37.8, 9], [28.4, 6], [21.2, 11], [19.0, 22], [23.4, 31], [28.4, 34], [23.4, 40], [22.6, 50], [29.1, 57], [37.8, 56], [45.0, 49], [50.0, 45], [55.0, 49], [62.2, 56], [70.9, 57], [77.4, 50], [76.6, 40], [71.6, 34], [76.6, 31], [81.0, 22], [78.8, 11], [71.6, 6], [62.2, 9], [55.0, 19], [50.0, 25]]), spacing: 7 },
      // small body down the middle
      { ...line([50, 31], [50, 39]), spacing: 6 },
      // tall curved antennae with round tips
      { ...curve([49, 23], [47, 13], [43, 3]), spacing: 6 },
      { ...curve([51, 23], [53, 13], [57, 3]), spacing: 6 },
      // wings fill up with dots in busy months (no face here)
      area(smooth([[50.0, 25], [45.0, 19], [37.8, 9], [28.4, 6], [21.2, 11], [19.0, 22], [23.4, 31], [28.4, 34], [23.4, 40], [22.6, 50], [29.1, 57], [37.8, 56], [45.0, 49], [50.0, 45], [55.0, 49], [62.2, 56], [70.9, 57], [77.4, 50], [76.6, 40], [71.6, 34], [76.6, 31], [81.0, 22], [78.8, 11], [71.6, 6], [62.2, 9], [55.0, 19], [50.0, 25]]))
    ]
  },
  { // June
    name: "Snail",
    strokes: [
      // big round shell with a spiral
      circle(62, 27, 21, { spacing: 7.5 }),
      { ...curve(...[[63.2, 29.3], [66.7, 25.8], [63.2, 21.2], [56.2, 23.5], [53.8, 31.7], [59.7, 37.5], [69.0, 36.3], [73.7, 28.2]]), spacing: 7 },
      // head and long foot in one outline
      { ...curve(...[[39, 42], [36, 27], [29, 16], [18, 14], [8, 20], [5, 32], [11, 42], [19, 47], [20, 53], [28, 57], [50, 57], [72, 55], [91, 56], [96, 51], [90, 46], [82, 44]]), spacing: 7.5 },
      // antennae with round tips
      { ...line([15, 16], [9, 3]), spacing: 6.5 },
      { ...line([27, 17], [32, 4]), spacing: 6.5 },
      // eyes
      dots([14, 28], [27, 28]),
      // shell and foot fill up in busy months (face stays clear)
      area(circle(62, 27, 20).pts),
      area(smooth([[24, 52], [28, 57], [50, 57], [72, 55], [91, 56], [96, 51], [90, 46], [82, 44], [64, 48], [44, 49], [30, 50]]))
    ]
  },
  { // July
    name: "Turtle",
    strokes: [
      // domed shell and the rim under it
      { ...ellipse(60, 38, 27, 27, { from: Math.PI, to: TAU }), spacing: 7 },
      { ...curve([33, 38], [36, 44], [60, 46], [84, 44], [87, 38]), spacing: 7 },
      // round spots on the shell
      circle(49, 26, 4.5, { spacing: 6.5 }),
      circle(66, 19, 4.5, { spacing: 6.5 }),
      circle(73, 32, 4.5, { spacing: 6.5 }),
      // head on a raised neck
      ellipse(12, 21, 8.5, 7, { spacing: 7 }),
      { ...curve([20, 25], [27, 31], [33, 37]), spacing: 7 },
      { ...curve([13, 30], [20, 38], [29, 43], [35, 44]), spacing: 7 },
      // four stubby legs
      { ...line([41, 51], [41, 57]), spacing: 6 },
      { ...line([53, 52], [53, 58]), spacing: 6 },
      { ...line([67, 52], [67, 58]), spacing: 6 },
      { ...line([79, 51], [79, 57]), spacing: 6 },
      // the shell fills up around the spots in busy months
      area(halfEllipse(60, 38, 25, 25), [[49, 26, 7], [66, 19, 7], [73, 32, 7]])
    ]
  },
  { // August
    name: "Shark",
    strokes: [
      // body with pointed nose and forked tail, in one outline
      { ...curve(...[[6, 31], [18, 21], [38, 16], [58, 17], [74, 23], [83, 29], [91, 17], [97, 10], [93, 24], [90, 32], [94, 42], [97, 52], [89, 44], [83, 35], [70, 41], [50, 46], [30, 46], [15, 41], [6, 31]]), spacing: 7 },
      // big fin on top
      { ...curve([35, 17], [43, 9], [55, 1], [54, 10], [61, 18]), spacing: 7 },
      // side fin underneath, sweeping back
      { ...curve([38, 46], [44, 54], [56, 59], [56, 51], [50, 46]), spacing: 7 },
      // eye
      dots([19, 27]),
      // body fills up in busy months, the face stays clear
      area(smooth([[30, 46], [50, 46], [70, 41], [83, 35], [83, 29], [74, 23], [58, 17], [38, 16], [30, 18]]))
    ]
  },
  { // September
    name: "Hedgehog",
    strokes: [
      // spiky quills over the back: a dot on every tip and dip
      dots(...[[11.7, 54.0], [17.9, 48.1], [10.4, 44.0], [17.9, 39.9], [11.7, 34.0], [20.1, 31.9], [15.7, 24.7], [24.3, 24.8], [22.0, 16.8], [30.3, 19.0], [30.2, 10.7], [37.6, 14.9], [39.8, 6.8], [45.8, 12.8], [50.0, 5.5], [54.2, 12.8], [60.2, 6.8], [62.4, 14.9], [69.8, 10.7]]),
      // head: forehead out to the pointed snout, back under the chin to the front foot
      { ...curve([71, 9], [78, 15], [87, 24], [96, 33], [88, 39], [77, 41], [69, 47], [66, 55]), spacing: 7 },
      // line between the head and the spiky body
      { ...curve([62, 25], [59, 37], [59, 54]), spacing: 7 },
      // eye and nose
      dots([77, 26], [97, 33]),
      // two little feet
      { ...line([26, 57], [33, 57]), spacing: 6 },
      { ...line([59, 58], [66, 58]), spacing: 6 },
      // the spiky body fills up in busy months, the face stays clear
      area([[21.5, 51.4], [20.7, 47.7], [20.5, 44.0], [20.7, 40.3], [21.5, 36.6], [22.7, 33.0], [24.4, 29.6], [26.6, 26.5], [29.1, 23.7], [32.0, 21.2], [35.2, 19.1], [38.7, 17.5], [42.4, 16.3], [46.1, 15.5], [50.0, 15.3], [53.9, 15.5], [57.6, 16.3], [61.3, 17.5], [64.8, 19.1], [62, 28], [59, 40], [59, 54], [24, 54]])
    ]
  },
  { // October
    name: "Cat",
    strokes: [
      // round head with two pointed ears (straight lines give sharp tips)
      { ...line([27.4, 17], [30.5, 2], [40.6, 10]), spacing: 6.5 },
      { ...curve([40.6, 10], [50.0, 8.5], [59.4, 10]), spacing: 7 },
      { ...line([59.4, 10], [69.5, 2], [72.6, 17]), spacing: 6.5 },
      { ...curve([72.6, 17], [78.1, 31], [75.0, 46], [63.3, 55], [50.0, 58], [36.7, 55], [25.0, 46], [21.9, 31], [27.4, 17]), spacing: 7 },
      // eyes and nose (the face stays clear in busy months)
      dots([39.9, 24], [60.1, 24], [50, 36]),
      // mouth: down from the nose, then curving out to each side
      { ...line([50, 36], [50, 41.5]), spacing: 5 },
      { ...curve([50, 41.5], [46, 45.5], [41.5, 43.5]), spacing: 4.8 },
      { ...curve([50, 41.5], [54, 45.5], [58.5, 43.5]), spacing: 4.8 },
      // whiskers growing out of the cheeks, two on each side
      { ...line([22, 30], [10, 26]), spacing: 5.5 },
      { ...line([23.5, 39], [11, 42]), spacing: 5.5 },
      { ...line([78, 30], [90, 26]), spacing: 5.5 },
      { ...line([76.5, 39], [89, 42]), spacing: 5.5 }
    ]
  },
  null, // November: the fish (special, see below)
  { // December
    name: "Reindeer",
    strokes: [
      // head: forehead down the long snout, round nose, back under the jaw
      { ...curve([64, 34], [53, 27], [39, 28], [25, 36], [13, 42]), spacing: 7 },
      circle(8.5, 45, 4.3, { spacing: 5.5 }),
      { ...curve([12, 49.5], [26, 52.5], [42, 52.5], [54, 49], [61, 43], [64, 34]), spacing: 7 },
      // branching antlers, spreading out to each side
      { ...curve([41, 28], [36, 15], [27, 0]), spacing: 6.5 },
      { ...line([35, 12], [23, 10]), spacing: 6 },
      { ...line([38, 21], [27, 23]), spacing: 6 },
      { ...curve([51, 27], [57, 15], [66, 0]), spacing: 6.5 },
      { ...line([58, 11], [70, 9]), spacing: 6 },
      { ...line([55, 19], [66, 20]), spacing: 6 },
      // ear on the back of the head
      { ...curve([63, 38], [73, 32], [79, 34], [67, 43]), spacing: 5.5 },
      // a little neck
      { ...line([48, 52], [51, 60]), spacing: 6 },
      { ...line([62, 44], [66, 60]), spacing: 6 },
      // eye
      dots([37, 37])
    ]
  }
];

// The November fish, kept exactly as it first appeared.
function buildFish() {
  const base = [];
  const cx = 40, cy = 30, rx = 28, ry = 22, bodyN = 18;
  const body = [];
  for (let i = 0; i < bodyN; i++) {
    const a = Math.PI + (i * 2 * Math.PI) / bodyN;
    body.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  base.push(...body);
  const tail = [[72, 20], [79, 15], [86, 10], [90, 22], [90, 30], [90, 38], [86, 50], [79, 45], [72, 40]];
  base.push(...tail);
  const eye = [27, 25];
  base.push(eye);
  const extra = [];
  const mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  for (let i = 0; i < bodyN; i++) extra.push(mid(body[i], body[(i + 1) % bodyN]));
  for (let i = 0; i < tail.length - 1; i++) extra.push(mid(tail[i], tail[i + 1]));
  const taken = [...base, ...extra];
  const free = (p, d) => taken.every((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) >= d);
  const inner = [];
  for (let y = cy - ry + 6; y <= cy + ry - 6; y += 6) {
    for (let x = cx - rx + 6; x <= cx + rx - 4; x += 6) {
      const ins = ((x - cx) / (rx - 4)) ** 2 + ((y - cy) / (ry - 4)) ** 2 <= 1;
      if (ins && free([x, y], 5) && Math.hypot(x - eye[0], y - eye[1]) > 7) inner.push([x, y]);
    }
  }
  for (const p of [[80, 22], [84, 30], [80, 38], [76, 30]]) if (free(p, 5)) inner.push(p);
  inner.sort((p, q) => Math.hypot(p[0] - cx, p[1] - cy) - Math.hypot(q[0] - cx, q[1] - cy));
  extra.push(...inner);
  return { name: "Fish", base, extra };
}

export const ANIMALS = DEFS.map((d) => (d ? buildAnimal(d) : buildFish()));
