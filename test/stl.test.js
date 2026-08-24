'use strict';

const S = require('../src/stl.js');

let pass = 0, fail = 0;
const check = (n, c, e) => {
    if (c) { pass++; console.log('  ok   ' + n + (e ? '  [' + e + ']' : '')); }
    else { fail++; console.log('  FAIL ' + n + (e ? '  [' + e + ']' : '')); }
};
const section = (t) => console.log('\n' + t);

// ------------------------------------------------------------------ fixtures

function binarySTL(tris, header) {
    const buf = new ArrayBuffer(84 + tris.length * 50);
    const dv = new DataView(buf);
    const head = header || 'test';
    for (let i = 0; i < Math.min(80, head.length); i++) dv.setUint8(i, head.charCodeAt(i));
    dv.setUint32(80, tris.length, true);
    let o = 84;
    for (const t of tris) {
        for (let k = 0; k < 3; k++) { dv.setFloat32(o, 0, true); o += 4; }   // normal
        for (const v of t) { for (const c of v) { dv.setFloat32(o, c, true); o += 4; } }
        dv.setUint16(o, 0, true); o += 2;
    }
    return buf;
}

function asciiSTL(tris) {
    let s = 'solid test\n';
    for (const t of tris) {
        s += ' facet normal 0 0 1\n  outer loop\n';
        for (const v of t) s += `   vertex ${v[0]} ${v[1]} ${v[2]}\n`;
        s += '  endloop\n endfacet\n';
    }
    s += 'endsolid test\n';
    const b = Buffer.from(s, 'utf8');
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

// a flat square in XY at height z, spanning 0..size
const square = (size, z) => [
    [[0, 0, z], [size, 0, z], [size, size, z]],
    [[0, 0, z], [size, size, z], [0, size, z]],
];
// a square whose height ramps linearly with x, from 0 to rise
const ramp = (size, rise) => [
    [[0, 0, 0], [size, 0, rise], [size, size, rise]],
    [[0, 0, 0], [size, size, rise], [0, size, 0]],
];
// a plane tilted about BOTH axes: z = rx*x/size + ry*y/size. With rx and ry
// incommensurate this takes a distinct value at nearly every pixel, which a
// single-axis ramp cannot do -- a ramp has at most one height per column, so
// it could never distinguish float storage from 8-bit quantisation.
const tilted = (size, rx, ry) => [
    [[0, 0, 0], [size, 0, rx], [size, size, rx + ry]],
    [[0, 0, 0], [size, size, rx + ry], [0, size, ry]],
];

// -------------------------------------------------------------------- parse

section('Parsing');
{
    const tris = [
        [[0, 0, 0], [1, 0, 0], [0, 1, 0]],
        [[0, 0, 1], [1, 0, 1], [0, 1, 2.5]],
    ];
    const b = S.parseSTL(binarySTL(tris));
    check('binary: triangle count', b.count === 2 && b.format === 'binary');
    let err = 0;
    tris.forEach((t, i) => t.forEach((v, j) => v.forEach((c, k) => {
        err = Math.max(err, Math.abs(b.verts[i * 9 + j * 3 + k] - c));
    })));
    check('binary: vertices round-trip', err < 1e-6, 'err ' + err.toExponential(2));

    // Binary STLs may also begin with the word "solid"; only the length rule
    // distinguishes them, so this must not be misread as ASCII.
    const trap = S.parseSTL(binarySTL(tris, 'solid exported by some cad tool'));
    check('binary starting with "solid" is not misread as ascii',
        trap.format === 'binary' && trap.count === 2);

    const a = S.parseSTL(asciiSTL(tris));
    check('ascii: triangle count', a.count === 2 && a.format === 'ascii');
    let aerr = 0;
    tris.forEach((t, i) => t.forEach((v, j) => v.forEach((c, k) => {
        aerr = Math.max(aerr, Math.abs(a.verts[i * 9 + j * 3 + k] - c));
    })));
    check('ascii: vertices round-trip', aerr < 1e-6, 'err ' + aerr.toExponential(2));

    // Build these standalone: Node pools Buffer memory, so Buffer#buffer
    // would hand the parser the previous fixtures' bytes as well.
    const junk = (n) => {
        const g = new ArrayBuffer(n);
        const u = new Uint8Array(g);
        for (let i = 0; i < n; i++) u[i] = (i * 37) & 0xff;
        return g;
    };
    let threwSmall = false, threwBig = false;
    try { S.parseSTL(junk(40)); } catch (e) { threwSmall = true; }
    try { S.parseSTL(junk(4096)); } catch (e) { threwBig = true; }
    check('garbage rejected (short)', threwSmall);
    check('garbage rejected (long enough to look binary)', threwBig);
}

section('Bounds and rotation');
{
    const m = S.parseSTL(binarySTL(square(10, 3)));
    const b = S.bounds(m.verts);
    check('bounds', b.lo[0] === 0 && b.hi[0] === 10 && b.lo[2] === 3 && b.hi[2] === 3);
    check('center', b.center[0] === 5 && b.center[1] === 5 && b.center[2] === 3);

    const M = S.rotationMatrix(0.7, -0.4, 1.1);
    let orth = 0;
    for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
            let d = 0;
            for (let k = 0; k < 3; k++) d += M[i * 3 + k] * M[j * 3 + k];
            orth = Math.max(orth, Math.abs(d - (i === j ? 1 : 0)));
        }
    }
    check('rotation matrix is orthonormal', orth < 1e-12, 'err ' + orth.toExponential(2));
    const det = M[0] * (M[4] * M[8] - M[5] * M[7]) - M[1] * (M[3] * M[8] - M[5] * M[6]) +
                M[2] * (M[3] * M[7] - M[4] * M[6]);
    check('rotation preserves handedness (det = 1)', Math.abs(det - 1) < 1e-12);

    // yaw of 90 degrees sends +x to +y
    const Y = S.rotationMatrix(Math.PI / 2, 0, 0);
    const v = S.transformVerts(Float32Array.from([1, 0, 0]), Y, [0, 0, 0]);
    check('yaw 90 maps +x to +y', Math.abs(v[0]) < 1e-6 && Math.abs(v[1] - 1) < 1e-6);

    const c = S.transformVerts(Float32Array.from([5, 5, 3]), S.rotationMatrix(1, 2, 3), [5, 5, 3]);
    check('rotation happens about the supplied centre',
        Math.hypot(c[0], c[1], c[2]) < 1e-6);
}

