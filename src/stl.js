'use strict';

// STL input: parse, orbit, and render an orthographic depth map.
//
// The depth buffer IS the height field -- there is no 8-bit image anywhere on
// this path, so heights stay full-precision floats in model units rather than
// being quantised to 0..255. A water level is just a threshold on that buffer:
// everything above it is the surface to fit, everything below is background.

function parseSTL(buffer) {
    const bytes = new Uint8Array(buffer);

    // A binary STL is exactly 84 + 50*count bytes. That size check is the only
    // reliable discriminator -- binary files may also begin with "solid".
    if (buffer.byteLength >= 84) {
        const dv = new DataView(buffer);
        const count = dv.getUint32(80, true);
        if (84 + count * 50 === buffer.byteLength) {
            const verts = new Float32Array(count * 9);
            let o = 84;
            for (let t = 0; t < count; t++) {
                o += 12; // skip the stored normal; we recompute for shading
                for (let k = 0; k < 9; k++) { verts[t * 9 + k] = dv.getFloat32(o, true); o += 4; }
                o += 2; // attribute byte count
            }
            return { verts, count, format: 'binary' };
        }
    }

    const text = new TextDecoder().decode(bytes);
    if (!/^\s*solid/i.test(text) && !/facet\s+normal/i.test(text)) {
        throw new Error('not a recognisable STL file');
    }
    const nums = [];
    const re = /vertex\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
        nums.push(parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]));
    }
    const count = Math.floor(nums.length / 9);
    if (count === 0) throw new Error('STL contains no triangles');
    return { verts: Float32Array.from(nums.slice(0, count * 9)), count, format: 'ascii' };
}

function bounds(verts) {
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < verts.length; i += 3) {
        for (let k = 0; k < 3; k++) {
            const v = verts[i + k];
            if (v < lo[k]) lo[k] = v;
            if (v > hi[k]) hi[k] = v;
        }
    }
    return { lo, hi, size: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]],
             center: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2] };
}

// Orbit: spin about world Z, tilt about world X, then roll about the view axis.
function rotationMatrix(yaw, pitch, roll) {
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const cr = Math.cos(roll), sr = Math.sin(roll);
    const Rz = [cy, -sy, 0, sy, cy, 0, 0, 0, 1];
    const Rx = [1, 0, 0, 0, cp, -sp, 0, sp, cp];
    const Rr = [cr, -sr, 0, sr, cr, 0, 0, 0, 1];
    const mul = (A, B) => {
        const C = new Array(9).fill(0);
        for (let i = 0; i < 3; i++) {
            for (let j = 0; j < 3; j++) {
                for (let k = 0; k < 3; k++) C[i * 3 + j] += A[i * 3 + k] * B[k * 3 + j];
            }
        }
        return C;
    };
    return mul(Rr, mul(Rx, Rz));
}

function transformVerts(verts, M, center) {
    const out = new Float32Array(verts.length);
    const [cx, cy, cz] = center || [0, 0, 0];
    for (let i = 0; i < verts.length; i += 3) {
        const x = verts[i] - cx, y = verts[i + 1] - cy, z = verts[i + 2] - cz;
        out[i] = M[0] * x + M[1] * y + M[2] * z;
        out[i + 1] = M[3] * x + M[4] * y + M[5] * z;
        out[i + 2] = M[6] * x + M[7] * y + M[8] * z;
    }
    return out;
}

