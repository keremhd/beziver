'use strict';

const F = require('../src/fit.js');
const C = require('../src/contour.js');

let pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log('  ok   ' + name + (extra ? '  [' + extra + ']' : '')); }
    else { fail++; console.log('  FAIL ' + name + (extra ? '  [' + extra + ']' : '')); }
}
function section(t) { console.log('\n' + t); }

// deterministic PRNG so runs are reproducible
let seed = 12345;
function rnd() {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
}

// ------------------------------------------------------------------ bases

section('Bernstein basis');
{
    for (const N of [2, 4, 7]) {
        const b = F.bernsteinBasis(N);
        let maxPU = 0, maxLP = 0;
        for (let k = 0; k <= 20; k++) {
            const t = k / 20;
            const r = b.evalAt(t);
            let sum = 0, lin = 0;
            for (let i = 0; i < r.vals.length; i++) {
                sum += r.vals[i];
                lin += (i / (N - 1)) * r.vals[i];
            }
            maxPU = Math.max(maxPU, Math.abs(sum - 1));
            maxLP = Math.max(maxLP, Math.abs(lin - t));
        }
        check('partition of unity, N=' + N, maxPU < 1e-12, 'err ' + maxPU.toExponential(2));
        // linear precision is what makes the x,y map the identity
        check('linear precision, N=' + N, maxLP < 1e-12, 'err ' + maxLP.toExponential(2));
    }
}

section('Cubic B-spline basis');
{
    for (const N of [4, 5, 9]) {
        const b = F.bsplineBasis(N);
        let maxPU = 0, badSupport = 0, negative = 0;
        for (let k = 0; k <= 200; k++) {
            const t = k / 200;
            const r = b.evalAt(t);
            let sum = 0;
            for (const v of r.vals) {
                sum += v;
                if (v < -1e-12) negative++;
            }
            maxPU = Math.max(maxPU, Math.abs(sum - 1));
            if (r.vals.length !== 4) badSupport++;
            if (r.first < 0 || r.first + 4 > N) badSupport++;
        }
        check('partition of unity, N=' + N, maxPU < 1e-12, 'err ' + maxPU.toExponential(2));
        check('4 nonzero funcs in range, N=' + N, badSupport === 0);
        check('non-negative, N=' + N, negative === 0);
    }
}

// ----------------------------------------------------------------- solver

section('Linear algebra');
{
    const n = 12;
    const A = new Float64Array(n * n);
    for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) A[i * n + j] = rnd() - 0.5;
    }
    // SPD = A^T A + nI
    const S = new Float64Array(n * n);
    for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
            let s = 0;
            for (let k = 0; k < n; k++) s += A[k * n + i] * A[k * n + j];
            S[i * n + j] = s + (i === j ? n : 0);
        }
    }
    const xTrue = new Float64Array(n);
    for (let i = 0; i < n; i++) xTrue[i] = rnd() * 4 - 2;
    const rhs = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        let s = 0;
        for (let j = 0; j < n; j++) s += S[i * n + j] * xTrue[j];
        rhs[i] = s;
    }
    const x = F.cholSolve(S, rhs, n);
    let err = 0;
    for (let i = 0; i < n; i++) err = Math.max(err, Math.abs(x[i] - xTrue[i]));
    check('cholSolve recovers known solution', err < 1e-10, 'err ' + err.toExponential(2));

    const Inv = F.invert(S, n);
    let ierr = 0;
    for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
            let s = 0;
            for (let k = 0; k < n; k++) s += S[i * n + k] * Inv[k * n + j];
            ierr = Math.max(ierr, Math.abs(s - (i === j ? 1 : 0)));
        }
    }
    check('invert gives A*inv(A)=I', ierr < 1e-10, 'err ' + ierr.toExponential(2));
}

// -------------------------------------------------------------- exactness

// If the data IS a surface in the model space, an unregularised fit must
// reproduce it to roundoff. This is the strongest check on the whole pipeline.

