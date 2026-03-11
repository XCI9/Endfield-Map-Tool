// ─────────────────────────────────────────────
// Fingerprint Loader
// Loads & parses .orbf (raw binary ORB fingerprint)
//
// Binary layout:
//   [4B]     Magic: "ORBF"
//   [4B]     n: keypoint count (uint32 LE)
//   [n×10B]  Keypoints per entry (all little-endian):
//              off+0  uint16  x          (pixel coord)
//              off+2  uint16  y          (pixel coord)
//              off+4  uint16  size × 10  (0.1 precision)
//              off+6  uint16  angle × 100 (0.01° precision; 0xFFFF = -1)
//              off+8  uint8   octave
//              off+9  int8    class_id
//   [n×32B]  ORB descriptors (uint8, row-major)
// ─────────────────────────────────────────────

const FingerprintLoader = {
    KP_STRIDE:  10,
    DES_STRIDE: 32,

    // ── Load a .orbf file ─────────────────────────────────────────────────────
    async load(url) {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`[Fingerprint] fetch failed: ${url} (${resp.status})`);
        const buffer = await resp.arrayBuffer();
        return this._parse(buffer);
    },

    // ── Parse raw ArrayBuffer into { kps, des, n } ───────────────────────────
    _parse(buffer) {
        const view  = new DataView(buffer);
        const magic = String.fromCharCode(
            view.getUint8(0), view.getUint8(1),
            view.getUint8(2), view.getUint8(3),
        );
        if (magic !== 'ORBF') throw new Error(`[Fingerprint] invalid magic: "${magic}"`);

        const n               = view.getUint32(4, true);
        const { KP_STRIDE, DES_STRIDE } = this;

        const kps = new Array(n);
        for (let i = 0; i < n; i++) {
            const off      = 8 + i * KP_STRIDE;
            const rawAngle = view.getUint16(off + 6, true);
            kps[i] = {
                x:        view.getUint16(off,     true),
                y:        view.getUint16(off + 2, true),
                size:     view.getUint16(off + 4, true) / 10,
                angle:    rawAngle === 0xFFFF ? -1 : rawAngle / 100,
                octave:   view.getUint8(off + 8),
                class_id: view.getInt8(off + 9),
            };
        }

        // Reference the descriptor bytes directly (zero-copy view)
        const desOffset = 8 + n * KP_STRIDE;
        const des       = new Uint8Array(buffer, desOffset, n * DES_STRIDE);

        return { kps, des, n };
    },

    // ── Convert parsed result to OpenCV.js objects ───────────────────────────
    // Returns { kps, desMat } where desMat is cv.Mat(n, 32, CV_8UC1)
    // Caller is responsible for calling desMat.delete() when done.
    toOpenCV(parsed) {
        const { kps, des, n } = parsed;
        const desMat = new cv.Mat(n, this.DES_STRIDE, cv.CV_8UC1);
        desMat.data.set(des);
        return { kps, desMat, n };
    },
};