// ------------------------------------------------------------- depth render

section('Depth render');
{
    const m = S.parseSTL(binarySTL(square(10, 3)));
    const d = S.depthRender(m.verts, 32, 32, {});
    let flat = 0, cov = 0;
    for (let i = 0; i < 32 * 32; i++) if (d.cov[i]) { cov++; flat = Math.max(flat, Math.abs(d.z[i] - 3)); }
    check('flat plate: constant depth', flat < 1e-5, 'err ' + flat.toExponential(2));
    check('flat plate: coverage', cov > 700, cov + ' px');
    check('flat plate: zmin == zmax', Math.abs(d.zmax - d.zmin) < 1e-6);

    // Model geometry must survive the projection: invert the mapping and
    // check the depth equals the analytic plane.
    const r = S.parseSTL(binarySTL(ramp(10, 4)));
    const dr = S.depthRender(r.verts, 64, 64, { margin: 2 });
    const s = (64 - 4) / 10;
    let worst = 0, n = 0;
    for (let y = 0; y < 64; y++) {
        for (let x = 0; x < 64; x++) {
            const i = y * 64 + x;
            if (!dr.cov[i]) continue;
            const modelX = (x - (2 + (60 - 10 * s) / 2)) / s;
            if (modelX < 0.5 || modelX > 9.5) continue;
            worst = Math.max(worst, Math.abs(dr.z[i] - modelX / 10 * 4));
            n++;
        }
    }
    check('ramp: depth matches the analytic plane', worst < 0.02 && n > 1000,
        'worst ' + worst.toExponential(2) + ' over ' + n + ' px');
    check('ramp: units per pixel reported', Math.abs(dr.unitsPerPx - 1 / s) < 1e-9);

    // Occlusion: the nearer surface wins, which is what "seen from above" means
    const stacked = S.parseSTL(binarySTL(square(10, 1).concat(
        square(10, 2).map((t) => t.map(([x, y, z]) => [x * 0.4 + 3, y * 0.4 + 3, z])))));
    const ds = S.depthRender(stacked.verts, 48, 48, {});
    let low = 0, high = 0;
    for (let i = 0; i < 48 * 48; i++) {
        if (!ds.cov[i]) continue;
        if (Math.abs(ds.z[i] - 2) < 1e-5) high++;
        else if (Math.abs(ds.z[i] - 1) < 1e-5) low++;
    }
    check('nearest surface wins', high > 100 && low > 500, high + ' px at z=2, ' + low + ' at z=1');

    let threw = false;
    try { S.depthRender(Float32Array.from([]), 16, 16, {}); } catch (e) { threw = true; }
    check('empty projection rejected with a message', threw);
}

