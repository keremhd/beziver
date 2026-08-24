'use strict';

// A sample model, so the page is usable before you happen to have a scan to
// hand. Generated here rather than shipped as an asset: no page weight, and
// every press gives a different one.
//
// A pebble: one icosphere, displaced radially by three octaves of value noise
// plus a few broad dents. ONE smooth closed surface -- there is nothing to
// blend, no seam to get wrong and no interpenetration to hide, which is why it
// is both better looking and shorter than the union of primitives it replaced.
//
// It reads as a scanned stone, which is what this tool is for (HANDOFF 19):
// take a physical object, isolate a region of its surface, fit it. Every part
// of a pebble is a curved flank worth extracting, so the default orientation
// and cut-off do not have to hunt for a good region.
//
// It is emitted as a real binary STL and handed to the same loader an uploaded
// file goes through, so the sample is not a special case anywhere.

// Deterministic, so a pebble can be reproduced from its seed.
function rng(seed) {
    let a = (seed >>> 0) || 1;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// 3D value noise: hash the lattice, smoothstep between. Smooth (C1) because
// the point is a stone's soft lumps, and because a fit to a C0 surface would
// show the creases the primitives version was rejected for.
function hash3(x, y, z, seed) {
    let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^
            Math.imul(z | 0, 0x9e3779b1) ^ Math.imul(seed | 0, 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
    h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
    return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

function noise3(x, y, z, seed) {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const fx = x - xi, fy = y - yi, fz = z - zi;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy),
          sz = fz * fz * (3 - 2 * fz);
    let v = 0;
    for (let k = 0; k < 8; k++) {
        const wx = k & 1 ? sx : 1 - sx;
        const wy = k & 2 ? sy : 1 - sy;
        const wz = k & 4 ? sz : 1 - sz;
        v += wx * wy * wz *
             hash3(xi + (k & 1 ? 1 : 0), yi + (k & 2 ? 1 : 0), zi + (k & 4 ? 1 : 0), seed);
    }
    return 2 * v - 1;
}

// An icosahedron subdivided and re-normalised, NOT a UV sphere: a UV sphere's
// triangles crowd at the poles, so the same noise reads finer there and the
// stone looks like it has a grain running through it.
const PHI = (1 + Math.sqrt(5)) / 2;

function icoBase() {
    const v = [];
    for (const s1 of [-1, 1]) for (const s2 of [-1, 1]) {
        v.push([0, s1, s2 * PHI], [s1, s2 * PHI, 0], [s2 * PHI, 0, s1]);
    }
    const norm = v.map((p) => {
        const l = Math.hypot(p[0], p[1], p[2]);
        return [p[0] / l, p[1] / l, p[2] / l];
    });
    // Faces by proximity: on an icosahedron every vertex has exactly five
    // neighbours at the minimum edge length, so the triangles are the triples
    // that are mutually nearest. Cheaper to find than to tabulate correctly.
    const d2 = (a, b) => (a[0]-b[0])**2 + (a[1]-b[1])**2 + (a[2]-b[2])**2;
    let emin = Infinity;
    for (let i = 0; i < 12; i++) for (let j = i + 1; j < 12; j++) {
        emin = Math.min(emin, d2(norm[i], norm[j]));
    }
    const near = emin * 1.1;
    const faces = [];
    for (let i = 0; i < 12; i++) for (let j = i + 1; j < 12; j++) {
        if (d2(norm[i], norm[j]) > near) continue;
        for (let k = j + 1; k < 12; k++) {
            if (d2(norm[i], norm[k]) > near || d2(norm[j], norm[k]) > near) continue;
            // Outward winding: the proximity search finds each triple in
            // index order, which is inward for about half of them. An STL
            // with mixed winding is only cosmetically wrong here, since the
            // depth render recomputes normals -- but it would be wrong in any
            // other tool the file was opened in.
            const a = norm[i], b = norm[j], c = norm[k];
            const nx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
            const ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
            const nz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
            const out = nx * (a[0] + b[0] + c[0]) + ny * (a[1] + b[1] + c[1]) +
                        nz * (a[2] + b[2] + c[2]);
            faces.push(out >= 0 ? [i, j, k] : [i, k, j]);
        }
    }
    return { verts: norm, faces };
}

// Midpoints are computed from the same two endpoints whichever face asks, so
// adjacent faces produce bit-identical shared vertices and the surface is
// closed without any vertex table.
function unit(a, b) {
    const x = a[0] + b[0], y = a[1] + b[1], z = a[2] + b[2];
    const l = Math.hypot(x, y, z);
    return [x / l, y / l, z / l];
}

function subdivide(tris) {
    const out = [];
    for (const [a, b, c] of tris) {
        const ab = unit(a, b), bc = unit(b, c), ca = unit(c, a);
        out.push([a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]);
    }
    return out;
}

function binarySTL(verts) {
    const n = verts.length / 9;
    const buf = new ArrayBuffer(84 + 50 * n);
    const dv = new DataView(buf);
    dv.setUint32(80, n, true);
    let o = 84;
    for (let i = 0; i < n; i++) {
        o += 12;                       // the stored normal is recomputed on read
        for (let k = 0; k < 9; k++) { dv.setFloat32(o, verts[i * 9 + k], true); o += 4; }
        o += 2;
    }
    return buf;
}

// `cut` is where the sample wants the cut-off parked, as a fraction of the
// model's extent along the capture axis. On a pebble any direction gives a
// curved patch, so this is not aiming at anything -- it just takes a cap big
// enough to be worth fitting and shallow enough to sit well inside the
// silhouette, where the surface is not turning vertical.
const CUT = 0.55;

// Amplitude per octave, and the whole point of the shape.
//
// Spikiness is HIGH-frequency amplitude; interesting form is LOW-frequency
// amplitude, and the two are independent. So the falloff here is far steeper
// than the usual halving: the first octave carries almost all of it and makes
// the lobes, swells and broad hollows, while the third is surface interest
// only and never touches the silhouette. Raising OCT[0] fixes featureless;
// lowering OCT[1..2] fixes spiky. An earlier version had 0.10 / 0.05 / 0.025 --
// smooth, and the owner's verdict was that it had "no surface element to care
// about".
const OCT = [0.30, 0.08, 0.02];

// A few broad dents. This is what makes a stone read as weathered rather than
// as a lumpy ball, and it is what gives the sample a region actually worth
// extracting. Angular size, not lattice size, so they stay smooth however the
// noise is scaled.
const DENTS = 3;

function pebble(seed) {
    if (seed === undefined) seed = (Math.random() * 0x7fffffff) | 0;
    const r = rng(seed);
    const rand = (lo, hi) => lo + (hi - lo) * r();

    const R = rand(22, 34);                      // base radius
    // Stones are rarely round. Mild, and on all three axes so no orientation
    // is special.
    const ax = [rand(0.82, 1), rand(0.78, 1), rand(0.7, 0.92)];
    // About two lattice cells across the diameter at the first octave: broad
    // lobes rather than a rippled ball.
    const freq = rand(0.8, 1.15);
    const spin = [rand(0, 40), rand(0, 40), rand(0, 40)];  // decorrelate octaves

    const dents = [];
    for (let i = 0; i < DENTS; i++) {
        // A uniform direction on the sphere, so no axis is favoured.
        const u = 2 * r() - 1, th = 2 * Math.PI * r(), q = Math.sqrt(1 - u * u);
        dents.push({
            dir: [q * Math.cos(th), q * Math.sin(th), u],
            depth: rand(0.05, 0.12),
            width: rand(0.07, 0.18),
        });
    }

    const ico = icoBase();
    let tris = ico.faces.map((f) => f.map((i) => ico.verts[i]));
    // Level 4: 5120 triangles. Level 3 was enough for a nearly round ball, but
    // dips this deep show their facets on the SILHOUETTE at that density. This
    // is also as far as it can go -- the left preview rasterises the whole mesh
    // on every drag frame, and the cost is per triangle.
    for (let k = 0; k < 4; k++) tris = subdivide(tris);

    const displace = (p) => {
        let n = OCT[0] * noise3(p[0] * freq + spin[0], p[1] * freq + spin[0],
                                p[2] * freq + spin[0], seed)
              + OCT[1] * noise3(p[0] * freq * 2.6 + spin[1], p[1] * freq * 2.6 + spin[1],
                                p[2] * freq * 2.6 + spin[1], seed + 1)
              + OCT[2] * noise3(p[0] * freq * 5.4 + spin[2], p[1] * freq * 5.4 + spin[2],
                                p[2] * freq * 5.4 + spin[2], seed + 2);
        for (const d of dents) {
            const c = p[0] * d.dir[0] + p[1] * d.dir[1] + p[2] * d.dir[2];
            n -= d.depth * Math.exp(-(1 - c) / d.width);
        }
        const rad = R * (1 + n);
        return [p[0] * rad * ax[0], p[1] * rad * ax[1], p[2] * rad * ax[2]];
    };

    const out = [];
    for (const t of tris) {
        for (const p of t) { const q = displace(p); out.push(q[0], q[1], q[2]); }
    }

    return {
        seed,
        buffer: binarySTL(out),
        triangles: out.length / 9,
        name: 'sample-pebble.stl',
        cut: CUT,
    };
}

module.exports = { pebble, rng, noise3 };
