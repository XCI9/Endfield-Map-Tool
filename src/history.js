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

        cv.imshow('baseCanvas', baseMat);

        if (baseCanvas) {
            const ctx = baseCanvas.getContext('2d');
            
            // Replay remaining history onto baseCanvas using pure DOM Canvas high-quality blending
            for (const item of appState.history) {
                // Draw onto visual base canvas perfectly
                ctx.drawImage(item.canvas, 0, 0, item.rect.width, item.rect.height, item.rect.x, item.rect.y, item.rect.width, item.rect.height);
                // Also update the overlay canvas for the view mode
                overlayCtx.drawImage(item.canvas, 0, 0, item.rect.width, item.rect.height, item.rect.x, item.rect.y, item.rect.width, item.rect.height);
                hasOverlay = true;
            }

            // Sync baseMat back from the perfectly blended baseCanvas so memory matches screen
            const newBaseMat = cv.imread(baseCanvas);
            baseMat.delete();
            baseMat = newBaseMat;
        }

        CanvasManager.renderView(appState.showOriginalBase);
        ExportHandler.updatePreview(appState);
        appState.statusText = '↩️ 已復原上一步操作';
    }
};
