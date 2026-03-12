// ─────────────────────────────────────────────
// History
// Undo / redo of screenshot applications
// ─────────────────────────────────────────────

const History = {
    addRecord(appState, originalCanvas, resizedCanvas, rect, scale) {
        CanvasManager.syncBaseCanvasSizes(); 
        
        // Render onto base canvas immediately
        if (baseCanvas && baseCtx) {
            baseCtx.drawImage(
                resizedCanvas, 
                0, 0, rect.width, rect.height, 
                rect.x, rect.y, rect.width, rect.height
            );
        }

        // Clone the original canvas for rematching capability
        const savedOriginalCanvas = document.createElement('canvas');
        savedOriginalCanvas.width = originalCanvas.width;
        savedOriginalCanvas.height = originalCanvas.height;
        savedOriginalCanvas.getContext('2d').drawImage(originalCanvas, 0, 0);

        appState.history.push({ 
            canvas: resizedCanvas, 
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            originalCanvas: savedOriginalCanvas,
            scale: scale
        });
        
        appState.canUndo = true;
        CanvasManager.renderView(appState.showOriginalBase);
        ExportHandler.updatePreview(appState);
    },

    undoLastAction(appState) {
        if (appState.isProcessing) return;
        if (appState.history.length === 0) return;

        appState.history.pop();
        appState.canUndo = appState.history.length > 0;

        // Restore displayed base canvas from the pristine original base canvas
        if (!originalBaseCanvas || !baseCanvas || !baseCtx) return;
        CanvasManager.syncBaseCanvasSizes();
        CanvasManager.rebuildCompositeCanvas(appState);

        CanvasManager.renderView(appState.showOriginalBase);
        ExportHandler.updatePreview(appState);
        appState.statusText = '↩️ 已復原上一步操作';
    }
};
