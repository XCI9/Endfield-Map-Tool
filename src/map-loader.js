// ─────────────────────────────────────────────
// Map Loader
// Handles loading base map assets & switching
// ─────────────────────────────────────────────

const MapLoader = {
    drawBaseCanvasesFromSource(sourceCanvas) {
        if (baseCanvas && baseCtx) {
            baseCtx.clearRect(0, 0, baseCanvas.width, baseCanvas.height);
            baseCtx.drawImage(sourceCanvas, 0, 0, baseCanvas.width, baseCanvas.height);
        }
        if (originalBaseCanvas && originalBaseCtx) {
            originalBaseCtx.clearRect(0, 0, originalBaseCanvas.width, originalBaseCanvas.height);
            originalBaseCtx.drawImage(sourceCanvas, 0, 0, originalBaseCanvas.width, originalBaseCanvas.height);
        }
    },

    extractAlphaMask(sourceMat) {
        const alphaMask = new cv.Mat(sourceMat.rows, sourceMat.cols, cv.CV_8UC1);
        const src = sourceMat.data;
        const dst = alphaMask.data;
        for (let i = 0, j = 3; i < dst.length; i++, j += 4) {
            dst[i] = src[j];
        }
        return alphaMask;
    },

    propagateEdgeGrayValues(grayMat, alphaMask) {
        const grayData = grayMat.data;
        const alphaData = alphaMask.data;
        const total = grayData.length;
        const sums = new Float32Array(total);
        const counts = new Uint8Array(total);
        const rows = grayMat.rows;
        const cols = grayMat.cols;

        for (let x = 0; x < cols; x++) {
            let lastSeen = -1;
            for (let y = 0; y < rows; y++) {
                const idx = y * cols + x;
                if (alphaData[idx] > 0) {
                    lastSeen = grayData[idx];
                } else if (lastSeen >= 0) {
                    sums[idx] += lastSeen;
                    counts[idx] += 1;
                }
            }

            lastSeen = -1;
            for (let y = rows - 1; y >= 0; y--) {
                const idx = y * cols + x;
                if (alphaData[idx] > 0) {
                    lastSeen = grayData[idx];
                } else if (lastSeen >= 0) {
                    sums[idx] += lastSeen;
                    counts[idx] += 1;
                }
            }
        }

        for (let y = 0; y < rows; y++) {
            let lastSeen = -1;
            const rowOffset = y * cols;
            for (let x = 0; x < cols; x++) {
                const idx = rowOffset + x;
                if (alphaData[idx] > 0) {
                    lastSeen = grayData[idx];
                } else if (lastSeen >= 0) {
                    sums[idx] += lastSeen;
                    counts[idx] += 1;
                }
            }

            lastSeen = -1;
            for (let x = cols - 1; x >= 0; x--) {
                const idx = rowOffset + x;
                if (alphaData[idx] > 0) {
                    lastSeen = grayData[idx];
                } else if (lastSeen >= 0) {
                    sums[idx] += lastSeen;
                    counts[idx] += 1;
                }
            }
        }

        for (let idx = 0; idx < total; idx++) {
            if (alphaData[idx] > 0) continue;
            grayData[idx] = counts[idx] > 0 ? Math.round(sums[idx] / counts[idx]) : 108;
        }
    },

    fillTransparentGrayFromEdges(grayMat, alphaMask) {
        const alphaData = alphaMask.data;
        let opaquePixels = 0;
        for (let i = 0; i < alphaData.length; i++) {
            if (alphaData[i] > 0) opaquePixels += 1;
        }

        if (opaquePixels === 0 || opaquePixels === alphaData.length) return;

        this.propagateEdgeGrayValues(grayMat, alphaMask);

        const grayData = grayMat.data;
        const original = new Uint8Array(grayData);
        const rows = grayMat.rows;
        const cols = grayMat.cols;

        for (let y = 0; y < rows; y++) {
            const rowOffset = y * cols;
            for (let x = 0; x < cols; x++) {
                const idx = rowOffset + x;
                if (alphaData[idx] > 0) continue;

                let sum = original[idx];
                let count = 1;

                if (x > 0) {
                    sum += original[idx - 1];
                    count += 1;
                }
                if (x + 1 < cols) {
                    sum += original[idx + 1];
                    count += 1;
                }
                if (y > 0) {
                    sum += original[idx - cols];
                    count += 1;
                }
                if (y + 1 < rows) {
                    sum += original[idx + cols];
                    count += 1;
                }

                grayData[idx] = Math.round(sum / count);
            }
        }
    },

    processGrayBase(sourceMat, alphaMask = null) {
        const gray = new cv.Mat();
        const ownAlphaMask = !alphaMask;
        const resolvedAlphaMask = alphaMask || this.extractAlphaMask(sourceMat);

        try {
            cv.cvtColor(sourceMat, gray, cv.COLOR_RGBA2GRAY);
            this.fillTransparentGrayFromEdges(gray, resolvedAlphaMask);
            return gray;
        } catch (error) {
            gray.delete();
            throw new Error(`processGrayBase failed: ${error?.message || error}`);
        } finally {
            if (ownAlphaMask) resolvedAlphaMask.delete();
        }
    },

    async loadBaseMapFromAsset(appState, mapKey) {
        const mapInfo = MAPS[mapKey] || MAPS.map02;
        appState.statusText = `⏳ 載入基底地圖 ${mapInfo.name} 中...`;
        appState.isLoadingBaseMap = true;

        if (outputCtx && outputCanvas) {
            outputCtx.clearRect(0, 0, outputCanvas.width, outputCanvas.height);
        }

        const img = new Image();
        const loadPromise = new Promise((resolve, reject) => {
            img.onload = () => resolve();
            img.onerror = reject;
        });
        img.src = mapInfo.file;

        try {
            await loadPromise;
            if (img.decode) await img.decode().catch(() => undefined);
        } catch (error) {
            appState.statusText = `❌ 無法載入基底地圖：${mapInfo.name}。請確認 ${mapInfo.file} 是否存在。`;
            appState.isLoadingBaseMap = false;
            return;
        }

        let nextBaseMat = null;
        let nextGrayBase = null;
        let nextBaseAlphaMask = null;
        let alphaMask = null;

        try {
            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;
            canvas.getContext('2d').drawImage(img, 0, 0);

            // Yield before heavy sync work so the DOM can reflect isLoadingBaseMap=true
            // (disabled state) before the event loop freezes.
            await yieldToUI();

            try {
                nextBaseMat = cv.imread(canvas);
                if (!isMatAvailable(nextBaseMat)) {
                    throw new Error('cv.imread returned an invalid Mat');
                }

                alphaMask = this.extractAlphaMask(nextBaseMat);
                nextGrayBase = this.processGrayBase(nextBaseMat, alphaMask);
                nextBaseAlphaMask = alphaMask;
                alphaMask = null;
            } catch (error) {
                throw new Error(`prepare base mats failed: ${error?.message || error}`);
            } finally {
                alphaMask = safeDeleteMat(alphaMask);
            }

            baseMat = safeDeleteMat(baseMat);
            originalBaseMat = safeDeleteMat(originalBaseMat);
            grayBase = safeDeleteMat(grayBase);
            baseAlphaMask = safeDeleteMat(baseAlphaMask);
            searchBase = safeDeleteMat(searchBase);

            baseMat = null;
            originalBaseMat = null;
            grayBase = nextGrayBase;
            baseAlphaMask = nextBaseAlphaMask;
            nextBaseMat = safeDeleteMat(nextBaseMat);
            nextGrayBase = null;
            nextBaseAlphaMask = null;

            CanvasManager.syncBaseCanvasSizes();
            this.drawBaseCanvasesFromSource(canvas);

            appState.history = [];
            appState.canUndo = false;

            CanvasManager.resetOverlayCanvas();
            appState.hasOutput = true;
            CanvasManager.resetView(appState.showOriginalBase);
            CanvasManager.renderView(appState.showOriginalBase);
            ExportHandler.updatePreview(appState);
            appState.statusText = `✅ 基底地圖已載入：${mapInfo.name}，請上傳截圖`;

            // Yield again before clearing the flag. Any click events that were queued
            // during the synchronous OpenCV work above will fire HERE — while
            // isLoadingBaseMap is still true — so the JS-level guards can catch them.
            await yieldToUI();
        } catch (error) {
            nextBaseMat = safeDeleteMat(nextBaseMat);
            nextGrayBase = safeDeleteMat(nextGrayBase);
            nextBaseAlphaMask = safeDeleteMat(nextBaseAlphaMask);
            alphaMask = safeDeleteMat(alphaMask);
            console.error('Failed to process base map', error, {
                mapKey,
                mapName: mapInfo.name,
                imageWidth: img.width,
                imageHeight: img.height,
            });
            appState.statusText = '❌ 基底地圖處理失敗，請重新整理後再試';
        } finally {
            appState.isLoadingBaseMap = false;
        }
    },

    async selectMap(appState, key) {
        if (appState.isProcessing || appState.isLoadingBaseMap) return;
        if (appState.currentMapKey === key) return;

        if (hasOverlay) {
            appState.pendingMapKey = key;
            appState.showConfirmModal = true;
            return;
        }

        appState.currentMapKey = key;
        await this.loadBaseMapFromAsset(appState, key);
    },

    async confirmMapSwitch(appState) {
        appState.showConfirmModal = false;
        if (appState.pendingMapKey) {
            appState.currentMapKey = appState.pendingMapKey;
            appState.pendingMapKey = null;
            await this.loadBaseMapFromAsset(appState, appState.currentMapKey);
        }
    },

    cancelMapSwitch(appState) {
        appState.showConfirmModal = false;
        appState.pendingMapKey = null;
    }
};