section('Exact recovery: Bernstein data, Bernstein fit');
{
    const W = 60, H = 50, N = 4;
    const b = F.bernsteinBasis(N);
    const Ztrue = new Float64Array(N * N);
    for (let i = 0; i < N * N; i++) Ztrue[i] = rnd() * 2 - 1;
    const truth = { bx: b, by: b, Nx: N, Ny: N, Z: Ztrue };
    const data = F.evalGrid(truth, W, H);

    const fit = F.fitHeightField(data, W, H, { basis: 'bernstein', nx: N, lambda: 0 });
    let cerr = 0;
    for (let i = 0; i < N * N; i++) cerr = Math.max(cerr, Math.abs(fit.Z[i] - Ztrue[i]));
    check('control heights recovered', cerr < 1e-8, 'max err ' + cerr.toExponential(2));

    const got = F.evalGrid(fit, W, H);
    let rms = 0;
    for (let i = 0; i < W * H; i++) rms += (got[i] - data[i]) ** 2;
    rms = Math.sqrt(rms / (W * H));
    check('surface reproduced', rms < 1e-10, 'rms ' + rms.toExponential(2));
}

section('Exact recovery: B-spline data, B-spline fit');
{
    const W = 90, H = 80, N = 7;
    const b = F.bsplineBasis(N);
    const Ztrue = new Float64Array(N * N);
    for (let i = 0; i < N * N; i++) Ztrue[i] = rnd() * 2 - 1;
    const truth = { bx: b, by: b, Nx: N, Ny: N, Z: Ztrue };
    const data = F.evalGrid(truth, W, H);

    const fit = F.fitHeightField(data, W, H, { basis: 'bspline', nx: N, lambda: 0 });
    const got = F.evalGrid(fit, W, H);
    let rms = 0;
    for (let i = 0; i < W * H; i++) rms += (got[i] - data[i]) ** 2;
    rms = Math.sqrt(rms / (W * H));
    check('surface reproduced', rms < 1e-9, 'rms ' + rms.toExponential(2));
}

// ------------------------------------------------- Bezier patch extraction

section('B-spline -> Bezier extraction');
{
    const W = 64, H = 64, N = 8;
    const data = new Float64Array(W * H);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const u = x / (W - 1), v = y / (H - 1);
            data[y * W + x] = 0.5 + 0.4 * Math.sin(3 * u) * Math.cos(2.5 * v);
        }
    }
    const fit = F.fitHeightField(data, W, H, { basis: 'bspline', nx: N, lambda: 0 });
    const patches = F.toBezierPatches(fit);
    check('patch count = spans^2', patches.length === (N - 3) * (N - 3),
        patches.length + ' patches');

    // Every extracted patch must agree with the fitted surface exactly.
    let maxErr = 0, maxXY = 0;
    for (const p of patches) {
        for (let a = 0; a <= 7; a++) {
            for (let bb = 0; bb <= 7; bb++) {
                const pu = bb / 7, pv = a / 7;
                const q = F.evalBezierPatch(p, pu, pv);
                maxXY = Math.max(maxXY, Math.abs(F.evalAt(fit, q[0], q[1]) - q[2]));
                maxErr = Math.max(maxErr, Math.abs(q[2] - F.evalAt(fit, q[0], q[1])));
            }
        }
    }
    check('patches reproduce the fitted surface', maxErr < 1e-9, 'max err ' + maxErr.toExponential(2));

    // Adjacent patches must share their boundary curves (C0 at minimum).
    const ns = N - 3;
    let seam = 0;
    for (let sy = 0; sy < ns; sy++) {
        for (let sx = 0; sx + 1 < ns; sx++) {
            const L = patches[sy * ns + sx], R = patches[sy * ns + sx + 1];
            for (let a = 0; a < 4; a++) {
                for (let k = 0; k < 3; k++) {
                    seam = Math.max(seam, Math.abs(L[a][3][k] - R[a][0][k]));
                }
            }
        }
    }
    check('adjacent patches share edges (C0)', seam < 1e-9, 'max gap ' + seam.toExponential(2));

    // Bernstein mode must come back as a single patch whose control heights
    // are the fitted ones untouched.
    const bfit = F.fitHeightField(data, W, H, { basis: 'bernstein', nx: 5, lambda: 0 });
    const bp = F.toBezierPatches(bfit);
    let berr = 0;
    for (let j = 0; j < 5; j++) {
        for (let i = 0; i < 5; i++) berr = Math.max(berr, Math.abs(bp[0][j][i][2] - bfit.Z[j * 5 + i]));
    }
    check('bernstein fit -> 1 patch', bp.length === 1);
    check('bernstein control heights passed through', berr === 0);
}

// ------------------------------------------------------- masking behaviour

