// ─────────────────────────────────────────────
// Cropper Handler
// Manages Cropper.js lifecycle, file input,
// crop confirm for both input and preview modes
// ─────────────────────────────────────────────

const CropperHandler = {
    openFilePicker(appState) {
        if (appState.isProcessing || appState.isLoadingBaseMap) return;
        appState.$refs.subFile.value = '';
        appState.$refs.subFile.click();
    },

    onSubFileChange(appState, e) {
        const file = e.target.files?.[0];
        if (file) this.openCropWithFile(appState, file);
    },

    async openCropWithFile(appState, file) {
        if (appState.isProcessing || appState.isLoadingBaseMap) return;
        if (!file.type.startsWith('image/')) {
            appState.statusText = '❌ 只支援圖片檔案';
            return;
        }

        cropMode = 'input';
        currentFileCallback = (canvas) => Matcher.processScreenshotAfterCrop(appState, canvas);

        const url = URL.createObjectURL(file);
        const img = document.getElementById('cropImage');
        img.src = url;

        appState.showCrop = true;
        appState.cropStatus = '請調整裁剪區域';

        await yieldToUI();

        if (appState.cropper) appState.cropper.destroy();

        appState.cropper = new Cropper(img, {
            viewMode: 1,
            movable: true,
            zoomable: true,
            scalable: false,
            rotatable: false,
            restore: false,
            toggleDragModeOnDblclick: false,
        });
    },

    resetCrop(appState) {
        if (appState.cropper) appState.cropper.reset();
    },

    selectAllCrop(appState) {
        if (appState.cropper) {
            const data = appState.cropper.getImageData();
            appState.cropper.setData({ x: 0, y: 0, width: data.naturalWidth, height: data.naturalHeight });
        }
    },

    cancelCrop(appState) {
        appState.showCrop = false;
        if (appState.cropper) {
            appState.cropper.destroy();
            appState.cropper = null;
        }
        appState.cropStatus = '請拖拽選擇要裁剪的區域';
    },

    async confirmCrop(appState) {
        if (!appState.cropper) return;

        const croppedCanvas = appState.cropper.getCroppedCanvas();
        if (!croppedCanvas || croppedCanvas.width < 1 || croppedCanvas.height < 1) {
            appState.cropStatus = '裁剪區域過小，請重新選擇。';
            return;
        }

        if (cropMode === 'preview') {
            const data = appState.cropper.getData();
            previewCropRect = {
                x: Math.round(data.x),
                y: Math.round(data.y),
                width: Math.round(data.width),
                height: Math.round(data.height)
            };
            appState.showCrop = false;
            if (appState.cropper) { appState.cropper.destroy(); appState.cropper = null; }
            appState.cropStatus = '請拖拽選擇要裁剪的區域';
            ExportHandler.updatePreview(appState);
            return;
        }

        appState.showCrop = false;
        if (appState.cropper) { appState.cropper.destroy(); appState.cropper = null; }
        appState.cropStatus = '請拖拽選擇要裁剪的區域';

        await new Promise((resolve) => requestAnimationFrame(() => resolve()));
        await new Promise((resolve) => setTimeout(resolve, 0));

        if (currentFileCallback) await currentFileCallback(croppedCanvas);
    },

    async openPreviewCrop(appState) {
        if (!previewCanvas) return;
        if (appState.exportBlob) {
            appState.exportBlob = null;
            appState.previewInfo = { width: 0, height: 0, size: '' };
        }
        cropMode = 'preview';

        const blob = await new Promise(resolve => previewCanvas.toBlob(resolve));
        const url = URL.createObjectURL(blob);
        const image = document.getElementById('cropImage');
        image.src = url;

        appState.showCrop = true;
        appState.cropStatus = '請拖拽選擇要裁剪的區域';

        if (appState.cropper) appState.cropper.destroy();
        await new Promise(r => setTimeout(r, 50));

        appState.cropper = new Cropper(image, {
            viewMode: 1,
            dragMode: 'move',
            autoCropArea: 1,
            restore: false,
            guides: true,
            center: true,
            highlight: false,
            cropBoxMovable: true,
            cropBoxResizable: true,
            toggleDragModeOnDblclick: false,
        });
    },

    clearPreviewCrop(appState) {
        previewCropRect = null;
        ExportHandler.updatePreview(appState);
    }
};
