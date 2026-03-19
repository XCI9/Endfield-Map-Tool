// ─────────────────────────────────────────────
// UI text dictionary
// Centralized user-visible strings for easy edits
// ─────────────────────────────────────────────

var UIText = {
    STATUS: {
        INIT: '正在初始化... ',
        OPENCV_INITIALIZING: '⏳ OpenCV 初始化中...',
        OPENCV_INIT_FAILED: '❌ OpenCV 初始化失敗',

        BASE_MAP_NOT_LOADED: '❌ 基底地圖尚未載入',
        ORB_NOT_LOADED: '❌ ORB 指紋尚未載入，請稍候或重新選擇地圖',
        DETECTING_FEATURES: '⏳ 正在偵測截圖特徵點...',
        SCREENSHOT_FULLY_TRANSPARENT: '❌ 截圖全透明，無法偵測特徵點',
        FEATURES_NOT_ENOUGH: (count) => `❌ 截圖特徵點不足 (${count} 個)，請使用包含更多細節的截圖`,
        FEATURES_NOT_ENOUGH_AFTER_DEDUP: (count) => `❌ 截圖特徵點不足 (去重後 ${count} 個)，請使用包含更多細節的截圖`,
        MATCHING_IN_PROGRESS: (count) => `⏳ 正在比對 ${count} 個特徵點...`,
        MATCHING_NOT_ENOUGH: (count) => `❌ 匹配特徵點不足 (${count} 個)，請嘗試包含更多地圖細節的截圖`,
        RANSAC_FAILED: '❌ 無法確認截圖位置 (RANSAC 失敗)，請嘗試其他截圖',
        LOW_INLIERS_RETRY: (inliers, factor, attempt, total) => `⚠️ 內點僅 ${inliers} (<10)，改用 ${factor}x 尺寸重試 (${attempt}/${total})...`,
        LOW_INLIERS_USE_BEST: (inliers, factor) => `⚠️ 重試後內點仍偏低，採用最佳結果（inlier=${inliers}, factor=${factor}x）...`,
        MATCH_SUCCESS: (elapsed, inliers, scale) => `✅ 成功！耗時: ${elapsed}ms，內點: ${inliers}，縮放比例: ${scale.toFixed(2)}`,

        EXPORT_PREPARING: '📦 準備匯出中...',
        EXPORT_TRANSPARENT_IMAGE: '❌ 圖片全為透明，無法匯出',
        EXPORT_CROPPING: '✂️ 正在裁切圖片...',
        EXPORT_COMPRESSING: (formatName) => `💾 正在壓縮圖片 (${formatName})...`,
        EXPORT_DONE: '✅ 匯出完成，準備下載',
        EXPORT_FAILED: (message) => `❌ 匯出失敗: ${message}`,

        BASE_MAP_LOADING: (mapName) => `⏳ 載入基底地圖 ${mapName} 中...`,
        BASE_MAP_LOAD_FAILED: (mapName, file) => `❌ 無法載入基底地圖：${mapName}。請確認 ${file} 是否存在。`,
        ORB_LOADING: '⏳ 載入 ORB 指紋中...',
        BASE_MAP_LOADED: (mapName) => `✅ 基底地圖已載入：${mapName}，請上傳截圖`,
        BASE_MAP_PROCESS_FAILED: '❌ 基底地圖處理失敗，請重新整理後再試',

        FILE_NOT_IMAGE: '❌ 只支援圖片檔案',
        UNDO_DONE: '↩️ 已復原上一步操作',
    },

    CROP: {
        ADJUST_AREA: '請調整裁剪區域',
        DRAG_TO_SELECT: '請拖拽選擇要裁剪的區域',
        AREA_TOO_SMALL: '裁剪區域過小，請重新選擇。',
        ERASER_MODE: '橡皮擦模式：在圖片上拖曳即可擦除。',
        TRANSPARENT_WARNING_WITH_MAP: (ratioPercent) => `⚠️ 圖片透明區域達 ${ratioPercent}%，可能影響辨識！請盡量保留更多實體地圖畫面，或裁切掉透明區域。`,
        TRANSPARENT_WARNING_SIMPLE: (ratioPercent) => `⚠️ 圖片透明區域達 ${ratioPercent}%，可能影響辨識！請裁掉透明區域。`,
        ENHANCE_APPLIED: '已套用邊界亮度提升。',
        ENHANCE_DISABLED: '已關閉邊界亮度提升。',
        ENHANCE_DISABLED_AND_RESET: '已關閉邊界亮度提升，編輯狀態已重置。',
    },

    MODAL: {
        CONFIRM: '確認',
        CANCEL: '取消',

        SWITCH_MAP_TITLE: '確認切換地圖？',
        SWITCH_MAP_MESSAGE: '目前已有處理完成的地圖結果。切換地圖將會遺失目前的進度，是否確認切換？',
        SWITCH_MAP_CONFIRM: '確認切換',

        ENHANCE_TOGGLE_TITLE: (actionText) => `確認${actionText}功能？`,
        ENHANCE_TOGGLE_MESSAGE: (actionText) => `${actionText}此功能會重置所有編輯狀態，是否繼續`,
        ENHANCE_TOGGLE_CONFIRM: (actionText) => `確認${actionText}`,
        ACTION_ENABLE: '開啟',
        ACTION_DISABLE: '關閉',
    },
};