section('Masked fit and regularisation');
{
    const W = 80, H = 80;
    const data = new Float64Array(W * H);
    const mask = new Uint8Array(W * H);
    // disc of data in the middle; everything else has no data at all
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const u = x / (W - 1), v = y / (H - 1);
            data[y * W + x] = 0.5 + 0.3 * Math.sin(4 * u) * Math.cos(4 * v);
            const dx = u - 0.5, dy = v - 0.5;
            if (dx * dx + dy * dy < 0.25 * 0.25) mask[y * W + x] = 1;
        }
    }

    // Without regularisation, spans fully outside the mask are rank-deficient.
    let unregOK = true;
    try {
        const f0 = F.fitHeightField(data, W, H, { basis: 'bspline', nx: 12, mask, lambda: 0 });
        const g0 = F.evalGrid(f0, W, H);
        let ext = 0;
        for (let i = 0; i < W * H; i++) if (!mask[i]) ext = Math.max(ext, Math.abs(g0[i]));
        unregOK = Number.isFinite(ext);
        console.log('       (unregularised extrapolation magnitude: ' + ext.toExponential(2) + ')');
    } catch (e) {
        unregOK = false;
        console.log('       (unregularised solve failed: ' + e.message + ')');
    }

    const fit = F.fitHeightField(data, W, H, { basis: 'bspline', nx: 12, mask, lambda: 1e-4 });
    const got = F.evalGrid(fit, W, H);

    let inRms = 0, n = 0, extMax = 0, finite = true;
    for (let i = 0; i < W * H; i++) {
        if (!Number.isFinite(got[i])) finite = false;
        if (mask[i]) { inRms += (got[i] - data[i]) ** 2; n++; }
        else extMax = Math.max(extMax, Math.abs(got[i]));
    }
    inRms = Math.sqrt(inRms / n);

    check('regularised fit is finite everywhere', finite);
    check('fits well inside the mask', inRms < 0.01, 'rms ' + inRms.toExponential(2));
    check('extrapolation stays bounded outside mask', extMax < 5, 'max |z| ' + extMax.toFixed(3));
    check('only masked pixels used', fit.nUsed === n, fit.nUsed + ' px');
}

section('More control points fit strictly better');
{
    const W = 96, H = 96;
    const data = new Float64Array(W * H);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const u = x / (W - 1), v = y / (H - 1);
            data[y * W + x] = 0.5 + 0.25 * Math.sin(7 * u) * Math.cos(6 * v) + 0.1 * u * v;
        }
    }
    const rmsFor = (nx) => {
        const f = F.fitHeightField(data, W, H, { basis: 'bspline', nx, lambda: 0 });
        const g = F.evalGrid(f, W, H);
        let s = 0;
        for (let i = 0; i < W * H; i++) s += (g[i] - data[i]) ** 2;
        return Math.sqrt(s / (W * H));
    };
    const r4 = rmsFor(4), r8 = rmsFor(8), r16 = rmsFor(16);
    console.log('       rms: 4x4=' + (r4 * 255).toFixed(2) + '  8x8=' + (r8 * 255).toFixed(2) +
        '  16x16=' + (r16 * 255).toFixed(2) + ' grey levels');
    check('rms decreases with DOF', r16 < r8 && r8 < r4);
    // 16 DOF genuinely cannot represent this - the point about approximation power
    check('4x4 patch is starved on real data', r4 * 255 > 5, (r4 * 255).toFixed(1) + ' grey levels');
}

// ---------------------------------------------------------------- contour

