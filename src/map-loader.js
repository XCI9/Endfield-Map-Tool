// ─────────────────────────────────────────────
// Map Loader
// Handles loading base map assets & switching
// ─────────────────────────────────────────────

const MapLoader = {
    drawBaseCanvasFromSource(source) {
        if (baseCanvas && baseCtx) {
            baseCtx.clearRect(0, 0, baseCanvas.width, baseCanvas.height);
            baseCtx.drawImage(source, 0, 0, baseCanvas.width, baseCanvas.height);
        }
    },

    async restoreMapLayers(appState) {
        const mapInfo = MAPS[appState.currentMapKey] || MAPS.map02;
        const img = new Image();
        const loadPromise = new Promise((resolve, reject) => {
            img.onload = () => resolve();
            img.onerror = () => reject(new Error(
                UIText.STATUS.BASE_MAP_LOAD_FAILED(appState.currentMapKey, mapInfo.file)
            ));
        });
        img.src = mapInfo.file;
        await loadPromise;
        if (img.decode) await img.decode().catch(() => undefined);

        baseMapSize = { width: img.width, height: img.height };
        CanvasManager.syncBaseCanvasSize();
        this.drawBaseCanvasFromSource(img);
        CanvasManager.rebuildHistoryCanvas(appState);
        CanvasManager.renderView(appState.showOriginalBase);
    },

    async loadBaseMapFromAsset(appState, mapKey) {
        const mapInfo = MAPS[mapKey] || MAPS.map02;
        appState.statusText = UIText.STATUS.BASE_MAP_LOADING(mapKey);
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
            appState.statusText = UIText.STATUS.BASE_MAP_LOAD_FAILED(mapKey, mapInfo.file);
            appState.isLoadingBaseMap = false;
            return;
        }

        let nextBaseAlphaMask = null;
        let alphaMask = null;
        let workerSourceCanvas = null;

        try {
            if (ENABLE_MATCH_WORKERS) {
                workerSourceCanvas = document.createElement('canvas');
                workerSourceCanvas.width = img.width;
                workerSourceCanvas.height = img.height;
                workerSourceCanvas.getContext('2d').drawImage(img, 0, 0);
            }

            // Yield before heavy sync work so the DOM can reflect isLoadingBaseMap=true
            // (disabled state) before the event loop freezes.
            await yieldToUI();

            // ORB 配對不使用全圖 alpha mask，避免 cv.imread() 為超大底圖配置
            // RGBA Mat。只有啟用保留的 multithread template-match 路徑時才建立。
            if (ENABLE_MATCH_WORKERS) {
                let rgbaBaseMat = null;
                try {
                    rgbaBaseMat = cv.imread(workerSourceCanvas);
                    if (!isMatAvailable(rgbaBaseMat)) {
                        throw new Error('cv.imread returned an invalid Mat');
                    }

                    alphaMask = extractAlphaMask(rgbaBaseMat);
                    nextBaseAlphaMask = alphaMask;
                    alphaMask = null;
                } catch (error) {
                    throw new Error(`prepare base alpha mask failed: ${error?.message || error}`);
                } finally {
                    rgbaBaseMat = safeDeleteMat(rgbaBaseMat);
                    alphaMask = safeDeleteMat(alphaMask);
                }
            }

            baseAlphaMask = safeDeleteMat(baseAlphaMask);

            baseMapSize = { width: img.width, height: img.height };
            baseAlphaMask = nextBaseAlphaMask;
            nextBaseAlphaMask = null;

            appState.history = [];
            appState.canUndo = false;
            appState.exportMapLayersReleased = false;
            CanvasManager.releaseHistoryCanvas();

            CanvasManager.syncBaseCanvasSize();
            this.drawBaseCanvasFromSource(img);
            appState.hasOutput = true;
            CanvasManager.resetView(appState.showOriginalBase);
            CanvasManager.renderView(appState.showOriginalBase);
            ExportHandler.updatePreview(appState);

            // Load the ORB fingerprint for the selected map.
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

            appState.statusText = UIText.STATUS.BASE_MAP_LOADED(mapKey);

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
            if (workerSourceCanvas) {
                workerSourceCanvas.width = 1;
                workerSourceCanvas.height = 1;
            }
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
