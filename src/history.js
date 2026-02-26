// ─────────────────────────────────────────────
// History
// Undo / redo of screenshot applications
// ─────────────────────────────────────────────

const History = {
    undoLastAction(appState) {
        if (appState.isProcessing) return;
        if (appState.history.length === 0) return;

        appState.history.pop();
        appState.canUndo = appState.history.length > 0;

        // Restore baseMat from original
        if (baseMat) baseMat.delete();
        baseMat = originalBaseMat.clone();

        CanvasManager.resetOverlayCanvas();

        // Replay remaining history onto baseMat and overlay
        for (const item of appState.history) {
            const itemMat = cv.imread(item.canvas);
            const roi = baseMat.roi(new cv.Rect(item.rect.x, item.rect.y, item.rect.width, item.rect.height));
            itemMat.copyTo(roi);
            itemMat.delete();
            roi.delete();

            overlayCtx.drawImage(item.canvas, item.rect.x, item.rect.y, item.rect.width, item.rect.height);
            hasOverlay = true;
        }

        cv.imshow('baseCanvas', baseMat);
        CanvasManager.renderView(appState.showOriginalBase);
        ExportHandler.updatePreview(appState);
        appState.statusText = '↩️ 已復原上一步操作';
    }
};