section('Contour tracing');
{
    const W = 60, H = 60;
    const mask = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const dx = x - 30, dy = y - 30;
            if (dx * dx + dy * dy <= 20 * 20) mask[y * W + x] = 1;
        }
    }
    const c = C.traceContour(mask, W, H);
    // circumference of an r=20 disc is ~126 px; a runaway trace would lap it
    check('disc: closed loop found and terminates',
        c.length > 100 && c.length < 200, c.length + ' pts');
    let stepOK = true;
    for (let i = 0; i < c.length; i++) {
        const a = c[i], b = c[(i + 1) % c.length];
        if (Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1])) > 1) stepOK = false;
    }
    check('disc: consecutive points are 8-neighbours (loop closes)', stepOK);
    let radOK = true;
    for (const p of c) {
        const r = Math.hypot(p[0] - 30, p[1] - 30);
        if (r < 18.5 || r > 21) radOK = false;
    }
    check('disc: all points on the rim', radOK);

    // A concave "C" shape - this is exactly what the centroid-angle sort broke on
    const m2 = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const dx = x - 30, dy = y - 30;
            const r = Math.hypot(dx, dy);
            if (r <= 22 && r >= 12 && !(dx > 0 && Math.abs(dy) < 8)) m2[y * W + x] = 1;
        }
    }
    const c2 = C.traceContour(m2, W, H);
    let step2 = true;
    for (let i = 0; i + 1 < c2.length; i++) {
        const a = c2[i], b = c2[i + 1];
        if (Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1])) > 1) step2 = false;
    }
    check('concave C: ordering stays contiguous', step2, c2.length + ' pts');
    check('concave C: trace terminates', c2.length < 4 * (W + H), c2.length + ' pts');

    // the old approach, for comparison
    const pts = [];
    let mx = 0, my = 0;
    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            if (!m2[y * W + x]) continue;
            const nb = (xx, yy) => (xx < 0 || xx >= W || yy < 0 || yy >= H) ? 0 : m2[yy * W + xx];
            if (!nb(x - 1, y) || !nb(x + 1, y) || !nb(x, y - 1) || !nb(x, y + 1)) {
                pts.push([x, y]); mx += x; my += y;
            }
        }
    }
    mx /= pts.length; my /= pts.length;
    pts.sort((a, b) => Math.atan2(a[1] - my, a[0] - mx) - Math.atan2(b[1] - my, b[0] - mx));
    let jumps = 0;
    for (let i = 0; i + 1 < pts.length; i++) {
        if (Math.hypot(pts[i][0] - pts[i + 1][0], pts[i][1] - pts[i + 1][1]) > 1.5) jumps++;
    }
    console.log('       (centroid-angle sort on the same shape: ' + jumps + ' discontinuous jumps)');
    check('centroid-angle sort demonstrably breaks here', jumps > 5);

    const s = C.arcLengths(c);
    check('arc lengths normalised and increasing',
        s[0] === 0 && s[s.length - 1] <= 1 && s[s.length - 1] > 0.9);

    const empty = C.traceContour(new Uint8Array(W * H), W, H);
    check('empty mask -> empty contour, no crash', empty.length === 0);

    const single = new Uint8Array(W * H);
    single[30 * W + 30] = 1;
    check('isolated pixel -> no crash', C.traceContour(single, W, H).length >= 1);
}

section('Mask building');
{
    const W = 20, H = 20;
    const gray = new Float64Array(W * H);
    gray.fill(0);
    let inside = 0;
    for (let y = 5; y < 15; y++) for (let x = 5; x < 15; x++) { gray[y * W + x] = 128; inside++; }
    const r = C.buildMask(gray, W, H, {});
    check('interior rule selects the object', r.count === inside && r.rule === 'interior');

    const flat = new Float64Array(W * H).fill(0);
    const r2 = C.buildMask(flat, W, H, {});
    check('degenerate input falls back to full rect', r2.count === W * H);

    const wts = C.buildWeights(r.mask, W, H, { band: 1, edgeWeight: 4 });
    check('edge band weighting applied', wts[5 * W + 5] === 4 && wts[10 * W + 10] === 1);
}

// ------------------------------------------------------------- scad output