// --------------------------------------------------------------- water line

section('Water level');
{
    const r = S.parseSTL(binarySTL(ramp(10, 4)));
    const d = S.depthRender(r.verts, 64, 64, {});

    const w0 = S.applyWater(d, 0);
    const wHalf = S.applyWater(d, 0.5);
    const wHigh = S.applyWater(d, 0.9);

    check('water at 0 keeps (almost) everything', w0.above > 0.95 * d.covered,
        w0.above + '/' + d.covered);
    check('raising the water line drops pixels',
        wHigh.above < wHalf.above && wHalf.above < w0.above,
        w0.above + ' -> ' + wHalf.above + ' -> ' + wHigh.above);
    // a linear ramp cut at the midpoint should leave about half the area
    check('half water keeps about half a linear ramp',
        Math.abs(wHalf.above / d.covered - 0.5) < 0.06,
        (100 * wHalf.above / d.covered).toFixed(1) + '%');

    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < 64 * 64; i++) if (wHalf.mask[i]) { lo = Math.min(lo, wHalf.zn[i]); hi = Math.max(hi, wHalf.zn[i]); }
    check('above-water heights normalise to (0,1]', lo > 0 && hi <= 1 + 1e-9 && hi > 0.99,
        lo.toExponential(2) + ' .. ' + hi.toFixed(6));
    check('unitScale converts back to model units',
        Math.abs(wHalf.unitScale - (d.zmax - wHalf.water)) < 1e-9,
        wHalf.unitScale.toFixed(4) + ' units of relief');
    check('everything below the water line is masked out',
        (() => { for (let i = 0; i < 64 * 64; i++) if (wHalf.mask[i] && d.z[i] <= wHalf.water) return false; return true; })());
}

section('Precision beyond 8 bits');
{
    // Total relief of 0.002 model units on a plane tilted about both axes.
    // Quantised to 0..255 this collapses to 256 levels; the float path must
    // keep far more, and must resolve steps finer than one 8-bit increment.
    const N = 256;
    const r = S.parseSTL(binarySTL(tilted(10, 0.002, 0.002 * Math.SQRT2)));
    const d = S.depthRender(r.verts, N, N, {});
    const w = S.applyWater(d, 0);

    const distinct = new Set(), quantised = new Set();
    for (let i = 0; i < N * N; i++) {
        if (!w.mask[i]) continue;
        distinct.add(w.zn[i].toFixed(12));
        quantised.add(Math.round(w.zn[i] * 255));
    }
    check('float depths keep far more levels than 8 bits could',
        distinct.size > 10 * quantised.size && quantised.size <= 256,
        distinct.size + ' distinct float levels vs ' + quantised.size + ' 8-bit levels');
    check('relief preserved in model units',
        Math.abs(w.unitScale - 0.002 * (1 + Math.SQRT2)) < 1e-5,
        w.unitScale.toExponential(3) + ' units');

    // adjacent pixels separated by less than one 8-bit step, still distinct
    let finer = 0, adjacent = 0;
    for (let y = 1; y < N - 1; y++) {
        for (let x = 1; x < N - 2; x++) {
            const a = y * N + x, b = a + 1;
            if (!w.mask[a] || !w.mask[b]) continue;
            adjacent++;
            const gap = Math.abs(w.zn[a] - w.zn[b]);
            if (gap > 0 && gap < 1 / 255) finer++;
        }
    }
    check('sub-8-bit height differences survive',
        finer > 0.5 * adjacent, finer + ' of ' + adjacent + ' adjacent pairs');

    // and the stored values are not sitting on the 8-bit lattice
    let offLattice = 0, total = 0;
    for (let i = 0; i < N * N; i++) {
        if (!w.mask[i]) continue;
        total++;
        if (Math.abs(w.zn[i] * 255 - Math.round(w.zn[i] * 255)) > 1e-6) offLattice++;
    }
    check('heights are not quantised to the 8-bit lattice',
        offLattice > 0.9 * total, (100 * offLattice / total).toFixed(1) + '% off-lattice');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
