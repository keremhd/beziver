'use strict';

// Renders the emitted OpenSCAD in real OpenSCAD. Unit tests can prove the
// numbers are right but not that the .scad looks like what you meant --
// splinesteps being per-patch, and showcps being off, both produced perfectly
// valid files that looked wrong on screen. Skips cleanly if OpenSCAD is absent.

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const F = require('../src/fit.js');
const C = require('../src/contour.js');
const Wp = require('../src/warp.js');
const R = require('../src/report.js');
const STL = require('../src/stl.js');
const SAMPLE = require('../src/sample.js');

const probe = spawnSync('openscad', ['--version'], { encoding: 'utf8' });
if (probe.error) {
    console.log('openscad not found on PATH - skipping render check');
    process.exit(0);
}
console.log((probe.stdout || probe.stderr || '').trim());

let pass = 0, fail = 0;
const check = (n, c, e) => {
    if (c) { pass++; console.log('  ok   ' + n + (e ? '  [' + e + ']' : '')); }
    else { fail++; console.log('  FAIL ' + n + (e ? '  [' + e + ']' : '')); }
};

// ------------------------------------------------------- manifoldness check

// "It exported something" is not "it is printable". A sheet exports facets
// too. What makes a mesh printable is that it is CLOSED: every edge is shared
// by exactly two triangles, those two traverse it in opposite directions
// (consistent winding), and the enclosed volume is positive rather than
// inside-out. This is the assertion that would have caught the zero-facet
// regression of HANDOFF 5.3 instantly, and it is the one that means the owner
// can hit F6 and print the result.
//
// Written against the exported STL rather than against anything beziver
// computes, so it is checking OpenSCAD's actual output.
function meshCheck(buf) {
    const { verts, count } = STL.parseSTL(buf);

    // Weld by exact coordinate. OpenSCAD writes one double per coordinate and
    // the same vertex is written from the same double every time, so identical
    // corners land on identical text and identical float32s -- no tolerance
    // needed, and a tolerance would hide a real crack.
    const ids = new Map();
    const idx = new Int32Array(count * 3);
    const pts = [];
    for (let t = 0; t < count * 3; t++) {
        const x = verts[t * 3], y = verts[t * 3 + 1], z = verts[t * 3 + 2];
        const k = x + ',' + y + ',' + z;
        let id = ids.get(k);
        if (id === undefined) { id = pts.length; ids.set(k, id); pts.push([x, y, z]); }
        idx[t] = id;
    }

    const dir = new Map();     // "a,b" -> times traversed a->b
    let degenerate = 0;
    for (let t = 0; t < count; t++) {
        const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
        if (a === b || b === c || c === a) { degenerate++; continue; }
        for (const [p, q] of [[a, b], [b, c], [c, a]]) {
            const k = p + ',' + q;
            dir.set(k, (dir.get(k) || 0) + 1);
        }
    }

    let boundary = 0, flipped = 0, overused = 0, edges = 0;
    for (const [k, n] of dir) {
        const [p, q] = k.split(',');
        const back = dir.get(q + ',' + p) || 0;
        if (n > 1) overused++;               // same direction twice: a fold
        if (back === 0) { boundary++; edges++; }   // used once: an open edge
        else {
            if (back !== n) flipped++;
            if (+p < +q) edges++;            // count the undirected edge once
        }
    }

    // Signed volume: sum of the tetrahedra from the origin to each face.
    let vol = 0;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let t = 0; t < count; t++) {
        const p = [];
        for (let j = 0; j < 3; j++) {
            const v = pts[idx[t * 3 + j]];
            p.push(v);
            for (let k = 0; k < 3; k++) {
                if (v[k] < lo[k]) lo[k] = v[k];
                if (v[k] > hi[k]) hi[k] = v[k];
            }
        }
        const [a, b, c] = p;
        vol += (a[0] * (b[1] * c[2] - b[2] * c[1])
              - a[1] * (b[0] * c[2] - b[2] * c[0])
              + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
    }

    // How much of the mesh lies exactly on the lowest plane: a real flat base
    // puts the whole bottom cap there, a knife edge puts one vertex there.
    let flat = 0, below = 0;
    for (const v of pts) {
        if (v[2] === lo[2]) flat++;
        else if (v[2] < lo[2]) below++;
    }

    const V = pts.length, E = edges, Fc = count - degenerate;
    return {
        tris: count, V, E, F: Fc, euler: V - E + Fc,
        boundary, flipped, overused, degenerate, vol, lo, hi, flat, below,
    };
}