section('OpenSCAD emitter');
{
    const R = require('../src/report.js');
    const mk = (n) => {
        const ps = [];
        for (let k = 0; k < n; k++) {
            const p = [];
            for (let j = 0; j < 4; j++) {
                const row = [];
                for (let i = 0; i < 4; i++) row.push([i / 3, j / 3, 0.5]);
                p.push(row);
            }
            ps.push(p);
        }
        return ps;
    };

    const one = R.patchesToScad(mk(1), { warped: true });
    const many = R.patchesToScad(mk(49), { contour: [[0, 0], [1, 0], [1, 1], [0, 1]], W: 2, H: 2 });

    // The file a person pastes should be a preamble plus the geometry, and
    // nothing else. Both stages must be the same shape of file.
    const lines = (s) => s.split('\n').length;
    const nPatch = (s) => (s.match(/^  \[\[\[/gm) || []).length;
    check('one line per patch', nPatch(one) === 1 && nPatch(many) === 49,
        nPatch(one) + ' and ' + nPatch(many));
    check('fixed preamble is small and identical for both stages',
        lines(one) - nPatch(one) === lines(many) - nPatch(many) &&
        lines(one) - nPatch(one) < 40,
        (lines(one) - nPatch(one)) + ' fixed lines');
    check('a single-patch output is comparable to a hand-written one',
        lines(one) < 40, lines(one) + ' lines');

    // splinesteps is per patch, so a single patch needs far more of them than
    // each tile of a 7x7 grid to reach the same smoothness.
    const steps = (s) => +/^splinesteps = (\d+)/m.exec(s)[1];
    check('single patch gets a high subdivision', steps(one) >= 48, steps(one) + ' steps');
    check('49 patches get a low one', steps(many) <= 12, steps(many) + ' steps');
    check('total subdivision is comparable either way',
        Math.abs(steps(one) - 7 * steps(many)) < 20,
        steps(one) + ' vs 7 x ' + steps(many));

    // A first paste should render the thing you are going to print, not a
    // debug view covered in marker spheres.
    check('the control net is off by default', /show_control_net = false/.test(one));
    check('but is available', /if \(show_control_net\)/.test(one) && /showcps = true/.test(one));

    // One joined VNF, or a multi-patch export renders to nothing. The whole
    // solid is built and joined at mesh level for the same reason.
    check('patches are joined into a single VNF for export',
        /vnf_polyhedron\(vnf_join\(\[/.test(many) &&
        (many.match(/vnf_vertex_array\(/g) || []).length === 3);
    check('the debug call does not draw the surface a second time',
        /showpatch = false/.test(many));
    check('the net is scaled by list comprehension, not a non-uniform scale()',
        /surface = \[for \(p = patches\)/.test(one) && !/^scale\(/m.test(one));

    // The output is a closed shell: the same surface top and bottom, offset
    // straight down, skirted round the rim. Never CSG against an open sheet.
    check('a second face is emitted, offset straight down in z',
        /^thickness = /m.test(many) &&
        /bot = \[for \(r = top\).*\[0, 0, thickness\]/.test(many));
    check('the two faces are skirted into a closed solid',
        /_rim\(top\), _rim\(bot\)\], col_wrap = true/.test(many));
    check('no CSG is emitted against the surface',
        !/^\s*(intersection|difference|union)\s*\(/m.test(many));
    check('the header says what the surface is',
        /closed, printable solid/.test(one) && !/open surface/.test(one) &&
        /follows the traced outline/.test(one) && /bounding box/.test(many));
    check('the thickness line states what a slope costs',
        /^thickness = [\d.]+;.*steepest slope/m.test(one));
    check('no NaN/undefined', !/NaN|undefined/.test(one) && !/NaN|undefined/.test(many));
}

console.log('\nError magnitude formatting');
{
    const R = require('../src/report.js');
    const f = (v) => R.fmtErr(v);
    // Significant figures, not decimal places: the same three digits of
    // information whether the error is millimetres or microns. toFixed(3) spent
    // its whole budget on leading zeros and went blind below 0.001.
    check('a few mm keeps three significant figures', f(1.2345) === '1.23 mm', f(1.2345));
    check('sub-0.1 mm steps down to microns', f(0.003) === '3 \u00b5m', f(0.003));
    check('and keeps its figures there too', f(0.0035) === '3.5 \u00b5m', f(0.0035));
    check('values a decimal formatter would flatten stay distinct',
        f(0.0031) !== f(0.0034) && f(0.0031) === '3.1 \u00b5m', f(0.0031) + ' vs ' + f(0.0034));
    check('the switch happens at 0.1 mm, not mid-decade',
        f(0.1) === '0.1 mm' && f(0.099) === '99 \u00b5m', f(0.1) + ' / ' + f(0.099));
    check('trailing zeros are trimmed', f(12.4) === '12.4 mm' && f(250) === '250 mm',
        f(12.4) + ' / ' + f(250));
    check('sign is carried', f(-0.0035) === '-3.5 \u00b5m', f(-0.0035));
    check('zero and nonsense do not print as a number with digits',
        f(0) === '0 mm' && f(NaN) === '-', f(0) + ' / ' + f(NaN));
    check('a non-metric unit is left alone', R.fmtErr(0.004, 'grey') === '0.004 grey',
        R.fmtErr(0.004, 'grey'));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
