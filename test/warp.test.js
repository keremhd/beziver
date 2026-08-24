'use strict';

const F = require('../src/fit.js');
const C = require('../src/contour.js');
const W = require('../src/warp.js');

let pass = 0, fail = 0;
const check = (n, c, e) => {
    if (c) { pass++; console.log('  ok   ' + n + (e ? '  [' + e + ']' : '')); }
    else { fail++; console.log('  FAIL ' + n + (e ? '  [' + e + ']' : '')); }
};
const section = (t) => console.log('\n' + t);

let seed = 20260823;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

// ------------------------------------------------------------- differential

section('Bezier derivatives (vs finite differences)');
{
    const D = 5;
    const ctrl = [];
    for (let i = 0; i <= D; i++) ctrl.push([rnd(), rnd(), rnd()]);
    let e1 = 0, e2 = 0;
    const h = 1e-5;
    for (let k = 1; k < 10; k++) {
        const t = k / 10;
        const d1 = W.curveDeriv(ctrl, t, 1);
        const d2 = W.curveDeriv(ctrl, t, 2);
        const a = W.curveAt(ctrl, t - h), b = W.curveAt(ctrl, t + h), c = W.curveAt(ctrl, t);
        for (let j = 0; j < 3; j++) {
            e1 = Math.max(e1, Math.abs(d1[j] - (b[j] - a[j]) / (2 * h)));
            e2 = Math.max(e2, Math.abs(d2[j] - (a[j] - 2 * c[j] + b[j]) / (h * h)));
        }
    }
    check('first derivative', e1 < 1e-7, 'err ' + e1.toExponential(2));
    check('second derivative', e2 < 1e-3, 'err ' + e2.toExponential(2));
}

section('Patch partials (vs finite differences)');
{
    const D = 4;
    const P = [];
    for (let j = 0; j <= D; j++) {
        P.push([]);
        for (let i = 0; i <= D; i++) P[j].push([i / D + 0.1 * rnd(), j / D + 0.1 * rnd(), rnd()]);
    }
    let eu = 0, ev = 0;
    const h = 1e-5;
    for (let a = 1; a < 5; a++) {
        for (let b = 1; b < 5; b++) {
            const u = a / 5, v = b / 5;
            const pp = W.patchPartials(P, u, v);
            const S = W.patchAt(P, u, v);
            for (let k = 0; k < 3; k++) {
                eu = Math.max(eu, Math.abs(pp.du[k] -
                    (W.patchAt(P, u + h, v)[k] - W.patchAt(P, u - h, v)[k]) / (2 * h)));
                ev = Math.max(ev, Math.abs(pp.dv[k] -
                    (W.patchAt(P, u, v + h)[k] - W.patchAt(P, u, v - h)[k]) / (2 * h)));
                eu = Math.max(eu, Math.abs(pp.S[k] - S[k]));
            }
        }
    }
    check('d/du', eu < 1e-7, 'err ' + eu.toExponential(2));
    check('d/dv', ev < 1e-7, 'err ' + ev.toExponential(2));
}

// -------------------------------------------------------------------- Coons

section('Discrete Coons interior');
{
    // The identity map's boundary is the uniform grid, so Coons must return
    // exactly the uniform grid -- i.e. it reproduces an affine map exactly.
    const D = 6;
    const P = [];
    for (let j = 0; j <= D; j++) {
        P.push([]);
        for (let i = 0; i <= D; i++) P[j].push([i / D, j / D, 0]);
    }
    for (let j = 1; j < D; j++) for (let i = 1; i < D; i++) P[j][i] = [999, 999, 0];
    W.coonsInterior(P, D, [0, 1]);
    let err = 0;
    for (let j = 0; j <= D; j++) {
        for (let i = 0; i <= D; i++) {
            err = Math.max(err, Math.abs(P[j][i][0] - i / D), Math.abs(P[j][i][1] - j / D));
        }
    }
    check('identity map recovered exactly', err < 1e-12, 'err ' + err.toExponential(2));

    let detErr = 0;
    for (let a = 0; a <= 4; a++) {
        for (let b = 0; b <= 4; b++) {
            const pp = W.patchPartials(P, a / 4, b / 4);
            detErr = Math.max(detErr, Math.abs(pp.du[0] * pp.dv[1] - pp.du[1] * pp.dv[0] - 1));
        }
    }
    check('identity map has det J = 1', detErr < 1e-10, 'err ' + detErr.toExponential(2));
}

