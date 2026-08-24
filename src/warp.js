'use strict';

// Stage 2: reparameterise the stage-1 height field onto a patch whose
// boundary IS the traced outline.
//
// The whole point of staging is that this file never touches the image. It
// samples f, a smooth analytic function, so there is no mask, no noise and no
// missing data here. And because the (x,y) control points are pinned first,
// solving for the interior heights stays linear:
//
//     r(u,v) = S_z(u,v) - f(S_x(u,v), S_y(u,v))
//
// the first term is linear in the unknowns and the second is a constant.

const { binom, cholSolve, evalAt } = require('./fit.js');

// --------------------------------------------------------- bezier helpers

function bernAll(D, t) {
    const out = new Array(D + 1);
    for (let i = 0; i <= D; i++) out[i] = binom(D, i) * Math.pow(t, i) * Math.pow(1 - t, D - i);
    return out;
}

function curveAt(ctrl, t) {
    const D = ctrl.length - 1;
    const B = bernAll(D, t);
    const p = [0, 0, 0];
    for (let i = 0; i <= D; i++) {
        for (let k = 0; k < 3; k++) p[k] += B[i] * ctrl[i][k];
    }
    return p;
}

// n-th derivative via the difference control net
function curveDeriv(ctrl, t, order) {
    let c = ctrl.map((p) => p.slice());
    let D = c.length - 1;
    for (let o = 0; o < order; o++) {
        if (D < 1) return [0, 0, 0];
        const nc = [];
        for (let i = 0; i < D; i++) {
            nc.push([
                D * (c[i + 1][0] - c[i][0]),
                D * (c[i + 1][1] - c[i][1]),
                D * (c[i + 1][2] - c[i][2]),
            ]);
        }
        c = nc; D--;
    }
    return curveAt(c, t);
}

// patch[j][i] = [x,y,z]; i indexes u, j indexes v
function patchAt(P, u, v) {
    const D = P.length - 1, E = P[0].length - 1;
    const Bu = bernAll(E, u), Bv = bernAll(D, v);
    const s = [0, 0, 0];
    for (let j = 0; j <= D; j++) {
        for (let i = 0; i <= E; i++) {
            const w = Bv[j] * Bu[i];
            for (let k = 0; k < 3; k++) s[k] += w * P[j][i][k];
        }
    }
    return s;
}

// Surface point plus both partials, for the Jacobian / area element.
function patchPartials(P, u, v) {
    const D = P.length - 1, E = P[0].length - 1;
    const Bu = bernAll(E, u), Bv = bernAll(D, v);
    const Bu1 = E > 0 ? bernAll(E - 1, u) : [0];
    const Bv1 = D > 0 ? bernAll(D - 1, v) : [0];

    const S = [0, 0, 0], du = [0, 0, 0], dv = [0, 0, 0];
    for (let j = 0; j <= D; j++) {
        for (let i = 0; i <= E; i++) {
            const w = Bv[j] * Bu[i];
            for (let k = 0; k < 3; k++) S[k] += w * P[j][i][k];
        }
    }
    for (let j = 0; j <= D; j++) {
        for (let i = 0; i < E; i++) {
            const w = Bv[j] * Bu1[i] * E;
            for (let k = 0; k < 3; k++) du[k] += w * (P[j][i + 1][k] - P[j][i][k]);
        }
    }
    for (let j = 0; j < D; j++) {
        for (let i = 0; i <= E; i++) {
            const w = Bv1[j] * Bu[i] * D;
            for (let k = 0; k < 3; k++) dv[k] += w * (P[j + 1][i][k] - P[j][i][k]);
        }
    }
    return { S, du, dv };
}

// ------------------------------------------------------- boundary  curves

