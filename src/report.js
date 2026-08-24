'use strict';

const { evalAt, toBezierPatches, evalBezierPatch } = require('./fit.js');

// Error statistics over the fitted region. `scale` converts normalised height
// back into the caller's units: 255 for an 8-bit image (grey levels), or the
// above-water span in model units for an STL depth map.
function stats(dataZ, fitZ, mask, W, H, scale) {
    if (scale === undefined) scale = 255;
    const errs = [];
    let sum = 0, sumSq = 0, maxAbs = 0;
    let extMin = Infinity, extMax = -Infinity;

    for (let i = 0; i < W * H; i++) {
        if (mask && !mask[i]) {
            extMin = Math.min(extMin, fitZ[i]);
            extMax = Math.max(extMax, fitZ[i]);
            continue;
        }
        const e = (fitZ[i] - dataZ[i]) * scale;
        errs.push(Math.abs(e));
        sum += e;
        sumSq += e * e;
        maxAbs = Math.max(maxAbs, Math.abs(e));
    }
    const n = errs.length;
    errs.sort((a, b) => a - b);

    return {
        n,
        rms: n ? Math.sqrt(sumSq / n) : 0,
        bias: n ? sum / n : 0,
        mae: n ? errs.reduce((a, b) => a + b, 0) / n : 0,
        p95: n ? errs[Math.min(n - 1, Math.floor(0.95 * n))] : 0,
        max: maxAbs,
        extrapMin: extMin === Infinity ? null : extMin,
        extrapMax: extMax === -Infinity ? null : extMax,
    };
}

// Lift the traced contour onto the fitted surface: the space curve where a
// vertical prism through the outline meets z = f(x,y). This is the trim edge,
// and in stage 2 it becomes the patch boundary -- so its accuracy here is the
// thing that decides whether the warp is worth attempting.
function liftContour(fit, contour, dataZ, W, H, scale) {
    if (scale === undefined) scale = 255;
    const zFit = new Float64Array(contour.length);
    const zData = new Float64Array(contour.length);
    let sumSq = 0, maxAbs = 0;

    for (let i = 0; i < contour.length; i++) {
        const x = contour[i][0], y = contour[i][1];
        const u = W === 1 ? 0 : x / (W - 1);
        const v = H === 1 ? 0 : y / (H - 1);
        const f = evalAt(fit, u, v);
        const d = dataZ[y * W + x];
        zFit[i] = f;
        zData[i] = d;
        const e = (f - d) * scale;
        sumSq += e * e;
        maxAbs = Math.max(maxAbs, Math.abs(e));
    }
    const n = contour.length;
    return { zFit, zData, rms: n ? Math.sqrt(sumSq / n) : 0, max: maxAbs };
}

// An error magnitude, formatted for a person. Fixed decimal places are wrong
// for a quantity that legitimately ranges over four orders of magnitude: at
// 0.003 mm, `toFixed(3)` spends three characters to say "3", and every
// variation below it is invisible. Significant figures instead, with the unit
// stepping down to micrometres before the digits run out.
//
// Everything that prints an error goes through here -- the reports, the pane
// readouts and the colour bar -- so no two of them can disagree about the same
// number.
function sig3(x) {
    const s = x.toPrecision(3);
    return s.includes('e') ? x.toExponential(2) : String(parseFloat(s));
}

function fmtErr(v, unit) {
    if (!Number.isFinite(v)) return '-';
    if (unit === undefined) unit = 'mm';
    const a = Math.abs(v);
    if (a === 0) return '0 ' + unit;
    // Only mm has a smaller sibling worth switching to.
    if (unit === 'mm' && a < 0.1) return sig3(v * 1000) + ' \u00b5m';
    return sig3(v) + ' ' + unit;
}

// ------------------------------------------------------------- scad output

function round2(v) { return Math.round(v * 100) / 100; }

