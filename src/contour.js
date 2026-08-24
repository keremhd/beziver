'use strict';

// Mask extraction and boundary tracing for grayscale heightmaps.

// The repo's data convention: a pixel belongs to the object when it is
// neither pure black nor pure white -- those two values mark background.
// `tol` widens that (tol=2 treats 0..2 and 253..255 as background).
//
// Falls back to the whole rectangle when that rule finds almost nothing,
// so a heightmap that genuinely uses the full 0..255 range still fits.
function buildMask(gray, W, H, opts) {
    opts = opts || {};
    const rule = opts.rule || 'interior';
    const tol = opts.tol === undefined ? 0 : opts.tol;
    const mask = new Uint8Array(W * H);

    if (rule === 'all') {
        mask.fill(1);
        return { mask, count: W * H, rule: 'all' };
    }

    let count = 0;
    for (let i = 0; i < W * H; i++) {
        const v = gray[i];
        if (v > tol && v < 255 - tol) { mask[i] = 1; count++; }
    }

    if (count < 0.005 * W * H) {
        mask.fill(1);
        return { mask, count: W * H, rule: 'all (interior rule found too little)' };
    }
    return { mask, count, rule: 'interior' };
}

// Up-weight a band just inside the mask boundary. The contour lift in stage 2
// samples the surface exactly there, which is where a least-squares fit is
// otherwise least constrained.
function buildWeights(mask, W, H, opts) {
    opts = opts || {};
    const band = opts.band === undefined ? 3 : opts.band;
    const edgeWeight = opts.edgeWeight === undefined ? 1 : opts.edgeWeight;

    const w = new Float64Array(W * H);
    w.fill(1);
    if (band <= 0 || edgeWeight === 1) return w;

    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const idx = y * W + x;
            if (!mask[idx]) continue;
            let nearEdge = false;
            for (let dy = -band; dy <= band && !nearEdge; dy++) {
                const yy = y + dy;
                for (let dx = -band; dx <= band; dx++) {
                    const xx = x + dx;
                    if (xx < 0 || xx >= W || yy < 0 || yy >= H || !mask[yy * W + xx]) {
                        nearEdge = true;
                        break;
                    }
                }
            }
            if (nearEdge) w[idx] = edgeWeight;
        }
    }
    return w;
}

// Moore-neighbour boundary tracing with Jacob's stopping criterion.
// Returns the outer boundary of the connected component containing the first
// foreground pixel, as an ordered closed loop of [x,y].
//
// This replaces sorting boundary pixels by their angle around the centroid,
// which only produces a valid ordering for star-shaped regions.
const DIRS = [
    [1, 0], [1, 1], [0, 1], [-1, 1],
    [-1, 0], [-1, -1], [0, -1], [1, -1],
];

function traceContour(mask, W, H) {
    const at = (x, y) => (x < 0 || x >= W || y < 0 || y >= H) ? 0 : mask[y * W + x];

    let sx = -1, sy = -1;
    for (let y = 0; y < H && sx < 0; y++) {
        for (let x = 0; x < W; x++) {
            if (mask[y * W + x]) { sx = x; sy = y; break; }
        }
    }
    if (sx < 0) return [];

    const contour = [[sx, sy]];
    // Scanning row-major means the pixel to the west is background, so that
    // is where we "came from".
    let backtrack = 4;
    let cx = sx, cy = sy;
    let second = null;
    const limit = 8 * W * H;

    const nextFrom = (px, py, back) => {
        for (let k = 1; k <= 8; k++) {
            const d = (back + k) % 8;
            if (at(px + DIRS[d][0], py + DIRS[d][1])) return d;
        }
        return -1;
    };

    for (let step = 0; step < limit; step++) {
        const found = nextFrom(cx, cy, backtrack);
        if (found < 0) break; // isolated pixel

        cx += DIRS[found][0];
        cy += DIRS[found][1];
        backtrack = (found + 4) % 8;

        if (second === null) {
            second = [cx, cy];
            contour.push([cx, cy]);
            continue;
        }

        // Jacob's stopping criterion: the loop is closed once we are back on
        // the start pixel AND would leave it along the same edge as the first
        // time. Comparing positions alone would truncate shapes whose trace
        // legitimately passes through the start pixel more than once.
        if (cx === sx && cy === sy) {
            const peek = nextFrom(cx, cy, backtrack);
            if (peek < 0) break;
            if (cx + DIRS[peek][0] === second[0] && cy + DIRS[peek][1] === second[1]) break;
        }

        contour.push([cx, cy]);
    }

    return contour;
}

// Cumulative chord length along a closed loop, normalised to [0,1].
function arcLengths(contour) {
    const n = contour.length;
    const s = new Float64Array(n);
    let acc = 0;
    for (let i = 1; i < n; i++) {
        const dx = contour[i][0] - contour[i - 1][0];
        const dy = contour[i][1] - contour[i - 1][1];
        acc += Math.hypot(dx, dy);
        s[i] = acc;
    }
    if (acc > 0) for (let i = 0; i < n; i++) s[i] /= acc;
    return s;
}

module.exports = { buildMask, buildWeights, traceContour, arcLengths, DIRS };
