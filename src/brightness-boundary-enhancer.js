// ─────────────────────────────────────────────
// Brightness Boundary Enhancer
// Experimental edge-brightness compensation for
// screenshots that include full game UI frame.
// ─────────────────────────────────────────────

const BrightnessBoundaryEnhancer = {
    CONFIG_TOP:   { ratio: 0.30, a: 6.6790, b: 0.0129, c:  0.8210, max_gain: 8.10 },
    CONFIG_BOT:   { ratio: 0.30, a: 3.5758, b: 0.0101, c: 0.9242, max_gain: 4.25 },
    CONFIG_LEFT:  { ratio: 0.15, a: 3.001, b: 0.0113, c: 0.884, max_gain: 3.89 },
    CONFIG_RIGHT: { ratio: 0.15, a: 3.1116, b: 0.0102, c:  0.6384, max_gain: 4.67 },

    // Stretch/compress the axis so gain reaches exactly 1 at ratio boundary.
    _resolveAxisScale(config, spanLength) {
        if (spanLength <= 1) return 1;

        const target = (1 - config.c) / config.a;
        if (!Number.isFinite(target) || target <= 0 || target >= 1 || config.b <= 0) return 1;

        const boundaryDist = spanLength - 1;
        const scale = -Math.log(target) / (config.b * boundaryDist);
        return Number.isFinite(scale) && scale > 0 ? scale : 1;
    },

    _clampRect(rect, width, height) {
        const x = Math.max(0, Math.min(width - 1, Math.round(rect.x || 0)));
        const y = Math.max(0, Math.min(height - 1, Math.round(rect.y || 0)));
        const w = Math.max(1, Math.min(width - x, Math.round(rect.width || width)));
        const h = Math.max(1, Math.min(height - y, Math.round(rect.height || height)));
        return { x, y, width: w, height: h };
    },

    _buildVerticalGains(height) {
        const gains = new Float32Array(height);
        gains.fill(1);

        const topHeight = Math.floor(height * this.CONFIG_TOP.ratio);
        const topScale = this._resolveAxisScale(this.CONFIG_TOP, topHeight);
        for (let y = 0; y < topHeight; y++) {
            const gain = this.CONFIG_TOP.a * Math.exp(-this.CONFIG_TOP.b * (y * topScale)) + this.CONFIG_TOP.c;
            gains[y] = Math.min(gain, this.CONFIG_TOP.max_gain);
        }

        const bottomHeight = Math.floor(height * this.CONFIG_BOT.ratio);
        const bottomScale = this._resolveAxisScale(this.CONFIG_BOT, bottomHeight);
        for (let y = height - bottomHeight; y < height; y++) {
            const distY = (height - 1) - y;
            const gain = this.CONFIG_BOT.a * Math.exp(-this.CONFIG_BOT.b * (distY * bottomScale)) + this.CONFIG_BOT.c;
            gains[y] = Math.min(gain, this.CONFIG_BOT.max_gain);
        }

        return gains;
    },

    _buildHorizontalGains(width) {
        const gains = new Float32Array(width);
        gains.fill(1);

        const leftWidth = Math.floor(width * this.CONFIG_LEFT.ratio);
        const leftScale = this._resolveAxisScale(this.CONFIG_LEFT, leftWidth);
        for (let x = 0; x < leftWidth; x++) {
            const gain = this.CONFIG_LEFT.a * Math.exp(-this.CONFIG_LEFT.b * (x * leftScale)) + this.CONFIG_LEFT.c;
            gains[x] = Math.min(gain, this.CONFIG_LEFT.max_gain);
        }

        const rightWidth = Math.floor(width * this.CONFIG_RIGHT.ratio);
        const rightScale = this._resolveAxisScale(this.CONFIG_RIGHT, rightWidth);
        for (let x = width - rightWidth; x < width; x++) {
            const distX = (width - 1) - x;
            const gain = this.CONFIG_RIGHT.a * Math.exp(-this.CONFIG_RIGHT.b * (distX * rightScale)) + this.CONFIG_RIGHT.c;
            gains[x] = Math.min(gain, this.CONFIG_RIGHT.max_gain);
        }

        return gains;
    },

    // Apply enhancement using the source (pre-crop) coordinate system.
    // This guarantees: crop -> enhance == enhance(full) -> crop.
    applyToCroppedCanvas(sourceCanvas, cropRect) {
        if (!sourceCanvas || sourceCanvas.width < 1 || sourceCanvas.height < 1) return null;

        const sourceWidth = sourceCanvas.width;
        const sourceHeight = sourceCanvas.height;
        const rect = this._clampRect(cropRect, sourceWidth, sourceHeight);

        const sourceCtx = sourceCanvas.getContext('2d', { willReadFrequently: true });
        const imageData = sourceCtx.getImageData(rect.x, rect.y, rect.width, rect.height);
        const data = imageData.data;

        const gainsH = this._buildVerticalGains(sourceHeight);
        const gainsW = this._buildHorizontalGains(sourceWidth);

        for (let y = 0; y < rect.height; y++) {
            const sourceY = rect.y + y;
            const gainY = gainsH[sourceY];
            for (let x = 0; x < rect.width; x++) {
                const sourceX = rect.x + x;
                const gain = gainY * gainsW[sourceX];
                const idx = (y * rect.width + x) * 4;

                data[idx] = Math.min(255, data[idx] * gain);
                data[idx + 1] = Math.min(255, data[idx + 1] * gain);
                data[idx + 2] = Math.min(255, data[idx + 2] * gain);
            }
        }

        const out = document.createElement('canvas');
        out.width = rect.width;
        out.height = rect.height;
        out.getContext('2d').putImageData(imageData, 0, 0);
        return out;
    }
};