function fmt(v) {
    if (!Number.isFinite(v)) return '0';
    if (Math.abs(v) < 5e-7) return '0';
    return v.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

// What the emitted surface is like where it matters for a vertical shell.
// Sampled on the patch grid, in the physical frame the `size` line sets up.
//
// `slope` is the steepest dz/d(horizontal). It matters because the shell is a
// VERTICAL offset: nominal thickness t measures t*cos(theta) perpendicular to
// a surface tilted by theta, so the steepest place is the thinnest wall.
//
// `foldFraction` is the part of the surface where the (u,v) -> (x,y) map
// reverses. That is the one thing that can break the offset's guarantee. Two
// graphs of z = f(x,y) a constant apart in z cannot meet -- but only where the
// surface IS a graph. Stage 1 always is: its control net's x,y are pinned to a
// uniform grid, so Bernstein linear precision makes x = u and y = v exactly.
// Stage 2 reparameterises onto the traced outline and CAN fold on a concave
// one, and where it folds the sheet lies over itself in x,y, so the offset
// copy can cut through it. The mesh stays edge-manifold either way -- every
// edge still has exactly two faces -- so this is invisible to the manifold
// check. It is not something to warn a user about at runtime -- they could
// neither verify nor act on it. app.js falls back to the rectangular fit
// instead, silently, whenever the warp's map reverses in its interior; this
// function is here so the emitted geometry can be asserted fold-free in
// verify:scad, where a failure has somewhere to go.
//
// Orientation-agnostic, per warp.js foldStats: the sign of the summed
// determinant is "forward", and reversals are counted against it. A hardcoded
// det <= 0 calls every mirrored map folded.
//
// The patch map is (u,v) -> (x,y,z); z as a function of x,y needs the chain
// rule through that same 2x2 Jacobian.
// How far inside the parameter square a reversal has to be before it counts
// as the surface doubling back rather than the rim overhanging itself.
// Measured, as the self-intersecting share of the emitted shell's footprint:
//
//   shape                     reversals >15% in    self-intersecting footprint
//   14 procedural sample pebbles      0                 0.00% .. 0.05%
//   peanut                            0                 0.54%
//   clover                            0                 1.15%
//   crescent                        119                 9.42%
//   C ring                          194                13.29%
//
// Below the band, every fold sits in a thin ring at the edge and costs about a
// percent of the footprint. Above it, the surface crosses itself through the
// middle and the figure jumps by an order of magnitude. Nothing lands between.
// A stricter rule that counted rim folds too would refuse every smooth blob,
// which is the shape this tool exists for.
const DEEP_BAND = 0.15;

function surfaceStats(patches, sizeX, sizeY, height) {
    // Per patch, so the total sample count is roughly constant: a single
    // high-degree patch gets a fine scan, a 17x17 grid of cubics a coarse one.
    // This runs on every emit, which is every pipeline run.
    const perSide = Math.max(1, Math.round(Math.sqrt(patches.length)));
    const n = Math.max(4, Math.min(24, Math.ceil(24 / perSide) * 2));
    const h = 1e-4;
    // A fold in the outermost band of the parameter square is a rim effect:
    // the boundary curve overshoots slightly and the sheet overhangs its own
    // edge by a hair. A fold further in is the surface doubling back through
    // the middle of the model. They are not the same failure, and only the
    // second one is worth refusing to ship -- see DEEP_BAND.
    const deep = [];
    const dets = [];
    const grads = [];
    for (const p of patches) {
        for (let i = 0; i <= n; i++) {
            for (let j = 0; j <= n; j++) {
                const u = Math.min(1 - h, i / n), v = Math.min(1 - h, j / n);
                const c = evalBezierPatch(p, u, v);
                const a = evalBezierPatch(p, u + h, v);
                const b = evalBezierPatch(p, u, v + h);
                const xu = (a[0] - c[0]) * sizeX, yu = (a[1] - c[1]) * sizeY;
                const xv = (b[0] - c[0]) * sizeX, yv = (b[1] - c[1]) * sizeY;
                const zu = (a[2] - c[2]) * height, zv = (b[2] - c[2]) * height;
                const det = xu * yv - xv * yu;
                if (!Number.isFinite(det)) continue;
                dets.push(det);
                deep.push(Math.min(u, 1 - u, v, 1 - v) > DEEP_BAND);
                if (Math.abs(det) < 1e-12) continue;
                const zx = (zu * yv - zv * yu) / det;
                const zy = (zv * xu - zu * xv) / det;
                const g = Math.hypot(zx, zy);
                grads.push(Number.isFinite(g) ? g : 0);
            }
        }
    }
    let sum = 0;
    for (const d of dets) sum += d;
    const sgn = sum >= 0 ? 1 : -1;
    let folded = 0, deepFolded = 0;
    for (let i = 0; i < dets.length; i++) {
        if (dets[i] * sgn > 0) continue;
        folded++;
        if (deep[i]) deepFolded++;
    }
    return {
        slope: grads.length ? Math.max(...grads) : 0,
        samples: dets.length,
        folded,
        deepFolded,
        foldFraction: dets.length ? folded / dets.length : 0,
    };
}

// Emit OpenSCAD. Kept deliberately short: this is a file a person pastes into
// an editor, not documentation. One line per patch, so the file length tracks
// the amount of surface detail asked for and nothing else.
//
// The output is a CLOSED SOLID, not a sheet. Both stages produce a
// topologically rectangular grid of patches, so the surface is a quad mesh
// with exactly four boundary edges: sample it into one seamless point mesh,
// copy that mesh straight down by `thickness`, and skirt the two together
// around the border. A constant-thickness shell that follows the fit on BOTH
// faces -- which is what you want when the thing being mapped is concave and
// the useful side is the underside.
//
// The offset is in Z, deliberately, NOT along the surface normal. Two graphs
// of z = f(x,y) separated by a constant in z cannot meet, for any t > 0 at any
// curvature, so the solid is manifold and positive-volume with no special
// cases and its volume is exactly t * (footprint area). A true normal offset
// self-intersects wherever the radius of curvature drops below t -- precisely
// in the concave regions this is for -- and removing those self-intersections
// is exactly the thinking the user is not supposed to have to do. The honest
// cost is that the wall measures t*cos(theta) perpendicular to a slope; the
// emitted thickness line carries that number rather than leaving it to be
// discovered on the printer.
//
// Every join is at VNF level (vnf_vertex_array + vnf_join). It is NOT CSG. A
// Bezier patch grid is an OPEN sheet, and CGAL cannot intersect or union an
// open surface with a solid: it renders and exports nothing, silently.
function patchesToScad(patches, opts) {
    opts = opts || {};
    const sizeX = opts.sizeX || 100;
    const sizeY = opts.sizeY || 100;
    const height = opts.height || 20;

    // splinesteps is PER PATCH, so a fit split into many patches is finely
    // tessellated at a low value while a single patch of the same value is
    // coarse. Pick it from the patch grid for a comparable mesh either way.
    const perSide = Math.max(1, Math.round(Math.sqrt(patches.length)));
    const splinesteps = opts.splinesteps ||
        Math.max(6, Math.min(64, Math.ceil(64 / perSide)));

    // The patch list is row-major over the patch grid (toBezierPatches walks
    // y-blocks outer, x-blocks inner), and the solid construction needs that
    // layout to stitch the tiles into one mesh. Tiles in the same row share
    // the y of their first control point, so it is recoverable from the data
    // and no caller has to remember to pass it. A single patch gives 1x1.
    const rowKey = (p) => fmt(p[0][0][1]);
    let pcols = 0;
    while (pcols < patches.length && rowKey(patches[pcols]) === rowKey(patches[0])) pcols++;
    pcols = Math.max(1, pcols);
    const prows = Math.max(1, Math.round(patches.length / pcols));

    // Thick enough to survive a printer, scaled to the model so it is sensible
    // at any size, and never zero -- a zero-thickness shell has no interior.
    const thickness = opts.thickness !== undefined ? opts.thickness
        : Math.max(1, Math.round(height * 0.1 * 10) / 10);
    const surf = surfaceStats(patches, sizeX, sizeY, height);
    const thinnest = thickness / Math.hypot(1, surf.slope);
    // Two perimeters at a 0.4 mm nozzle is the usual floor for a wall that
    // survives handling. Below it the line says so, on the same line, so the
    // file's shape never changes -- it is a warning, not a decision: the
    // default still prints.
    const note = thinnest < 0.8
        ? `only ${fmt(round2(thinnest))} mm at the steepest slope - raise this`
        : `${fmt(round2(thinnest))} mm at the steepest slope`;

    const body = patches.map((p) =>
        '  [' + p.map((row) =>
            '[' + row.map((q) => `[${fmt(q[0])},${fmt(q[1])},${fmt(q[2])}]`).join(',') + ']'
        ).join(',') + ']'
    ).join(',\n');

    const what = opts.warped
        ? 'its edge follows the traced outline'
        : 'it covers the bounding box';

    return `// beziver: ${patches.length} Bezier patch${patches.length === 1 ? '' : 'es'}, ${what}.
// A closed, printable solid. Paste it in and press F5.
include <BOSL2/std.scad>
include <BOSL2/beziers.scad>

size = [${fmt(sizeX)}, ${fmt(sizeY)}, ${fmt(height)}];  // width, depth, height
thickness = ${fmt(thickness)};   // shell, straight down (${note})
splinesteps = ${splinesteps};      // mesh subdivisions per patch
show_control_net = false;

patch_grid = [${prows}, ${pcols}];    // patches down, patches across
patches = [
${body}
];

surface = [for (p = patches) [for (r = p) [for (q = r) v_mul(q, size)]]];

// Sample the patch grid into one seamless mesh, copy it straight down by
// thickness, and skirt the two together. Both faces follow the fit. Every
// join is at mesh level: an open sheet cannot be intersected or unioned.
function _i(k, n) = [for (i = [k:1:n]) i];
function _rim(g) = let(r = len(g) - 1, c = len(g[0]) - 1) concat(g[0],
    [for (i = [1:r]) g[i][c]], [for (j = [c - 1:-1:0]) g[r][j]],
    [for (i = [r - 1:-1:1]) g[i][0]]);
tile = [for (p = surface) bezier_patch_points(p, _i(0, splinesteps) / splinesteps,
                                                 _i(0, splinesteps) / splinesteps)];
top = [for (a = [0:patch_grid[0] - 1], i = _i(a ? 1 : 0, splinesteps))
       [for (b = [0:patch_grid[1] - 1], j = _i(b ? 1 : 0, splinesteps))
        tile[a * patch_grid[1] + b][i][j]]];
bot = [for (r = top) [for (p = r) p - [0, 0, thickness]]];

vnf_polyhedron(vnf_join([vnf_vertex_array(top, reverse = true),
    vnf_vertex_array(bot),
    vnf_vertex_array([_rim(top), _rim(bot)], col_wrap = true)]), convexity = 8);
if (show_control_net)
    debug_bezier_patches(patches = surface, size = max(size) * 0.008,
                         splinesteps = splinesteps, showcps = true, showpatch = false);
`;
}

function fitToScad(fit, opts) {
    return patchesToScad(toBezierPatches(fit), opts);
}

module.exports = {
    stats, liftContour, patchesToScad, fitToScad, fmt, fmtErr, surfaceStats,
};