// Orthographic depth render, keeping the NEAREST surface per pixel (max z), so
// the result is what you would see looking straight down at the model.
// Returns depths in model units, plus the scale factors needed to report
// errors and emit OpenSCAD in those same units.
function depthRender(verts, W, H, opts) {
    opts = opts || {};
    const margin = opts.margin === undefined ? 2 : opts.margin;
    const b = bounds(verts);

    const spanX = b.size[0] || 1, spanY = b.size[1] || 1;
    const usableW = Math.max(1, W - 2 * margin), usableH = Math.max(1, H - 2 * margin);
    // uniform scale, so the model is never distorted
    const s = Math.min(usableW / spanX, usableH / spanY);
    const ox = margin + (usableW - spanX * s) / 2 - b.lo[0] * s;
    const oy = margin + (usableH - spanY * s) / 2 - b.lo[1] * s;

    const z = new Float64Array(W * H).fill(-Infinity);
    const cov = new Uint8Array(W * H);
    const nrm = new Float64Array(W * H); // lambert term, preview only

    const px = new Float64Array(3), py = new Float64Array(3), pz = new Float64Array(3);

    for (let t = 0; t < verts.length; t += 9) {
        for (let k = 0; k < 3; k++) {
            px[k] = verts[t + k * 3] * s + ox;
            py[k] = verts[t + k * 3 + 1] * s + oy;
            pz[k] = verts[t + k * 3 + 2];
        }
        const det = (py[1] - py[2]) * (px[0] - px[2]) + (px[2] - px[1]) * (py[0] - py[2]);
        if (Math.abs(det) < 1e-12) continue;

        // facet normal z-component, for a cheap headlight shade
        const ax = verts[t + 3] - verts[t], ay = verts[t + 4] - verts[t + 1], az = verts[t + 5] - verts[t + 2];
        const bx = verts[t + 6] - verts[t], by = verts[t + 7] - verts[t + 1], bz = verts[t + 8] - verts[t + 2];
        const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
        const nl = Math.hypot(nx, ny, nz) || 1;
        const shade = Math.abs(nz / nl);

        const x0 = Math.max(0, Math.floor(Math.min(px[0], px[1], px[2])));
        const x1 = Math.min(W - 1, Math.ceil(Math.max(px[0], px[1], px[2])));
        const y0 = Math.max(0, Math.floor(Math.min(py[0], py[1], py[2])));
        const y1 = Math.min(H - 1, Math.ceil(Math.max(py[0], py[1], py[2])));

        for (let y = y0; y <= y1; y++) {
            for (let x = x0; x <= x1; x++) {
                const l1 = ((py[1] - py[2]) * (x - px[2]) + (px[2] - px[1]) * (y - py[2])) / det;
                const l2 = ((py[2] - py[0]) * (x - px[2]) + (px[0] - px[2]) * (y - py[2])) / det;
                const l3 = 1 - l1 - l2;
                if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue;
                const d = l1 * pz[0] + l2 * pz[1] + l3 * pz[2];
                const idx = y * W + x;
                if (d > z[idx]) { z[idx] = d; cov[idx] = 1; nrm[idx] = shade; }
            }
        }
    }

    let zmin = Infinity, zmax = -Infinity, n = 0;
    for (let i = 0; i < W * H; i++) {
        if (!cov[i]) { z[i] = 0; continue; }
        n++;
        if (z[i] < zmin) zmin = z[i];
        if (z[i] > zmax) zmax = z[i];
    }
    if (!n) throw new Error('model projected to nothing - try a different rotation');

    return {
        z, cov, shade: nrm, W, H,
        zmin, zmax, covered: n,
        unitsPerPx: 1 / s,
        // Model units spanned by the normalised 0..1 patch square. That square
        // maps to pixel centres 0..W-1, not to W pixels, so the span is
        // (W-1)/s -- using W/s would scale every export slightly too large.
        modelWidth: (W - 1) / s, modelHeight: (H - 1) / s,
        bounds: b,
    };
}

// Threshold the depth buffer at a water level. Heights are re-based so water
// is zero, and normalised by the remaining span -- the caller keeps
// `unitScale` to convert any normalised error back into model units.
function applyWater(depth, level01) {
    const { z, cov, W, H, zmin, zmax } = depth;
    const t = Math.max(0, Math.min(1, level01));
    const water = zmin + t * (zmax - zmin);
    const span = zmax - water;

    const zn = new Float64Array(W * H);
    const mask = new Uint8Array(W * H);
    let above = 0;
    for (let i = 0; i < W * H; i++) {
        if (!cov[i] || z[i] <= water) continue;
        mask[i] = 1;
        zn[i] = span > 0 ? (z[i] - water) / span : 0;
        above++;
    }
    return { zn, mask, water, span, above, unitScale: span > 0 ? span : 1 };
}

module.exports = { parseSTL, bounds, rotationMatrix, transformVerts, depthRender, applyWater };