// The footprint the shell stands on, reproducing the emitted sampling in JS so
// the expected volume is computed independently of what OpenSCAD did with it.
// A vertical offset has an exact volume: thickness * footprint area. That
// number catches a collapsed or doubled sheet that still happens to close up,
// which the edge and Euler checks would both pass.
function footprintArea(patches, src, sz) {
    const sp = +/^splinesteps = (\d+)/m.exec(src)[1];
    const [pr, pc] = /^patch_grid = \[(\d+), (\d+)\]/m.exec(src).slice(1).map(Number);
    const grid = [];
    for (let a = 0; a < pr; a++) {
        for (let i = a ? 1 : 0; i <= sp; i++) {
            const row = [];
            for (let b = 0; b < pc; b++) {
                for (let j = b ? 1 : 0; j <= sp; j++) {
                    // OpenSCAD's bezier_patch_points takes u over the patch's
                    // outer list; evalBezierPatch takes it over the inner one.
                    const q = F.evalBezierPatch(patches[a * pc + b], j / sp, i / sp);
                    row.push([q[0] * sz[0], q[1] * sz[1]]);
                }
            }
            grid.push(row);
        }
    }
    const nr = grid.length - 1, nc = grid[0].length - 1;
    const rim = [].concat(grid[0],
        Array.from({ length: nr }, (_, k) => grid[k + 1][nc]),
        Array.from({ length: nc }, (_, k) => grid[nr][nc - 1 - k]),
        Array.from({ length: nr - 1 }, (_, k) => grid[nr - 1 - k][0]));
    let A = 0;
    for (let k = 0; k < rim.length; k++) {
        const a = rim[k], b = rim[(k + 1) % rim.length];
        A += a[0] * b[1] - b[0] * a[1];
    }
    return Math.abs(A) / 2;
}

// ------------------------------------------------------ self-intersection

