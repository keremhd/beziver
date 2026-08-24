'use strict';

// Analytic least-squares fitting of a height field with a tensor-product
// polynomial surface.
//
// The surface is a graph z = f(u,v) over the unit square. With the control
// net's x,y pinned to a uniform grid, the Bernstein basis' linear precision
// property (sum_i (i/m) B_i^m(u) = u) makes the parametric map the identity,
// so fitting is LINEAR in the control heights and has a closed-form global
// optimum. No search, no iteration.

// ---------------------------------------------------------------- bases

function binom(n, k) {
    let r = 1;
    for (let i = 0; i < k; i++) r = r * (n - i) / (i + 1);
    return r;
}

// N control points => Bernstein degree N-1. Every basis function is nonzero
// everywhere, so `support` is N.
function bernsteinBasis(N) {
    if (N < 2) throw new Error('bernstein basis needs >= 2 control points');
    const m = N - 1;
    const C = [];
    for (let i = 0; i <= m; i++) C.push(binom(m, i));

    return {
        kind: 'bernstein', n: N, degree: m, support: N, breaks: [0, 1],
        evalAt(t) {
            if (t < 0) t = 0;
            if (t > 1) t = 1;
            const vals = new Array(N);
            for (let i = 0; i <= m; i++) {
                vals[i] = C[i] * Math.pow(t, i) * Math.pow(1 - t, m - i);
            }
            return { first: 0, vals };
        },
    };
}

// Clamped uniform cubic B-spline over [0,1] with N control points.
// N-3 nonempty knot spans; C2 continuous across them; only 4 basis
// functions are nonzero at any parameter.
function bsplineBasis(N) {
    if (N < 4) throw new Error('cubic B-spline basis needs >= 4 control points');
    const p = 3;
    const ns = N - 3;

    const U = new Array(N + 4).fill(0);
    for (let k = 0; k < N - 4; k++) U[4 + k] = (k + 1) / ns;
    for (let i = N; i < N + 4; i++) U[i] = 1;

    const breaks = [];
    for (let k = 0; k <= ns; k++) breaks.push(k / ns);

    return {
        kind: 'bspline', n: N, degree: p, support: 4, breaks, knots: U,
        evalAt(t) {
            if (t < 0) t = 0;
            if (t > 1) t = 1;

            let s = Math.floor(t * ns);
            if (s > ns - 1) s = ns - 1;
            if (s < 0) s = 0;
            const i = s + p;

            // Cox-de Boor (Piegl & Tiller A2.2)
            const Nb = [1, 0, 0, 0];
            const left = [0, 0, 0, 0];
            const right = [0, 0, 0, 0];
            for (let j = 1; j <= p; j++) {
                left[j] = t - U[i + 1 - j];
                right[j] = U[i + j] - t;
                let saved = 0;
                for (let r = 0; r < j; r++) {
                    const den = right[r + 1] + left[j - r];
                    const temp = den === 0 ? 0 : Nb[r] / den;
                    Nb[r] = saved + right[r + 1] * temp;
                    saved = left[j - r] * temp;
                }
                Nb[j] = saved;
            }
            return { first: i - p, vals: Nb.slice() };
        },
    };
}

function makeBasis(kind, N) {
    return kind === 'bspline' ? bsplineBasis(N) : bernsteinBasis(N);
}

// ---------------------------------------------------------------- solver

// In-place Cholesky (LLT) of a full symmetric row-major matrix, then solve.
// Returns null if not positive definite.
function cholSolve(A, rhs, P) {
    const L = Float64Array.from(A);
    for (let i = 0; i < P; i++) {
        for (let j = 0; j <= i; j++) {
            let sum = L[i * P + j];
            for (let k = 0; k < j; k++) sum -= L[i * P + k] * L[j * P + k];
            if (i === j) {
                if (sum <= 0) return null;
                L[i * P + j] = Math.sqrt(sum);
            } else {
                L[i * P + j] = sum / L[j * P + j];
            }
        }
        for (let j = i + 1; j < P; j++) L[i * P + j] = 0;
    }

    const y = new Float64Array(P);
    for (let i = 0; i < P; i++) {
        let sum = rhs[i];
        for (let k = 0; k < i; k++) sum -= L[i * P + k] * y[k];
        y[i] = sum / L[i * P + i];
    }
    const x = new Float64Array(P);
    for (let i = P - 1; i >= 0; i--) {
        let sum = y[i];
        for (let k = i + 1; k < P; k++) sum -= L[k * P + i] * x[k];
        x[i] = sum / L[i * P + i];
    }
    return x;
}