function chordParams(pts) {
    const n = pts.length;
    const t = new Float64Array(n);
    let acc = 0;
    for (let i = 1; i < n; i++) {
        const a = pts[i], b = pts[i - 1];
        acc += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
        t[i] = acc;
    }
    if (acc > 0) for (let i = 0; i < n; i++) t[i] /= acc;
    else for (let i = 0; i < n; i++) t[i] = n > 1 ? i / (n - 1) : 0;
    return t;
}

// Least squares for the interior control points, endpoints pinned to the
// corner samples so the four sides close into a loop exactly.
function solveInterior(pts, t, D, C0, CD) {
    const m = D - 1;
    const ctrl = [C0.slice()];
    for (let i = 0; i < m; i++) ctrl.push([0, 0, 0]);
    ctrl.push(CD.slice());
    if (m <= 0) return ctrl;

    const G = new Float64Array(m * m);
    const rhs = [new Float64Array(m), new Float64Array(m), new Float64Array(m)];

    for (let s = 0; s < pts.length; s++) {
        const B = bernAll(D, t[s]);
        for (let a = 1; a <= m; a++) {
            for (let b = a; b <= m; b++) G[(a - 1) * m + (b - 1)] += B[a] * B[b];
        }
        for (let k = 0; k < 3; k++) {
            const r = pts[s][k] - B[0] * C0[k] - B[D] * CD[k];
            for (let a = 1; a <= m; a++) rhs[k][a - 1] += B[a] * r;
        }
    }
    for (let a = 0; a < m; a++) {
        for (let b = a + 1; b < m; b++) G[b * m + a] = G[a * m + b];
    }
    let tr = 0;
    for (let a = 0; a < m; a++) tr += G[a * m + a];
    for (let a = 0; a < m; a++) G[a * m + a] += (tr / m) * 1e-9 + 1e-12;

    for (let k = 0; k < 3; k++) {
        const x = cholSolve(G, rhs[k], m);
        if (!x) continue;
        for (let a = 0; a < m; a++) ctrl[a + 1][k] = x[a];
    }
    return ctrl;
}

// Hoschek parameter correction: one Newton step per sample on
// d/dt |C(t)-P|^2 = 0, kept monotone so the parameterisation stays valid.
function correctParams(pts, ctrl, t) {
    const n = pts.length;
    const out = new Float64Array(n);
    out[0] = 0;
    for (let i = 1; i < n - 1; i++) {
        let ti = t[i];
        for (let step = 0; step < 2; step++) {
            const C = curveAt(ctrl, ti);
            const C1 = curveDeriv(ctrl, ti, 1);
            const C2 = curveDeriv(ctrl, ti, 2);
            const d = [C[0] - pts[i][0], C[1] - pts[i][1], C[2] - pts[i][2]];
            const num = d[0] * C1[0] + d[1] * C1[1] + d[2] * C1[2];
            const den = C1[0] * C1[0] + C1[1] * C1[1] + C1[2] * C1[2] +
                        d[0] * C2[0] + d[1] * C2[1] + d[2] * C2[2];
            if (!Number.isFinite(den) || Math.abs(den) < 1e-14) break;
            ti -= num / den;
            if (!Number.isFinite(ti)) { ti = t[i]; break; }
            ti = Math.max(0, Math.min(1, ti));
        }
        out[i] = Math.max(out[i - 1], Math.min(1, ti));
    }
    out[n - 1] = 1;
    return out;
}

function curveErr(pts, ctrl, t) {
    let sxy = 0, sz = 0;
    for (let i = 0; i < pts.length; i++) {
        const C = curveAt(ctrl, t[i]);
        sxy += (C[0] - pts[i][0]) ** 2 + (C[1] - pts[i][1]) ** 2;
        sz += (C[2] - pts[i][2]) ** 2;
    }
    const n = pts.length || 1;
    return { xy: Math.sqrt(sxy / n), z: Math.sqrt(sz / n), sum: (sxy + sz) / n };
}