section('Fold detection is orientation-agnostic');
{
    const D = 3;
    const mk = (flip) => {
        const P = [];
        for (let j = 0; j <= D; j++) {
            P.push([]);
            for (let i = 0; i <= D; i++) P[j].push([flip ? 1 - i / D : i / D, j / D, 0]);
        }
        return P;
    };
    const fwd = W.buildRows(mk(false), D, 8, {});
    const rev = W.buildRows(mk(true), D, 8, {});
    check('forward map: no folds', fwd.fold.folded === 0 && fwd.fold.orientation === 1);
    check('mirrored map: no folds either', rev.fold.folded === 0 && rev.fold.orientation === -1,
        'orientation ' + rev.fold.orientation);
    check('both report det ~ 1 in their own orientation',
        Math.abs(rev.fold.detMin - 1) < 1e-9 && Math.abs(fwd.fold.detMin - 1) < 1e-9);
}

// ------------------------------------------------------------ curve fitting

section('Boundary curve fitting');
{
    const D = 4;
    const ctrl = [];
    for (let i = 0; i <= D; i++) ctrl.push([i / D, 0.3 * Math.sin(i), rnd()]);
    const pts = [];
    for (let k = 0; k <= 60; k++) pts.push(W.curveAt(ctrl, k / 60));

    const r = W.fitSideCurve(pts, D, 3);
    check('endpoints pinned to the samples',
        Math.abs(r.ctrl[0][0] - pts[0][0]) < 1e-15 &&
        Math.abs(r.ctrl[D][2] - pts[pts.length - 1][2]) < 1e-15);

    // Exactness needs the sampling parameterisation to match the one the fit
    // assumes. A straight line sampled uniformly has chord length == uniform
    // parameter, so that case must come back exact.
    const line = [];
    for (let k = 0; k <= 40; k++) {
        const t = k / 40;
        line.push([0.2 + 0.6 * t, 0.1 + 0.3 * t, 0.7 - 0.5 * t]);
    }
    // Exact down to the ridge term deliberately added to the normal equations
    // (relative 1e-9), so ~1e-10 residual is the floor here, not a defect.
    const rl = W.fitSideCurve(line, 4, 0);
    check('straight line recovered to the ridge floor', rl.err.sum < 1e-16,
        'rms ' + Math.sqrt(rl.err.sum).toExponential(2));

    // A general curve is sampled at uniform t but fitted from chord length,
    // so the two parameterisations disagree -- which is exactly what Hoschek
    // parameter correction exists to close.
    const r0 = W.fitSideCurve(pts, D, 0);
    const r6 = W.fitSideCurve(pts, D, 8);
    check('curve fit is close even before correction', r0.err.sum < 1e-3,
        'sse ' + r0.err.sum.toExponential(2));
    check('Hoschek correction improves it', r6.err.sum < r0.err.sum * 0.5,
        r0.err.sum.toExponential(2) + ' -> ' + r6.err.sum.toExponential(2));

    // Non-uniform sampling: parameter correction should help, never hurt.
    const skew = [];
    for (let k = 0; k <= 60; k++) skew.push(W.curveAt(ctrl, Math.pow(k / 60, 2.2)));
    const s0 = W.fitSideCurve(skew, 3, 0);
    const s6 = W.fitSideCurve(skew, 3, 6);
    check('Hoschek does not worsen a skewed sampling', s6.err.sum <= s0.err.sum * 1.000001,
        s0.err.sum.toExponential(2) + ' -> ' + s6.err.sum.toExponential(2));
}

// ------------------------------------------------------------------- lifted

function squareCase(D, extra) {
    const w = 64, h = 64;
    const b = F.bernsteinBasis(4);
    const Z = new Float64Array(16);
    for (let i = 0; i < 16; i++) Z[i] = 0.25 + 0.5 * rnd();
    const truth = { bx: b, by: b, Nx: 4, Ny: 4, Z };
    const data = new Float64Array(w * h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) data[y * w + x] = F.evalAt(truth, x / (w - 1), y / (h - 1));
    }
    const fit = F.fitHeightField(data, w, h, { basis: 'bernstein', nx: 4, lambda: 0 });
    const mask = new Uint8Array(w * h).fill(1);
    const contour = C.traceContour(mask, w, h);
    const res = W.warpFit(fit, contour, w, h,
        Object.assign({ degree: D, searchCorners: false, mask }, extra || {}));
    return { res, data, mask, w, h };
}