// Small dense inverse via Gauss-Jordan with partial pivoting.
function invert(A, n) {
    const M = Float64Array.from(A);
    const I = new Float64Array(n * n);
    for (let i = 0; i < n; i++) I[i * n + i] = 1;

    for (let c = 0; c < n; c++) {
        let piv = c;
        for (let r = c + 1; r < n; r++) {
            if (Math.abs(M[r * n + c]) > Math.abs(M[piv * n + c])) piv = r;
        }
        if (Math.abs(M[piv * n + c]) < 1e-14) throw new Error('singular matrix');
        if (piv !== c) {
            for (let k = 0; k < n; k++) {
                let t = M[c * n + k]; M[c * n + k] = M[piv * n + k]; M[piv * n + k] = t;
                t = I[c * n + k]; I[c * n + k] = I[piv * n + k]; I[piv * n + k] = t;
            }
        }
        const d = M[c * n + c];
        for (let k = 0; k < n; k++) { M[c * n + k] /= d; I[c * n + k] /= d; }
        for (let r = 0; r < n; r++) {
            if (r === c) continue;
            const f = M[r * n + c];
            if (f === 0) continue;
            for (let k = 0; k < n; k++) {
                M[r * n + k] -= f * M[c * n + k];
                I[r * n + k] -= f * I[c * n + k];
            }
        }
    }
    return I;
}

// ---------------------------------------------------------------- the fit

