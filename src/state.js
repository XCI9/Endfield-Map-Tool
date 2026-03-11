// ─────────────────────────────────────────────
// Global constants & shared mutable state
// Accessed by all other modules
// ─────────────────────────────────────────────

const SCALE_DOWN = 0.5;
const ENABLE_MATCH_WORKERS = false;

const MAPS = {
    map01: { file: 'assets/map01.webp', name: '四號谷地', orbf: 'assets/map01.orbf' },
    map02: { file: 'assets/map02.webp', name: '武陵',   orbf: 'assets/map02.orbf' }
};

const yieldToUI = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

function safeDeleteMat(mat) {
    if (!mat) return null;
    try {
        if (typeof mat.delete === 'function') mat.delete();
    } catch (_error) {
        // Ignore stale OpenCV proxy objects that have already been released.
    }
    return null;
}

function isMatAvailable(mat) {
    if (!mat) return false;
    try {
        return typeof mat.rows === 'number' && typeof mat.cols === 'number';
    } catch (_error) {
        return false;
    }
}

function extractAlphaMask(sourceMat) {
    const alphaMask = new cv.Mat(sourceMat.rows, sourceMat.cols, cv.CV_8UC1);
    const src = sourceMat.data;
    const dst = alphaMask.data;
    for (let i = 0, j = 3; i < dst.length; i++, j += 4) {
        dst[i] = src[j];
    }
    return alphaMask;
}

// ── OpenCV Mats ──
let grayBase = null;
let baseAlphaMask = null;
let orbFingerprint = null;   // parsed .orbf data for current map

// ── Canvas elements ──
let outputCanvas = null;
let outputCtx = null;
let baseCanvas = null;
let baseCtx = null;
let originalBaseCanvas = null;
let originalBaseCtx = null;
let overlayCanvas = null;
let overlayCtx = null;
let previewCanvas = null;
let previewCtx = null;
let dropZoneEl = null;
let contentEl = null;
let toolbarEl = null;
let dropZoneObserver = null;

// ── View state ──
let isPanning = false;
let panStart = { x: 0, y: 0 };
let viewOffset = { x: 0, y: 0 };
let viewScale = 1;
let minViewScale = 0.2;

// ── App state ──
let hasOverlay = false;
let cropMode = 'input';
let previewCropRect = null;
let currentFileCallback = null;

// ── Workers ──
let workers = [];