function fitSideCurve(pts, D, iters) {
    let t = chordParams(pts);
    let ctrl = solveInterior(pts, t, D, pts[0], pts[pts.length - 1]);
    for (let it = 0; it < iters; it++) {
        const t2 = correctParams(pts, ctrl, t);
        const c2 = solveInterior(pts, t2, D, pts[0], pts[pts.length - 1]);
        if (curveErr(pts, c2, t2).sum > curveErr(pts, ctrl, t).sum) break; // no gain
        t = t2; ctrl = c2;
    }
    return { ctrl, t, err: curveErr(pts, ctrl, t) };
}

// ------------------------------------------------------- corner selection

function sideSlice(pts, a, b) {
    const n = pts.length;
    const out = [];
    let i = a;
    for (;;) {
        out.push(pts[i]);
        if (i === b) break;
        i = (i + 1) % n;
        if (out.length > n) break;
    }
    return out;
}

function scoreCorners(pts, corners, D) {
    let s = 0;
    for (let k = 0; k < 4; k++) {
        const side = sideSlice(pts, corners[k], corners[(k + 1) % 4]);
        if (side.length < 2) return Infinity;
        const t = chordParams(side);
        const ctrl = solveInterior(side, t, D, side[0], side[side.length - 1]);
        s += curveErr(side, ctrl, t).sum * side.length;
    }
    return s / pts.length;
}

// Corner placement is the only discrete choice in the whole pipeline. Seed
// from a few rotations of equally spaced corners, then coordinate-descend --
// the boundary fit error is itself the right objective, since corners belong
// where a single Bezier curve stops being able to follow the outline.
function chooseCorners(pts, D, opts) {
    opts = opts || {};
    const n = pts.length;
    const minSep = Math.max(D + 1, Math.floor(n * 0.04));
    if (n < 4 * minSep) {
        return { corners: [0, 1, 2, 3].map((k) => Math.floor(k * n / 4)), searched: false };
    }
    if (!opts.search) {
        return { corners: [0, 1, 2, 3].map((k) => Math.floor(k * n / 4)), searched: false };
    }

    const cand = Math.max(8, Math.min(28, Math.floor(n / (4 * 2))));
    let best = null, bestScore = Infinity;

    for (let r = 0; r < 4; r++) {
        let corners = [0, 1, 2, 3].map((k) => (Math.floor(k * n / 4) + Math.floor(r * n / 16)) % n);
        corners.sort((a, b) => a - b);
        let score = scoreCorners(pts, corners, D);

        for (let round = 0; round < 3; round++) {
            for (let k = 0; k < 4; k++) {
                const prev = corners[(k + 3) % 4], next = corners[(k + 1) % 4];
                // walk the arc strictly between the neighbouring corners
                let span = (next - prev + n) % n;
                if (span < 2 * minSep + 2) continue;
                const stride = Math.max(1, Math.floor((span - 2 * minSep) / cand));
                let localBest = corners[k], localScore = score;
                for (let o = minSep; o <= span - minSep; o += stride) {
                    const trial = corners.slice();
                    trial[k] = (prev + o) % n;
                    const s = scoreCorners(pts, trial, D);
                    if (s < localScore) { localScore = s; localBest = trial[k]; }
                }
                corners[k] = localBest;
                score = localScore;
            }
        }
        if (score < bestScore) { bestScore = score; best = corners.slice(); }
    }
    return { corners: best, searched: true, score: bestScore };
}

// ------------------------------------------------------------ the warp fit

// Discrete bilinearly-blended Coons: applied to a Bezier control net it
// produces exactly the Coons surface of the four boundary curves, as a Bezier
// patch of the same degree.
function coonsInterior(P, D, coords) {
    for (let j = 1; j < D; j++) {
        for (let i = 1; i < D; i++) {
            const a = i / D, b = j / D;
            for (const k of coords) {
                P[j][i][k] =
                    (1 - a) * P[j][0][k] + a * P[j][D][k] +
                    (1 - b) * P[0][i][k] + b * P[D][i][k] -
                    ((1 - a) * (1 - b) * P[0][0][k] + (1 - a) * b * P[D][0][k] +
                     a * (1 - b) * P[0][D][k] + a * b * P[D][D][k]);
            }
        }
    }
}