// data  : Float64Array(W*H), heights normalised to roughly [0,1]
// mask  : Uint8Array(W*H) or null, 1 = include this pixel in the fit
// weight: Float64Array(W*H) or null, per-pixel least-squares weight
//
// lambda scales a second-difference (curvature) penalty on the control net.
// Its null space is the affine functions, so spans with no data underneath
// extrapolate linearly instead of blowing up -- and the normal equations
// stay non-singular even when a whole span falls outside the mask.
function fitHeightField(data, W, H, opts) {
    opts = opts || {};
    const kind = opts.basis || 'bspline';
    const bx = opts.basisX || makeBasis(kind, opts.nx || 8);
    const by = opts.basisY || makeBasis(kind, opts.ny || opts.nx || 8);
    const mask = opts.mask || null;
    const weight = opts.weight || null;
    const lambda = opts.lambda === undefined ? 1e-4 : opts.lambda;

    const Nx = bx.n, Ny = by.n, P = Nx * Ny;
    if (P > 4096) throw new Error('control net too large: ' + P + ' unknowns');

    // Basis rows depend only on the pixel column/row, so evaluate them once.
    const bxs = new Array(W), bys = new Array(H);
    for (let x = 0; x < W; x++) bxs[x] = bx.evalAt(W === 1 ? 0 : x / (W - 1));
    for (let y = 0; y < H; y++) bys[y] = by.evalAt(H === 1 ? 0 : y / (H - 1));

    const G = new Float64Array(P * P);
    const b = new Float64Array(P);

    const cap = bx.support * by.support;
    const idxBuf = new Int32Array(cap);
    const valBuf = new Float64Array(cap);

    let sumW = 0, nUsed = 0;

    for (let y = 0; y < H; y++) {
        const cy = bys[y];
        for (let x = 0; x < W; x++) {
            const idx = y * W + x;
            if (mask && !mask[idx]) continue;
            const w = weight ? weight[idx] : 1;
            if (w <= 0) continue;
            sumW += w;
            nUsed++;

            const ax = bxs[x];
            // Indices come out strictly increasing, which lets us fill only
            // the upper triangle below.
            let n = 0;
            for (let jj = 0; jj < cy.vals.length; jj++) {
                const cv = cy.vals[jj];
                const row = (cy.first + jj) * Nx + ax.first;
                for (let ii = 0; ii < ax.vals.length; ii++) {
                    idxBuf[n] = row + ii;
                    valBuf[n] = cv * ax.vals[ii];
                    n++;
                }
            }

            const z = data[idx];
            for (let a = 0; a < n; a++) {
                const pa = idxBuf[a];
                const va = valBuf[a] * w;
                b[pa] += va * z;
                const base = pa * P;
                for (let c = a; c < n; c++) G[base + idxBuf[c]] += va * valBuf[c];
            }
        }
    }

    if (nUsed === 0) throw new Error('mask selected no pixels');

    // Normalise the data term so lambda is a dimensionless ratio.
    const inv = 1 / sumW;
    for (let i = 0; i < P * P; i++) G[i] *= inv;
    for (let i = 0; i < P; i++) b[i] *= inv;

    // Second-difference penalty, [1,-2,1] along each axis of the control net.
    const nSten = Ny * Math.max(0, Nx - 2) + Nx * Math.max(0, Ny - 2);
    if (lambda > 0 && nSten > 0) {
        const s = lambda / nSten;
        const co = [1, -2, 1];
        const add = (p) => {
            for (let a = 0; a < 3; a++) {
                for (let c = a; c < 3; c++) G[p[a] * P + p[c]] += s * co[a] * co[c];
            }
        };
        for (let j = 0; j < Ny; j++) {
            for (let i = 0; i + 2 < Nx; i++) {
                add([j * Nx + i, j * Nx + i + 1, j * Nx + i + 2]);
            }
        }
        for (let i = 0; i < Nx; i++) {
            for (let j = 0; j + 2 < Ny; j++) {
                add([j * Nx + i, (j + 1) * Nx + i, (j + 2) * Nx + i]);
            }
        }
    }

    // Mirror upper triangle into lower.
    for (let i = 0; i < P; i++) {
        for (let j = i + 1; j < P; j++) G[j * P + i] = G[i * P + j];
    }

    let trace = 0;
    for (let i = 0; i < P; i++) trace += G[i * P + i];
    const jitter = (trace / P) * 1e-12 + 1e-300;

    let Z = null;
    for (let attempt = 0; attempt < 6 && !Z; attempt++) {
        const bump = jitter * Math.pow(100, attempt);
        for (let i = 0; i < P; i++) G[i * P + i] += bump;
        Z = cholSolve(G, b, P);
    }
    if (!Z) throw new Error('normal equations not solvable');

    return { bx, by, Nx, Ny, Z, nUsed, sumW };
}

// ---------------------------------------------------------------- evaluate

function evalAt(fit, u, v) {
    const ax = fit.bx.evalAt(u);
    const cy = fit.by.evalAt(v);
    let z = 0;
    for (let jj = 0; jj < cy.vals.length; jj++) {
        const row = (cy.first + jj) * fit.Nx + ax.first;
        const cv = cy.vals[jj];
        if (cv === 0) continue;
        for (let ii = 0; ii < ax.vals.length; ii++) {
            z += cv * ax.vals[ii] * fit.Z[row + ii];
        }
    }
    return z;
}

function evalGrid(fit, W, H) {
    const out = new Float64Array(W * H);
    const bxs = new Array(W), bys = new Array(H);
    for (let x = 0; x < W; x++) bxs[x] = fit.bx.evalAt(W === 1 ? 0 : x / (W - 1));
    for (let y = 0; y < H; y++) bys[y] = fit.by.evalAt(H === 1 ? 0 : y / (H - 1));

    for (let y = 0; y < H; y++) {
        const cy = bys[y];
        for (let x = 0; x < W; x++) {
            const ax = bxs[x];
            let z = 0;
            for (let jj = 0; jj < cy.vals.length; jj++) {
                const row = (cy.first + jj) * fit.Nx + ax.first;
                const cv = cy.vals[jj];
                for (let ii = 0; ii < ax.vals.length; ii++) {
                    z += cv * ax.vals[ii] * fit.Z[row + ii];
                }
            }
            out[y * W + x] = z;
        }
    }
    return out;
}

// ------------------------------------------------------- Bezier extraction

