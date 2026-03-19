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
        appState.statusText = UIText.STATUS.BASE_MAP_LOADING(mapInfo.name);
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
            appState.statusText = UIText.STATUS.BASE_MAP_LOAD_FAILED(mapInfo.name, mapInfo.file);
            appState.isLoadingBaseMap = false;
            return;
        }

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
                nextBaseAlphaMask = alphaMask;
                alphaMask = null;
                // grayBase Mat 已不再需要（ORB 改用 .orbf），僅儲存尺寸
            } catch (error) {
                throw new Error(`prepare base mats failed: ${error?.message || error}`);
            } finally {
                rgbaBaseMat = safeDeleteMat(rgbaBaseMat);
                alphaMask = safeDeleteMat(alphaMask);
            }

            baseAlphaMask = safeDeleteMat(baseAlphaMask);

            baseMapSize = { width: img.width, height: img.height };
            baseAlphaMask = nextBaseAlphaMask;
            nextBaseAlphaMask = null;

            CanvasManager.syncBaseCanvasSizes();
            this.drawBaseCanvasesFromSource(canvas);

            appState.history = [];
            appState.canUndo = false;

            CanvasManager.rebuildCompositeCanvas(appState);
            appState.hasOutput = true;
            CanvasManager.resetView(appState.showOriginalBase);
            CanvasManager.renderView(appState.showOriginalBase);
            ExportHandler.updatePreview(appState);

            // Load ORB fingerprint for the selected map
            orbFingerprint = null;
            if (mapInfo.orbf) {
                appState.statusText = UIText.STATUS.ORB_LOADING;
                await yieldToUI();
                try {
                    orbFingerprint = await FingerprintLoader.load(mapInfo.orbf);
                } catch (e) {
                    console.warn('[MapLoader] 無法載入 ORB 指紋:', e);
                }
            }

            appState.statusText = UIText.STATUS.BASE_MAP_LOADED(mapInfo.name);

            // Yield again before clearing the flag. Any click events that were queued
            // during the synchronous OpenCV work above will fire HERE — while
            // isLoadingBaseMap is still true — so the JS-level guards can catch them.
            await yieldToUI();
        } catch (error) {
            nextBaseAlphaMask = safeDeleteMat(nextBaseAlphaMask);
            alphaMask = safeDeleteMat(alphaMask);
            console.error('Failed to process base map', error, {
                mapKey,
                mapName: mapInfo.name,
                imageWidth: img.width,
                imageHeight: img.height,
            });
            appState.statusText = UIText.STATUS.BASE_MAP_PROCESS_FAILED;
        } finally {
            appState.isLoadingBaseMap = false;
        }
    },

    async selectMap(appState, key) {
        if (appState.isProcessing || appState.isLoadingBaseMap) return;
        if (appState.currentMapKey === key) return;

        if (appState.history.length > 0) {
            const confirmed = await appState.openConfirmModal(
                UIText.MODAL.SWITCH_MAP_TITLE,
                UIText.MODAL.SWITCH_MAP_MESSAGE,
                UIText.MODAL.SWITCH_MAP_CONFIRM,
                UIText.MODAL.CANCEL
            );
            if (!confirmed) return;
        }

        appState.currentMapKey = key;
        await this.loadBaseMapFromAsset(appState, key);
    }
};