// Generic least-squares solve for the interior control points of one
// coordinate, with the boundary ring held fixed. Used for x and y (fitting
// the domain map) and for z (fitting the height field).
//
// `lambda` adds a second-difference penalty on the control net. At the degrees
// this stage needs to follow an outline, the Bernstein basis is ill-conditioned
// enough that an unpenalised solve returns a wildly oscillating net whose
// oscillations cancel on the surface: the fit looks fine but the control points
// land far outside the geometry, which is useless to inspect and numerically
// fragile. The penalty's null space is the affine functions, so it costs
// almost nothing in accuracy.
function solveInteriorCoord(P, D, rows, coord, lambda) {
    const m = (D - 1) * (D - 1);
    if (m <= 0) return false;
    if (lambda === undefined) lambda = 0;

    const G = new Float64Array(m * m);
    const rhs = new Float64Array(m);
    const idxBuf = new Int32Array(m);
    const valBuf = new Float64Array(m);

    let sumW = 0;
    for (const row of rows) {
        const { Bu, Bv, w } = row;
        if (w <= 0) continue;
        sumW += w;

        let known = 0, n = 0;
        for (let j = 0; j <= D; j++) {
            for (let i = 0; i <= D; i++) {
                const c = Bv[j] * Bu[i];
                if (j === 0 || j === D || i === 0 || i === D) known += c * P[j][i][coord];
                else { idxBuf[n] = (j - 1) * (D - 1) + (i - 1); valBuf[n] = c; n++; }
            }
        }
        const r = row.target[coord] - known;

        for (let a = 0; a < n; a++) {
            const pa = idxBuf[a], va = valBuf[a] * w;
            rhs[pa] += va * r;
            for (let b = a; b < n; b++) {
                const q = idxBuf[b];
                const lo = Math.min(pa, q), hi = Math.max(pa, q);
                G[lo * m + hi] += va * valBuf[b];
            }
        }
    }

    // normalise the data term so lambda is a dimensionless ratio
    if (sumW > 0) {
        const inv = 1 / sumW;
        for (let i = 0; i < m * m; i++) G[i] *= inv;
        for (let i = 0; i < m; i++) rhs[i] *= inv;
    }

    if (lambda > 0) {
        const stencils = [];
        for (let j = 0; j <= D; j++) {
            for (let i = 0; i + 2 <= D; i++) stencils.push([[j, i], [j, i + 1], [j, i + 2]]);
        }
        for (let i = 0; i <= D; i++) {
            for (let j = 0; j + 2 <= D; j++) stencils.push([[j, i], [j + 1, i], [j + 2, i]]);
        }
        const co = [1, -2, 1];
        const sc = lambda / Math.max(1, stencils.length);
        const isFree = (j, i) => j > 0 && j < D && i > 0 && i < D;

        for (const st of stencils) {
            // split the stencil into free unknowns and the fixed boundary ring;
            // the fixed part moves to the right-hand side
            const free = [], vals = [];
            let fixed = 0;
            for (let k = 0; k < 3; k++) {
                const [j, i] = st[k];
                if (isFree(j, i)) { free.push((j - 1) * (D - 1) + (i - 1)); vals.push(co[k]); }
                else fixed += co[k] * P[j][i][coord];
            }
            for (let a = 0; a < free.length; a++) {
                rhs[free[a]] -= sc * vals[a] * fixed;
                for (let b = 0; b < free.length; b++) {
                    const lo = Math.min(free[a], free[b]), hi = Math.max(free[a], free[b]);
                    if (lo === hi && a !== b) continue;
                    if (free[a] <= free[b]) G[lo * m + hi] += sc * vals[a] * vals[b];
                }
            }
        }
    }

    for (let a = 0; a < m; a++) {
        for (let b = a + 1; b < m; b++) G[b * m + a] = G[a * m + b];
    }
    let tr = 0;
    for (let a = 0; a < m; a++) tr += G[a * m + a];
    for (let a = 0; a < m; a++) G[a * m + a] += (tr / m) * 1e-9 + 1e-12;

    const sol = cholSolve(G, rhs, m);
    if (!sol) return false;
    for (let j = 1; j < D; j++) {
        for (let i = 1; i < D; i++) P[j][i][coord] = sol[(j - 1) * (D - 1) + (i - 1)];
    }
    return true;
}