let BERN3_INV = null;
function bern3Inv() {
    if (BERN3_INV) return BERN3_INV;
    const M = new Float64Array(16);
    for (let k = 0; k < 4; k++) {
        const t = k / 3, T = 1 - t;
        M[k * 4 + 0] = T * T * T;
        M[k * 4 + 1] = 3 * t * T * T;
        M[k * 4 + 2] = 3 * t * t * T;
        M[k * 4 + 3] = t * t * t;
    }
    BERN3_INV = invert(M, 4);
    return BERN3_INV;
}

// Convert the fit into a list of Bezier patches in BOSL2 order.
//
// Bernstein fits are already a single Bezier patch: the control heights ARE
// the answer and the x,y net is the uniform grid (linear precision).
//
// B-spline fits are piecewise cubic, so each knot-span box restricts to an
// exact bicubic. Sampling it on a 4x4 parameter grid and applying the inverse
// cubic Bernstein matrix on both sides recovers that patch's control points
// exactly -- no knot insertion needed. Adjacent patches inherit the B-spline's
// C2 continuity.
function toBezierPatches(fit) {
    const patches = [];

    if (fit.bx.kind === 'bernstein' && fit.by.kind === 'bernstein') {
        const rows = [];
        for (let j = 0; j < fit.Ny; j++) {
            const row = [];
            for (let i = 0; i < fit.Nx; i++) {
                row.push([i / (fit.Nx - 1), j / (fit.Ny - 1), fit.Z[j * fit.Nx + i]]);
            }
            rows.push(row);
        }
        patches.push(rows);
        return patches;
    }

    const Bi = bern3Inv();
    const ub = fit.bx.breaks, vb = fit.by.breaks;

    for (let sy = 0; sy + 1 < vb.length; sy++) {
        for (let sx = 0; sx + 1 < ub.length; sx++) {
            const u0 = ub[sx], u1 = ub[sx + 1];
            const v0 = vb[sy], v1 = vb[sy + 1];

            const S = new Float64Array(16);
            for (let a = 0; a < 4; a++) {
                const v = v0 + (a / 3) * (v1 - v0);
                for (let bb = 0; bb < 4; bb++) {
                    const u = u0 + (bb / 3) * (u1 - u0);
                    S[a * 4 + bb] = evalAt(fit, u, v);
                }
            }
            // C = Bi * S * Bi^T
            const T = new Float64Array(16);
            for (let a = 0; a < 4; a++) {
                for (let c = 0; c < 4; c++) {
                    let s = 0;
                    for (let k = 0; k < 4; k++) s += Bi[a * 4 + k] * S[k * 4 + c];
                    T[a * 4 + c] = s;
                }
            }
            const C = new Float64Array(16);
            for (let a = 0; a < 4; a++) {
                for (let c = 0; c < 4; c++) {
                    let s = 0;
                    for (let k = 0; k < 4; k++) s += T[a * 4 + k] * Bi[c * 4 + k];
                    C[a * 4 + c] = s;
                }
            }

            const rows = [];
            for (let a = 0; a < 4; a++) {
                const row = [];
                for (let bb = 0; bb < 4; bb++) {
                    row.push([
                        u0 + (bb / 3) * (u1 - u0),
                        v0 + (a / 3) * (v1 - v0),
                        C[a * 4 + bb],
                    ]);
                }
                rows.push(row);
            }
            patches.push(rows);
        }
    }
    return patches;
}

function evalBezierPatch(patch, u, v) {
    const n = patch[0].length - 1, m = patch.length - 1;
    const bu = [], bv = [];
    for (let i = 0; i <= n; i++) bu.push(binom(n, i) * Math.pow(u, i) * Math.pow(1 - u, n - i));
    for (let j = 0; j <= m; j++) bv.push(binom(m, j) * Math.pow(v, j) * Math.pow(1 - v, m - j));
    const out = [0, 0, 0];
    for (let j = 0; j <= m; j++) {
        for (let i = 0; i <= n; i++) {
            const w = bv[j] * bu[i];
            for (let k = 0; k < 3; k++) out[k] += w * patch[j][i][k];
        }
    }
    return out;
}

module.exports = {
    binom, bernsteinBasis, bsplineBasis, makeBasis,
    cholSolve, invert,
    fitHeightField, evalAt, evalGrid,
    toBezierPatches, evalBezierPatch,
};