// Edge-manifold is NOT printable. The shell is the surface plus a copy of it
// offset straight down, and that pair cannot meet -- but only where the
// surface is a graph of z = f(x,y). Where the (u,v) -> (x,y) map folds, the
// sheet lies over itself and the copy cuts through it, and the mesh stays
// edge-manifold throughout: every edge still has exactly two faces, the Euler
// characteristic is still 2, the volume is still positive. Nothing above
// catches it. This does.
//
// Sample the top sheet exactly as the emitted file does, then walk a fine grid
// of xy columns and collect every z the sheet has there. Two layers closer
// than `thickness` means the offset copy of the upper passes through the
// lower. Reported as the share of the footprint that is affected.
function selfOverlap(patches, src, sz, N) {
    N = N || 200;
    const sp = +/^splinesteps = (\d+)/m.exec(src)[1];
    const [pr, pc] = /^patch_grid = \[(\d+), (\d+)\]/m.exec(src).slice(1).map(Number);
    const thickness = +/^thickness = ([\d.]+)/m.exec(src)[1];

    const g = [];
    for (let a = 0; a < pr; a++) {
        for (let i = a ? 1 : 0; i <= sp; i++) {
            const row = [];
            for (let b = 0; b < pc; b++) {
                for (let j = b ? 1 : 0; j <= sp; j++) {
                    const q = F.evalBezierPatch(patches[a * pc + b], j / sp, i / sp);
                    row.push([q[0] * sz[0], q[1] * sz[1], q[2] * sz[2]]);
                }
            }
            g.push(row);
        }
    }
    const tris = [];
    for (let i = 0; i + 1 < g.length; i++) {
        for (let j = 0; j + 1 < g[0].length; j++) {
            tris.push([g[i][j], g[i][j + 1], g[i + 1][j + 1]]);
            tris.push([g[i][j], g[i + 1][j + 1], g[i + 1][j]]);
        }
    }
    const lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
    for (const r of g) for (const p of r) for (let k = 0; k < 2; k++) {
        if (p[k] < lo[k]) lo[k] = p[k];
        if (p[k] > hi[k]) hi[k] = p[k];
    }
    const dx = (hi[0] - lo[0]) / N, dy = (hi[1] - lo[1]) / N;
    const bucket = new Map();
    tris.forEach((t, ti) => {
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        for (const p of t) {
            x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]);
            y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]);
        }
        const i0 = Math.max(0, Math.floor((x0 - lo[0]) / dx));
        const i1 = Math.min(N, Math.floor((x1 - lo[0]) / dx));
        const j0 = Math.max(0, Math.floor((y0 - lo[1]) / dy));
        const j1 = Math.min(N, Math.floor((y1 - lo[1]) / dy));
        for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
            const k = i * (N + 2) + j;
            if (!bucket.has(k)) bucket.set(k, []);
            bucket.get(k).push(ti);
        }
    });

    let cols = 0, cut = 0;
    for (let i = 0; i <= N; i++) {
        for (let j = 0; j <= N; j++) {
            const cand = bucket.get(i * (N + 2) + j);
            if (!cand) continue;
            const px = lo[0] + (i + 0.5) * dx, py = lo[1] + (j + 0.5) * dy;
            const zs = [];
            for (const ti of cand) {
                const [A, B, C] = tris[ti];
                const d = (B[1] - C[1]) * (A[0] - C[0]) + (C[0] - B[0]) * (A[1] - C[1]);
                if (Math.abs(d) < 1e-14) continue;
                const w1 = ((B[1] - C[1]) * (px - C[0]) + (C[0] - B[0]) * (py - C[1])) / d;
                const w2 = ((C[1] - A[1]) * (px - C[0]) + (A[0] - C[0]) * (py - C[1])) / d;
                const w3 = 1 - w1 - w2;
                if (w1 < -1e-9 || w2 < -1e-9 || w3 < -1e-9) continue;
                zs.push(w1 * A[2] + w2 * B[2] + w3 * C[2]);
            }
            if (!zs.length) continue;
            cols++;
            zs.sort((a, b) => a - b);
            // one sheet sampled twice at a shared edge is not two layers
            const layers = [zs[0]];
            for (const z of zs) if (z - layers[layers.length - 1] > 1e-6) layers.push(z);
            for (let k = 0; k + 1 < layers.length; k++) {
                if (layers[k + 1] - layers[k] < thickness) { cut++; break; }
            }
        }
    }
    return { cols, cut, frac: cols ? cut / cols : 0 };
}

// ------------------------------------------------------------ build a fit

const W = 160, H = 160;
const N = 7, b = F.bsplineBasis(N), Z = new Float64Array(N * N);
let s = 7;
const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
for (let i = 0; i < N * N; i++) Z[i] = rnd();
const g = F.evalGrid({ bx: b, by: b, Nx: N, Ny: N, Z }, W, H);
let lo = Infinity, hi = -Infinity;
for (const v of g) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
const harm = [{ k: 2, a: 0.08, p: 0.6 }, { k: 3, a: -0.05, p: 2.1 }];
const grey = new Float64Array(W * H), data = new Float64Array(W * H);
for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
        const i = y * W + x, u = x / (W - 1) - 0.5, v = y / (H - 1) - 0.5;
        let r = 0.36;
        for (const q of harm) r += q.a * Math.cos(q.k * Math.atan2(v, u) + q.p);
        const z = Math.hypot(u, v) <= r ? 0.12 + 0.76 * ((g[i] - lo) / (hi - lo)) : 0;
        data[i] = z; grey[i] = z * 255;
    }
}
const m = C.buildMask(grey, W, H, {});
const contour = C.traceContour(m.mask, W, H);
const fit = F.fitHeightField(data, W, H, { basis: 'bspline', nx: 10, mask: m.mask, lambda: 1e-4 });
const warp = Wp.warpFit(fit, contour, W, H,
    { degree: 8, searchCorners: true, mask: m.mask, domain: 'harmonic' });

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beziver-scad-'));
// A dense fit as well as the default one. Seams between patch tiles are where
// a heightfield-to-solid construction cracks, and a single-patch output cannot
// exercise them at all: 289 tiles is 544 interior seams against 49 tiles' 84.
const dense = F.fitHeightField(data, W, H,
    { basis: 'bspline', nx: 20, mask: m.mask, lambda: 1e-4 });