// Boundary point of the patch, using only the boundary control ring.
function boundaryPoint(P, D, edge, t) {
    const B = bernAll(D, t);
    const p = [0, 0, 0];
    for (let i = 0; i <= D; i++) {
        const q = edge === 'v0' ? P[0][i] : edge === 'v1' ? P[D][i]
                : edge === 'u0' ? P[i][0] : P[i][D];
        for (let k = 0; k < 3; k++) p[k] += B[i] * q[k];
    }
    return p;
}

// Discrete harmonic map from the unit square onto the region bounded by the
// four fitted curves: solve Laplace for x and y with the boundary curves as
// Dirichlet data. By Rado-Kneser-Choquet this is injective whenever the target
// is convex, and it is far better behaved than Coons on mildly concave
// outlines -- which is where the Coons map starts folding.
function harmonicDomain(K, P, D, iters) {
    const X = new Float64Array(K * K), Y = new Float64Array(K * K);
    const fixed = new Uint8Array(K * K);

    for (let k = 0; k < K; k++) {
        const t = k / (K - 1);
        const bot = boundaryPoint(P, D, 'v0', t);
        const top = boundaryPoint(P, D, 'v1', t);
        const lef = boundaryPoint(P, D, 'u0', t);
        const rig = boundaryPoint(P, D, 'u1', t);
        X[0 * K + k] = bot[0]; Y[0 * K + k] = bot[1]; fixed[0 * K + k] = 1;
        X[(K - 1) * K + k] = top[0]; Y[(K - 1) * K + k] = top[1]; fixed[(K - 1) * K + k] = 1;
        X[k * K + 0] = lef[0]; Y[k * K + 0] = lef[1]; fixed[k * K + 0] = 1;
        X[k * K + (K - 1)] = rig[0]; Y[k * K + (K - 1)] = rig[1]; fixed[k * K + (K - 1)] = 1;
    }

    // transfinite Coons start, so the relaxation has little left to do
    for (let j = 1; j < K - 1; j++) {
        const b = j / (K - 1);
        for (let i = 1; i < K - 1; i++) {
            const a = i / (K - 1);
            const idx = j * K + i;
            X[idx] = (1 - a) * X[j * K] + a * X[j * K + K - 1] +
                     (1 - b) * X[i] + b * X[(K - 1) * K + i] -
                     ((1 - a) * (1 - b) * X[0] + (1 - a) * b * X[(K - 1) * K] +
                      a * (1 - b) * X[K - 1] + a * b * X[(K - 1) * K + K - 1]);
            Y[idx] = (1 - a) * Y[j * K] + a * Y[j * K + K - 1] +
                     (1 - b) * Y[i] + b * Y[(K - 1) * K + i] -
                     ((1 - a) * (1 - b) * Y[0] + (1 - a) * b * Y[(K - 1) * K] +
                      a * (1 - b) * Y[K - 1] + a * b * Y[(K - 1) * K + K - 1]);
        }
    }

    const omega = 2 / (1 + Math.sin(Math.PI / K));
    for (let it = 0; it < iters; it++) {
        for (let j = 1; j < K - 1; j++) {
            for (let i = 1; i < K - 1; i++) {
                const idx = j * K + i;
                if (fixed[idx]) continue;
                X[idx] += omega * (0.25 * (X[idx - 1] + X[idx + 1] + X[idx - K] + X[idx + K]) - X[idx]);
                Y[idx] += omega * (0.25 * (Y[idx - 1] + Y[idx + 1] + Y[idx - K] + Y[idx + K]) - Y[idx]);
            }
        }
    }
    return { X, Y, K };
}

