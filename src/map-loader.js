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

    fillTransparentWithBlack(grayMat, alphaMask) {
        const grayData = grayMat.data;
        const alphaData = alphaMask.data;
        for (let i = 0; i < alphaData.length; i++) {
            if (alphaData[i] === 0) {
                grayData[i] = 0;
            }
        }
    },

    processGrayBase(sourceMat, alphaMask = null) {
        const gray = new cv.Mat();
        const ownAlphaMask = !alphaMask;
        const resolvedAlphaMask = alphaMask || extractAlphaMask(sourceMat);

        try {
            cv.cvtColor(sourceMat, gray, cv.COLOR_RGBA2GRAY);
            this.fillTransparentWithBlack(gray, resolvedAlphaMask);
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

            let rgbaBaseMat = null;
            try {
                rgbaBaseMat = cv.imread(canvas);
                if (!isMatAvailable(rgbaBaseMat)) {
                    throw new Error('cv.imread returned an invalid Mat');
                }

                alphaMask = extractAlphaMask(rgbaBaseMat);
                nextGrayBase = this.processGrayBase(rgbaBaseMat, alphaMask);
                nextBaseAlphaMask = alphaMask;
                alphaMask = null;
            } catch (error) {
                throw new Error(`prepare base mats failed: ${error?.message || error}`);
            } finally {
                rgbaBaseMat = safeDeleteMat(rgbaBaseMat);
                alphaMask = safeDeleteMat(alphaMask);
            }

            grayBase = safeDeleteMat(grayBase);
            baseAlphaMask = safeDeleteMat(baseAlphaMask);

            grayBase = nextGrayBase;
            baseAlphaMask = nextBaseAlphaMask;
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
