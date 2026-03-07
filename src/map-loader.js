// ─────────────────────────────────────────────
// Map Loader
// Handles loading base map assets & switching
// ─────────────────────────────────────────────

const MapLoader = {
    processGrayBase(sourceMat) {
        const gray = new cv.Mat();
        cv.cvtColor(sourceMat, gray, cv.COLOR_RGBA2GRAY);

        const planes = new cv.MatVector();
        cv.split(sourceMat, planes);
        const alphaMask = planes.get(3).clone();
        for (let i = 0; i < planes.size(); i++) planes.get(i).delete();
        planes.delete();

        const totalPixels = gray.rows * gray.cols;
        const opaquePixels = cv.countNonZero(alphaMask);

        // Fill transparent regions with a specific color #6c6c6c (108 in decimal)
        // 此顏色為大地圖上周邊區域的灰色 (The gray color of the surrounding area on the base map)
        if (opaquePixels > 0 && opaquePixels < totalPixels) {
            const invMask = new cv.Mat();
            cv.bitwise_not(alphaMask, invMask);
            
            // Fast boundary color propagation using downsampled inpainting
            const smallWidth = Math.min(256, gray.cols);
            const smallHeight = Math.max(1, Math.round((gray.rows / gray.cols) * smallWidth));
            
            const smallGray = new cv.Mat();
            const smallMask = new cv.Mat();
            
            cv.resize(gray, smallGray, new cv.Size(smallWidth, smallHeight), 0, 0, cv.INTER_AREA);
            cv.resize(invMask, smallMask, new cv.Size(smallWidth, smallHeight), 0, 0, cv.INTER_NEAREST);
            
            const smallInpainted = new cv.Mat();
            cv.inpaint(smallGray, smallMask, smallInpainted, 3, cv.INPAINT_TELEA);
            
            const largeInpainted = new cv.Mat();
            cv.resize(smallInpainted, largeInpainted, new cv.Size(gray.cols, gray.rows), 0, 0, cv.INTER_LINEAR);
            
            largeInpainted.copyTo(gray, invMask);
            
            smallGray.delete();
            smallMask.delete();
            smallInpainted.delete();
            largeInpainted.delete();
            invMask.delete();
        }

        alphaMask.delete();
        return gray;
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

        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        canvas.getContext('2d').drawImage(img, 0, 0);

        // Yield before heavy sync work so the DOM can reflect isLoadingBaseMap=true
        // (disabled state) before the event loop freezes.
        await yieldToUI();

        if (baseMat) baseMat.delete();
        if (originalBaseMat) originalBaseMat.delete();
        if (grayBase) grayBase.delete();
        if (searchBase) searchBase.delete();

        baseMat = cv.imread(canvas);
        originalBaseMat = baseMat.clone();
        if (grayBase && !grayBase.isDeleted()) grayBase.delete();
        grayBase = this.processGrayBase(baseMat);

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

        // Yield again before clearing the flag. Any click events that were queued
        // during the synchronous OpenCV work above will fire HERE — while
        // isLoadingBaseMap is still true — so the JS-level guards can catch them.
        await yieldToUI();
        appState.isLoadingBaseMap = false;
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