// Signed-area orientation of the map, so folds are detected as sign REVERSALS
// rather than against a hardcoded convention.
function foldStats(dets) {
    let sum = 0;
    for (const d of dets) sum += d;
    const sgn = sum >= 0 ? 1 : -1;
    let lo = Infinity, hi = -Infinity, folded = 0;
    for (const d of dets) {
        const v = d * sgn;
        lo = Math.min(lo, v); hi = Math.max(hi, v);
        if (v <= 0) folded++;
    }
    return {
        orientation: sgn, detMin: lo === Infinity ? 0 : lo, detMax: hi === -Infinity ? 0 : hi,
        folded, foldFraction: dets.length ? folded / dets.length : 0,
    };
}

// Sample rows over the parameter square: Bernstein rows, the mapped point,
// the Jacobian determinant and the area-element weight.
function buildRows(P, D, M, opts) {
    opts = opts || {};
    const mask = opts.mask || null;
    const W = opts.W || 1, H = opts.H || 1;
    const rows = [];
    const dets = [];
    let outside = 0;

    for (let jj = 0; jj < M; jj++) {
        const v = jj / (M - 1);
        const Bv = bernAll(D, v);
        for (let ii = 0; ii < M; ii++) {
            const u = ii / (M - 1);
            const Bu = bernAll(D, u);
            const pp = patchPartials(P, u, v);
            const det = pp.du[0] * pp.dv[1] - pp.du[1] * pp.dv[0];
            dets.push(det);

            const sx = pp.S[0], sy = pp.S[1];
            let w = Math.abs(det);
            let inside = sx >= 0 && sx <= 1 && sy >= 0 && sy <= 1;
            if (inside && mask) {
                const px = Math.min(W - 1, Math.max(0, Math.round(sx * (W - 1))));
                const py = Math.min(H - 1, Math.max(0, Math.round(sy * (H - 1))));
                if (!mask[py * W + px]) inside = false;
            }
            // f is unreliable outside its data support, so lean on it less
            if (!inside) { outside++; w *= 0.1; }

            rows.push({ u, v, Bu, Bv, w, det, sx, sy, target: [0, 0, 0] });
        }
    }
    const fold = foldStats(dets);
    // Where a fold sits matters: samples right at a patch corner can pinch to
    // det ~ 0 harmlessly, while a strictly interior reversal is a genuine
    // self-intersection of the surface.
    const where = { corner: 0, edge: 0, interior: 0 };
    for (let i = 0; i < rows.length; i++) {
        if (dets[i] * fold.orientation > 0) continue;
        const du = Math.min(rows[i].u, 1 - rows[i].u);
        const dv = Math.min(rows[i].v, 1 - rows[i].v);
        if (du < 0.06 && dv < 0.06) where.corner++;
        else if (du < 0.06 || dv < 0.06) where.edge++;
        else where.interior++;
    }
    fold.where = where;
    return { rows, dets, outside, fold };
}

// Above this the interior solve is (D-1)^2 unknowns in a dense Cholesky, and
// a single Bezier patch of such a degree is numerically pointless anyway.
const MAX_DEGREE = 20;

