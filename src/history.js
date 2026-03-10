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

        // Restore displayed base canvas from the pristine original base canvas
        if (!originalBaseCanvas || !baseCanvas || !baseCtx) return;
        CanvasManager.syncBaseCanvasSizes();
        baseCtx.clearRect(0, 0, baseCanvas.width, baseCanvas.height);
        baseCtx.drawImage(originalBaseCanvas, 0, 0);

        CanvasManager.resetOverlayCanvas();

        // Replay remaining history onto baseCanvas using pure DOM Canvas high-quality blending
        for (const item of appState.history) {
            // Draw onto visual base canvas perfectly
            baseCtx.drawImage(item.canvas, 0, 0, item.rect.width, item.rect.height, item.rect.x, item.rect.y, item.rect.width, item.rect.height);
            // Also update the overlay canvas for the view mode
            overlayCtx.drawImage(item.canvas, 0, 0, item.rect.width, item.rect.height, item.rect.x, item.rect.y, item.rect.width, item.rect.height);
            hasOverlay = true;
        }

        CanvasManager.renderView(appState.showOriginalBase);
        ExportHandler.updatePreview(appState);
        appState.statusText = '↩️ 已復原上一步操作';
    }
};
