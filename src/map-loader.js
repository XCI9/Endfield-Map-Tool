// ─────────────────────────────────────────────
// Map Loader
// Handles loading base map assets & switching
// ─────────────────────────────────────────────

const MapLoader = {
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

        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        canvas.getContext('2d').drawImage(img, 0, 0);

        if (baseMat) baseMat.delete();
        if (originalBaseMat) originalBaseMat.delete();
        if (grayBase) grayBase.delete();
        if (searchBase) searchBase.delete();

        baseMat = cv.imread(canvas);
        originalBaseMat = baseMat.clone();
        grayBase = new cv.Mat();
        cv.cvtColor(baseMat, grayBase, cv.COLOR_RGBA2GRAY);

        CanvasManager.syncBaseCanvasSizes();
        cv.imshow('baseCanvas', baseMat);
        cv.imshow('originalBaseCanvas', originalBaseMat);

        appState.history = [];
        appState.canUndo = false;

        CanvasManager.resetOverlayCanvas();
        appState.hasOutput = true;
        CanvasManager.resetView(appState.showOriginalBase);
        CanvasManager.renderView(appState.showOriginalBase);
        ExportHandler.updatePreview(appState);
        appState.statusText = `✅ 基底地圖已載入：${mapInfo.name}，請上傳截圖`;
        appState.isLoadingBaseMap = false;
    },

    async selectMap(appState, key) {
        if (appState.isProcessing) return;
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