function warpFit(fit, contour, W, H, opts) {
    opts = opts || {};
    let D = Math.max(3, Math.min(MAX_DEGREE, Math.round(opts.degree || 6)));
    // 255 for an 8-bit image, or the above-water span for an STL depth map
    const zScale = opts.zScale === undefined ? 255 : opts.zScale;
    const lambdaZ = opts.lambda === undefined ? 1e-6 : opts.lambda;
    const lambdaXY = opts.lambdaXY === undefined ? lambdaZ : opts.lambdaXY;
    const iters = opts.hoschek === undefined ? 3 : opts.hoschek;

    if (!contour || contour.length < 8) throw new Error('need a traced outline of at least 8 points');

    // Lift the outline onto the stage-1 surface. Normalised x,y are exactly
    // f's own parameters, so this is a direct evaluation.
    const lifted = contour.map(([x, y]) => {
        const u = W === 1 ? 0 : x / (W - 1);
        const v = H === 1 ? 0 : y / (H - 1);
        return [u, v, evalAt(fit, u, v)];
    });

    // Each side needs at least D+1 samples to pin down its control points.
    const maxD = Math.max(3, Math.min(MAX_DEGREE, Math.floor(lifted.length / 4) - 1));
    const degreeClamped = Math.round(opts.degree || 6) > maxD;
    if (D > maxD) D = maxD;

    const cs = chooseCorners(lifted, D, { search: opts.searchCorners !== false });
    const corners = cs.corners;

    const sides = [];
    for (let k = 0; k < 4; k++) {
        const side = sideSlice(lifted, corners[k], corners[(k + 1) % 4]);
        sides.push(fitSideCurve(side, D, iters));
    }

    // assemble the boundary control net (see the corner bookkeeping below)
    const P = [];
    for (let j = 0; j <= D; j++) {
        P.push([]);
        for (let i = 0; i <= D; i++) P[j].push([0, 0, 0]);
    }
    for (let i = 0; i <= D; i++) {
        P[0][i] = sides[0].ctrl[i].slice();          // c0 -> c1  along u at v=0
        P[D][i] = sides[2].ctrl[D - i].slice();      // c2 -> c3, reversed
    }
    for (let j = 0; j <= D; j++) {
        P[j][D] = sides[1].ctrl[j].slice();          // c1 -> c2  along v at u=1
        P[j][0] = sides[3].ctrl[D - j].slice();      // c3 -> c0, reversed
    }

    coonsInterior(P, D, [0, 1, 2]);                  // x,y map + a z starting point

    // Optionally replace the Coons interior with a harmonic one. The boundary
    // ring is untouched either way, so the patch edges stay on the outline.
    let harmonic = null;
    if (opts.domain === 'harmonic') {
        const K = opts.harmonicGrid || 49;
        const hm = harmonicDomain(K, P, D, opts.harmonicIters || 1200);
        const hrows = [];
        for (let j = 1; j < K - 1; j++) {
            const v = j / (K - 1), Bv = bernAll(D, v);
            for (let i = 1; i < K - 1; i++) {
                const u = i / (K - 1);
                hrows.push({
                    Bu: bernAll(D, u), Bv, w: 1,
                    target: [hm.X[j * K + i], hm.Y[j * K + i], 0],
                });
            }
        }
        solveInteriorCoord(P, D, hrows, 0, lambdaXY);
        solveInteriorCoord(P, D, hrows, 1, lambdaXY);

        // folds in the relaxed map itself, before the Bezier net approximates it
        const hd = [];
        for (let j = 0; j + 1 < K; j++) {
            for (let i = 0; i + 1 < K; i++) {
                const dxu = hm.X[j * K + i + 1] - hm.X[j * K + i];
                const dyu = hm.Y[j * K + i + 1] - hm.Y[j * K + i];
                const dxv = hm.X[(j + 1) * K + i] - hm.X[j * K + i];
                const dyv = hm.Y[(j + 1) * K + i] - hm.Y[j * K + i];
                hd.push(dxu * dyv - dxv * dyu);
            }
        }
        harmonic = { grid: K, fold: foldStats(hd) };
    }

    // Now x,y are frozen, so the heights are a plain linear solve.
    const M = opts.samples || Math.max(24, 4 * D);
    const built = buildRows(P, D, M, { mask: opts.mask, W, H });
    for (const row of built.rows) {
        row.target[2] = evalAt(fit,
            Math.min(1, Math.max(0, row.sx)), Math.min(1, Math.max(0, row.sy)));
    }
    const solved = solveInteriorCoord(P, D, built.rows, 2, lambdaZ);

    // Area-weighted residual: weighting by |det J| makes this the mean error
    // over the blob rather than over parameter space. Those differ wherever
    // the map stretches, which is most of why a parameter-space average
    // misreports how good a warped fit really is.
    let wsum = 0, wsq = 0, usq = 0, un = 0;
    for (const row of built.rows) {
        let s2 = 0;
        for (let j = 0; j <= D; j++) {
            for (let i = 0; i <= D; i++) s2 += row.Bv[j] * row.Bu[i] * P[j][i][2];
        }
        const e = (s2 - row.target[2]) * zScale;
        wsum += row.w; wsq += row.w * e * e;
        usq += e * e; un++;
    }

    const interior = {
        detMin: built.fold.detMin, detMax: built.fold.detMax,
        folded: built.fold.folded, foldFraction: built.fold.foldFraction,
        foldWhere: built.fold.where, orientation: built.fold.orientation,
        samples: built.rows.length, outside: built.outside, solved,
        rms: wsum ? Math.sqrt(wsq / wsum) : 0,
        rmsUnweighted: un ? Math.sqrt(usq / un) : 0,
    };

    const bxy = sides.map((s2) => s2.err.xy * Math.max(W, H));
    const bz = sides.map((s2) => s2.err.z * zScale);

    return {
        patch: P, degree: D, corners, lifted, sides,
        cornerSearch: cs, degreeClamped, harmonic,
        boundary: {
            xyPx: bxy, zGrey: bz,
            xyPxMax: Math.max(...bxy), zGreyMax: Math.max(...bz),
        },
        interior,
    };
}