section('End-to-end on an exactly representable case');
{
    // Contour = the image border, so the domain map should be (near) identity
    // and the warped patch should reproduce the stage-1 surface.
    const lowD = squareCase(3);
    const hiD = squareCase(8);

    check('corners land on the square corners',
        JSON.stringify(hiD.res.corners) === JSON.stringify([0, 63, 126, 189]),
        JSON.stringify(hiD.res.corners));
    check('no folds on the square', hiD.res.interior.folded === 0,
        'detJ ' + hiD.res.interior.detMin.toFixed(2) + '..' + hiD.res.interior.detMax.toFixed(2));

    const e2e = (c) => {
        const r = W.rasterizePatch(c.res.patch, c.w, c.h);
        let sq = 0, n = 0;
        for (let i = 0; i < c.w * c.h; i++) {
            if (!r.cov[i]) continue;
            const e = (r.z[i] - c.data[i]) * 255;
            sq += e * e; n++;
        }
        return { rms: Math.sqrt(sq / n), cov: n / (c.w * c.h) };
    };
    const a = e2e(lowD), b2 = e2e(hiD);
    check('degree 8 reproduces the surface', b2.rms < 0.02, b2.rms.toFixed(4) + ' grey levels');
    check('higher degree beats lower', b2.rms < a.rms,
        'D3 ' + a.rms.toFixed(3) + ' -> D8 ' + b2.rms.toFixed(3));
    check('raster covers the interior', b2.cov > 0.95, (100 * b2.cov).toFixed(1) + '%');
    check('boundary follows the outline sub-pixel', hiD.res.boundary.xyPxMax < 0.05,
        hiD.res.boundary.xyPxMax.toFixed(4) + ' px');
}

section('Rasteriser');
{
    // identity map, z = u: the raster must be an exact ramp everywhere
    const D = 3, n = 40;
    const P = [];
    for (let j = 0; j <= D; j++) {
        P.push([]);
        for (let i = 0; i <= D; i++) P[j].push([i / D, j / D, i / D]);
    }
    const r = W.rasterizePatch(P, n, n, 120);
    let cov = 0, err = 0;
    for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
            const i = y * n + x;
            if (!r.cov[i]) continue;
            cov++;
            err = Math.max(err, Math.abs(r.z[i] - x / (n - 1)));
        }
    }
    check('near-full coverage of the unit square', cov > 0.94 * n * n, (100 * cov / (n * n)).toFixed(1) + '%');
    check('interpolated z is exact', err < 1e-9, 'err ' + err.toExponential(2));
}

// ------------------------------------------------------------ realistic blob

function blobCase(amp) {
    const w = 128, h = 128;
    const N = 7, b = F.bsplineBasis(N), Z = new Float64Array(N * N);
    for (let i = 0; i < N * N; i++) Z[i] = rnd();
    const g = F.evalGrid({ bx: b, by: b, Nx: N, Ny: N, Z }, w, h);
    let lo = Infinity, hi = -Infinity;
    for (const v of g) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    const harm = [{ k: 2, a: amp, p: 0.6 }, { k: 3, a: -amp * 0.6, p: 2.1 }, { k: 5, a: amp * 0.4, p: 4 }];
    const grey = new Float64Array(w * h), data = new Float64Array(w * h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = y * w + x, u = x / (w - 1) - 0.5, v = y / (h - 1) - 0.5;
            let rr = 0.36;
            for (const q of harm) rr += q.a * Math.cos(q.k * Math.atan2(v, u) + q.p);
            const z = Math.hypot(u, v) <= rr ? 0.12 + 0.76 * ((g[i] - lo) / (hi - lo)) : 0;
            data[i] = z; grey[i] = z * 255;
        }
    }
    const m = C.buildMask(grey, w, h, {});
    const contour = C.traceContour(m.mask, w, h);
    const fit = F.fitHeightField(data, w, h, { basis: 'bspline', nx: 12, mask: m.mask, lambda: 1e-4 });
    return { w, h, data, mask: m.mask, contour, fit };
}