const patchSets = {
    stage1: F.toBezierPatches(fit),
    stage1dense: F.toBezierPatches(dense),
    warp: [warp.patch],
};
const files = {};
for (const [k, ps] of Object.entries(patchSets)) {
    files[k] = R.patchesToScad(ps,
        { W, H, contour, warped: k === 'warp', sizeX: 100, sizeY: 100, height: 20 });
}

for (const [name, src] of Object.entries(files)) {
    const scad = path.join(dir, name + '.scad');
    fs.writeFileSync(scad, src);

    const png = path.join(dir, name + '.png');
    const r = spawnSync('openscad', ['-o', png, '--imgsize=600,450',
        '--camera=50,50,10,55,0,25,320', scad], { encoding: 'utf8', timeout: 90000 });
    const err = (r.stderr || '') + (r.stdout || '');
    const hard = err.split('\n').filter((l) => /^ERROR:/.test(l));

    check(name + ': renders without errors', r.status === 0 && hard.length === 0,
        hard.length ? hard[0] : 'exit ' + r.status);
    check(name + ': produced a non-trivial image',
        fs.existsSync(png) && fs.statSync(png).size > 8000,
        fs.existsSync(png) ? fs.statSync(png).size + ' bytes' : 'missing');

    // Exporting geometry proves the patches really became a polyhedron, not
    // just that the file parsed. The control net now defaults to off, so this
    // needs no override -- and CSG-unioning marker spheres took minutes.
    const stl = path.join(dir, name + '.stl');
    const t0 = Date.now();
    const r2 = spawnSync('openscad', ['-o', stl, scad], { encoding: 'utf8', timeout: 180000 });
    const exportMs = Date.now() - t0;
    const err2 = (r2.stderr || '') + (r2.stdout || '');
    const buf = fs.existsSync(stl) ? fs.readFileSync(stl) : null;
    const tris = buf ? (buf.toString('utf8').match(/facet normal/g) || []).length : 0;
    check(name + ': exports real geometry', r2.status === 0 && tris > 500,
        tris + ' facets, render+export ' + exportMs + ' ms');

    // OpenSCAD says so itself when a mesh is not closed. Catching it here as
    // well as in meshCheck means a future backend change that silently repairs
    // (or silently drops) geometry still shows up.
    const badMesh = err2.split('\n').filter((l) =>
        /^(ERROR|WARNING):/.test(l) &&
        /manifold|not closed|degenerate|self-intersect|Object may not be a valid/i.test(l));
    check(name + ': OpenSCAD reports no mesh problems', badMesh.length === 0,
        badMesh.length ? badMesh[0] : 'clean');

    const M = buf ? meshCheck(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
        : null;

    // THE assertion. A sheet exports facets too; only a closed mesh prints.
    check(name + ': mesh is closed (every edge shared by exactly two faces)',
        !!M && M.boundary === 0 && M.overused === 0,
        M ? M.boundary + ' open edges, ' + M.overused + ' overused' : 'no stl');
    check(name + ': winding is consistent across every shared edge',
        !!M && M.flipped === 0, M ? M.flipped + ' mismatched' : 'no stl');
    check(name + ': Euler characteristic is that of a sphere',
        !!M && M.euler === 2,
        M ? 'V ' + M.V + ' - E ' + M.E + ' + F ' + M.F + ' = ' + M.euler : 'no stl');
    check(name + ': no degenerate faces', !!M && M.degenerate === 0,
        M ? M.degenerate + ' zero-area triangles' : 'no stl');

    // Seam integrity, stated as a number. The emitter drops the duplicated
    // first row and column of every patch tile but the first, so a p x p grid
    // of tiles at s splinesteps is ONE (p*s+1)^2 point mesh -- adjacent tiles
    // do not each contribute their shared boundary, and no epsilon merge is
    // relied on to weld them. Two sheets of that, and the skirt reusing their
    // rim vertices, is exactly 2*(p*s+1)^2 distinct positions. A cracked seam
    // or a mismatched skirt would show up here as extra vertices, and this is
    // the check that a single-patch test cannot make.
    const sp = +/^splinesteps = (\d+)/m.exec(src)[1];
    const [pr, pc] = /^patch_grid = \[(\d+), (\d+)\]/m.exec(src).slice(1).map(Number);
    const wantV = 2 * (pr * sp + 1) * (pc * sp + 1);
    check(name + ': one seamless mesh, twice, with no duplicated seam vertices',
        !!M && M.V === wantV,
        M ? M.V + ' vertices, expected ' + wantV + ' for ' + pr + 'x' + pc +
            ' tiles at ' + sp + ' steps' : 'no stl');

    // Positive signed volume means the normals point out -- an inside-out
    // solid is closed too, and slicers hate it. The magnitude is bounded by
    // the box the emitted size + base describe, and a heightfield with a base
    // cannot be a sliver of it.
    const sz = /^size = \[([\d.]+), ([\d.]+), ([\d.]+)\]/m.exec(src).slice(1).map(Number);
    const thick = +/^thickness = ([\d.]+)/m.exec(src)[1];
    const ext = M ? [0, 1, 2].map((k) => M.hi[k] - M.lo[k]) : [0, 0, 0];

    // Positive signed volume means the normals point out -- an inside-out
    // solid is closed too, and slicers hate it.
    check(name + ': encloses a positive volume', !!M && M.vol > 0,
        M ? M.vol.toFixed(1) + ' mm3' : 'no stl');

    // The exact one. A constant offset in z encloses thickness * footprint,
    // whatever the surface does in between.
    const want = thick * footprintArea(patchSets[name], src, sz);
    check(name + ': volume matches thickness x footprint',
        !!M && Math.abs(M.vol - want) < 0.01 * want,
        M ? M.vol.toFixed(1) + ' vs ' + want.toFixed(1) + ' mm3 (' +
            (100 * (M.vol / want - 1)).toFixed(2) + '%)' : 'no stl');

    // The bounding box is the size that was asked for: the footprint in x and
    // y, and the surface's own relief plus one thickness in z.
    check(name + ': bounding box matches the emitted size',
        !!M && ext[0] <= sz[0] + 0.01 && ext[0] > 0.5 * sz[0] &&
        ext[1] <= sz[1] + 0.01 && ext[1] > 0.5 * sz[1] &&
        ext[2] > thick && ext[2] < sz[2] + thick + 0.01,
        M ? ext.map((v) => v.toFixed(2)).join(' x ') + ' vs size ' + sz.join(' x ') +
            ' + thickness ' + thick : 'no stl');

    // Both faces follow the fit, so neither is flat: a shell that collapsed
    // onto a plane would put a whole sheet's worth of vertices on one z.
    check(name + ': neither face is a flat plane',
        !!M && M.flat < 0.02 * M.V,
        M ? M.flat + ' of ' + M.V + ' vertices share the lowest z' : 'no stl');

    // The vertical offset is only guaranteed where the surface is a graph.
    // Stage 1 always is, by construction: its control net's x,y are pinned to
    // a uniform grid, so Bernstein linear precision makes x = u and y = v
    // exactly, and it may not fold at all. Stage 2 can fold on a concave
    // outline; app.js ships it only while no reversal sits deep inside the
    // patch, which is the same test asserted here.
    const surf = R.surfaceStats(patchSets[name], sz[0], sz[1], sz[2]);
    check(name + ': the emitted surface does not fold back over itself',
        name === 'warp' ? surf.deepFolded === 0 : surf.folded === 0,
        (100 * surf.foldFraction).toFixed(2) + '% of ' + surf.samples +
        ' samples reversed, ' + surf.deepFolded + ' of them deep');

    const ov = selfOverlap(patchSets[name], src, sz);
    check(name + ': the shell does not cut through itself',
        ov.frac < 0.001,
        (100 * ov.frac).toFixed(3) + '% of ' + ov.cols + ' footprint columns');

    // The file a person pastes should be short: fixed preamble plus one line    // The file a person pastes should be short: fixed preamble plus one line
    // per patch, nothing else.
    const lines = src.split('\n').length;
    const patches = (src.match(/^  \[\[\[/gm) || []).length;
    check(name + ': stays close to one line per patch', lines - patches < 40,
        lines + ' lines for ' + patches + ' patches');
}

// Same subdivision on both, despite very different patch counts.
const stepsOf = (src) => +/^splinesteps = (\d+)/m.exec(src)[1];
const nPatch = (src) => (src.match(/^  \[\[\[/gm) || []).length;
const total = (src) => Math.round(Math.sqrt(nPatch(src))) * stepsOf(src);
check('both outputs reach a comparable total subdivision',
    Math.abs(total(files.stage1) - total(files.warp)) <= 20,
    'stage1 ~' + total(files.stage1) + ' vs warp ~' + total(files.warp));

// ------------------------------------------- the fold rule earns its place

// A concave outline the warp cannot flatten without folding. This is the case
// app.js refuses to ship: it asserts that the fold signal really does mean a
// self-intersecting solid, and -- the part that matters -- that the mesh
// checks above all pass on it anyway, so they are not what protects the user.
{
    const cw = new Float64Array(W * H), cg = new Float64Array(W * H);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const u = (x / (W - 1) - 0.5) * 2, v = (y / (H - 1) - 0.5) * 2;
            const r = Math.hypot(u, v);
            const inC = r < 0.9 && r > 0.35 && !(u > 0.1 && Math.abs(v) < 0.34);
            const z = inC ? 0.2 + 0.6 * Math.cos(1.6 * (r - 0.62)) : 0;
            cw[y * W + x] = z; cg[y * W + x] = z * 255;
        }
    }
    const cm = C.buildMask(cg, W, H, {});
    const cc = C.traceContour(cm.mask, W, H);
    const cf = F.fitHeightField(cw, W, H,
        { basis: 'bspline', nx: 10, mask: cm.mask, lambda: 1e-4 });
    const cwarp = Wp.warpFit(cf, cc, W, H,
        { degree: 8, searchCorners: true, mask: cm.mask, domain: 'harmonic' });
    const csrc = R.patchesToScad([cwarp.patch],
        { W, H, contour: cc, warped: true, sizeX: 100, sizeY: 100, height: 20 });
    const cst = R.surfaceStats([cwarp.patch], 1, 1, 1);
    const cov = selfOverlap([cwarp.patch], csrc, [100, 100, 20]);

    check('a concave outline that folds back is detected', cst.deepFolded > 0,
        cst.deepFolded + ' deep reversals of ' + cst.samples + ' samples');
    check('and its shell really does cut through itself', cov.frac > 0.01,
        (100 * cov.frac).toFixed(2) + '% of its footprint');
    check('...which is why app.js falls back to the rectangular fit for it',
        /fold\.deepFolded > 0/.test(
            fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8')));

    // The other side of the threshold, and the one that would have caught the
    // rule being too strict: the sample pebbles are smooth blobs whose maps DO
    // fold at the rim. They must ship as the outline patch, not fall back.
    let ships = 0, seeds = 0;
    for (let seed = 1; seed <= 8; seed++) {
        const sb = SAMPLE.pebble(seed);
        const sm = STL.parseSTL(sb.buffer);
        const R2 = 136;
        const sd = STL.depthRender(sm.verts, R2, R2, {});
        const sw = STL.applyWater(sd, sb.cut);
        const sg = new Float64Array(R2 * R2);
        for (let i = 0; i < R2 * R2; i++) sg[i] = sw.mask[i] ? sw.zn[i] * 255 : 0;
        const smk = C.buildMask(sg, R2, R2, {});
        const sct = C.traceContour(smk.mask, R2, R2);
        const sf = F.fitHeightField(sw.zn, R2, R2,
            { basis: 'bspline', nx: 10, mask: smk.mask, lambda: 1e-4 });
        const sp = Wp.warpFit(sf, sct, R2, R2, { degree: 8, searchCorners: true,
            mask: smk.mask, domain: 'harmonic', zScale: sw.unitScale });
        seeds++;
        if (R.surfaceStats([sp.patch], 1, 1, 1).deepFolded === 0) ships++;
    }
    check('and why it does NOT fall back for a smooth sample pebble',
        ships === seeds, ships + ' of ' + seeds + ' sample seeds keep the outline patch');
}

console.log('\nartifacts: ' + dir);
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