// ------------------------------------------------------------- rasterising

// Scan-convert the patch into the pixel grid so the warped result can be
// compared against the ORIGINAL heightmap, not just against f. That end-to-end
// number is the one worth quoting.
function rasterizePatch(P, W, H, res) {
    const R = res || Math.max(64, Math.min(400, 2 * Math.max(W, H)));
    const z = new Float64Array(W * H);
    const cov = new Uint8Array(W * H);

    const pts = [];
    for (let j = 0; j < R; j++) {
        const v = j / (R - 1);
        const row = [];
        for (let i = 0; i < R; i++) {
            const s = patchAt(P, i / (R - 1), v);
            row.push([s[0] * (W - 1), s[1] * (H - 1), s[2]]);
        }
        pts.push(row);
    }

    const tri = (a, b, c) => {
        const det = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
        if (Math.abs(det) < 1e-12) return;
        const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0])));
        const x1 = Math.min(W - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
        const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1])));
        const y1 = Math.min(H - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
        for (let y = y0; y <= y1; y++) {
            for (let x = x0; x <= x1; x++) {
                const l1 = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / det;
                const l2 = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / det;
                const l3 = 1 - l1 - l2;
                if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue;
                const idx = y * W + x;
                z[idx] = l1 * a[2] + l2 * b[2] + l3 * c[2];
                cov[idx] = 1;
            }
        }
    };

    for (let j = 0; j + 1 < R; j++) {
        for (let i = 0; i + 1 < R; i++) {
            const p00 = pts[j][i], p01 = pts[j][i + 1];
            const p10 = pts[j + 1][i], p11 = pts[j + 1][i + 1];
            tri(p00, p01, p11);
            tri(p00, p11, p10);
        }
    }
    return { z, cov, res: R };
}

module.exports = {
    MAX_DEGREE, bernAll, curveAt, curveDeriv, patchAt, patchPartials,
    chordParams, solveInterior, correctParams, curveErr, fitSideCurve,
    sideSlice, scoreCorners, chooseCorners, coonsInterior,
    solveInteriorCoord, boundaryPoint, harmonicDomain, foldStats, buildRows,
    warpFit, rasterizePatch,
};