section('Realistic blob');
{
    const bc = blobCase(0.10);
    const run = (o) => {
        const res = W.warpFit(bc.fit, bc.contour, bc.w, bc.h,
            Object.assign({ mask: bc.mask }, o));
        const r = W.rasterizePatch(res.patch, bc.w, bc.h);
        let sq = 0, n = 0, covIn = 0, maskN = 0;
        for (let i = 0; i < bc.w * bc.h; i++) {
            if (bc.mask[i]) maskN++;
            if (r.cov[i] && bc.mask[i]) { covIn++; const e = (r.z[i] - bc.data[i]) * 255; sq += e * e; n++; }
        }
        return { res, rms: Math.sqrt(sq / n), cov: covIn / maskN };
    };

    const coons = run({ degree: 8, searchCorners: true, domain: 'coons' });
    const harm = run({ degree: 8, searchCorners: true, domain: 'harmonic' });

    check('patch boundary tracks the outline', harm.res.boundary.xyPxMax < 1.5,
        harm.res.boundary.xyPxMax.toFixed(2) + ' px');
    check('warped patch covers the masked region', harm.cov > 0.95,
        (100 * harm.cov).toFixed(1) + '%');
    check('end-to-end error is small', harm.rms < 3, harm.rms.toFixed(2) + ' grey levels');
    // this is the claim made for the harmonic map, so it needs to be measured
    check('harmonic map folds less than Coons',
        harm.res.interior.foldFraction < coons.res.interior.foldFraction,
        'coons ' + (100 * coons.res.interior.foldFraction).toFixed(1) + '% -> harmonic ' +
        (100 * harm.res.interior.foldFraction).toFixed(1) + '%');
    check('fold locations are classified',
        harm.res.interior.foldWhere &&
        typeof harm.res.interior.foldWhere.interior === 'number',
        JSON.stringify(harm.res.interior.foldWhere));

    // area weighting vs parameter-space weighting really do differ
    const d = Math.abs(harm.res.interior.rms - harm.res.interior.rmsUnweighted);
    check('area-weighted rms differs from parameter-space rms', d > 1e-6,
        'weighted ' + harm.res.interior.rms.toFixed(3) +
        ' vs unweighted ' + harm.res.interior.rmsUnweighted.toFixed(3));

    // concavity should make folding worse, not silently vanish
    const nasty = blobCase(0.17);
    const nres = W.warpFit(nasty.fit, nasty.contour, nasty.w, nasty.h,
        { degree: 8, searchCorners: true, domain: 'coons', mask: nasty.mask });
    check('a more concave outline folds more',
        nres.interior.foldFraction > coons.res.interior.foldFraction,
        (100 * nres.interior.foldFraction).toFixed(1) + '% vs ' +
        (100 * coons.res.interior.foldFraction).toFixed(1) + '%');
}

section('Control net conditioning');
{
    const bc = blobCase(0.10);
    const run = (lam) => {
        const r = W.warpFit(bc.fit, bc.contour, bc.w, bc.h,
            { degree: 8, searchCorners: true, domain: 'harmonic', mask: bc.mask, lambda: lam });
        let mx = 0, out = 0, tot = 0;
        for (const row of r.patch) {
            for (const q of row) {
                mx = Math.max(mx, Math.abs(q[2])); tot++;
                if (q[2] < -0.25 || q[2] > 1.25) out++;
            }
        }
        const ras = W.rasterizePatch(r.patch, bc.w, bc.h);
        let sq = 0, n = 0;
        for (let i = 0; i < bc.w * bc.h; i++) {
            if (!ras.cov[i] || !bc.mask[i]) continue;
            const e = (ras.z[i] - bc.data[i]) * 255; sq += e * e; n++;
        }
        return { mx, out, tot, rms: Math.sqrt(sq / n) };
    };

    // Unpenalised, the high-degree Bernstein net oscillates wildly: the
    // SURFACE is still fine because the oscillations cancel, so only the
    // control points reveal the problem. That is what the penalty is for.
    const raw = run(0);
    const reg = run(1e-6);
    check('unregularised net does oscillate far outside the geometry',
        raw.mx > 3, 'max |z| ' + raw.mx.toFixed(1) + ' on a 0..1 surface');
    check('smoothing keeps the control net near the geometry',
        reg.mx < 3, 'max |z| ' + reg.mx.toFixed(2));
    check('far fewer control points stray outside',
        reg.out < raw.out / 2, raw.out + '/' + raw.tot + ' -> ' + reg.out + '/' + reg.tot);
    check('and accuracy is not paid for it', reg.rms < raw.rms * 1.3,
        raw.rms.toFixed(3) + ' -> ' + reg.rms.toFixed(3) + ' grey levels');
}

section('Guards');
{
    let threw = false;
    try { W.warpFit(null, [[0, 0], [1, 1]], 10, 10, {}); } catch (e) { threw = /outline/.test(e.message); }
    check('short contour rejected with a clear message', threw);

    const bc = blobCase(0.08);
    const t0 = Date.now();
    const r = W.warpFit(bc.fit, bc.contour, bc.w, bc.h, { degree: 200, mask: bc.mask });
    const ms = Date.now() - t0;
    check('absurd degree clamped, and still returns promptly',
        r.degreeClamped && r.degree === W.MAX_DEGREE && ms < 20000,
        'D=' + r.degree + ' in ' + ms + 'ms');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
