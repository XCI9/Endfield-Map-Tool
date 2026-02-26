// Shared matching logic for both Main Thread and Worker

(function(global) {
    
    // Core template matching function
    // Depends on 'cv' being available
    function runTemplateMatch(cv, searchBase, templateImg, scaleDownRes, roiCandidates, scales) {
        const EARLY_EXIT_THRESHOLD = 0.97; // Skip remaining scales on near-perfect match
        let allResults = [];
        let globalBestVal = -1;

        // Pre-extract ROI sub-Mats ONCE before the scale loop.
        // Previously they were created & deleted O(scales × ROIs) times;
        // now we pay that cost only O(ROIs) times.
        let roisWithType = [];
        if (!roiCandidates || roiCandidates.length === 0) {
            roisWithType.push({ rect: null, mat: searchBase, offsetX: 0, offsetY: 0 });
        } else {
            for (const cand of roiCandidates) {
                const roiX = Math.max(0, Math.round(cand.x));
                const roiY = Math.max(0, Math.round(cand.y));
                const roiW = Math.min(searchBase.cols - roiX, Math.round(cand.width));
                const roiH = Math.min(searchBase.rows - roiY, Math.round(cand.height));

                if (roiW > 0 && roiH > 0) {
                    const rect = new cv.Rect(roiX, roiY, roiW, roiH);
                    roisWithType.push({
                        rect,
                        mat: searchBase.roi(rect), // Sub-Mat pre-extracted once
                        offsetX: roiX,
                        offsetY: roiY
                    });
                }
            }
        }

        for (const s of scales) {
            if (globalBestVal >= EARLY_EXIT_THRESHOLD) break; // Near-perfect match – no point checking more scales

            const finalS = s * scaleDownRes;
            const newWidth = Math.round(templateImg.cols * finalS);
            const newHeight = Math.round(templateImg.rows * finalS);
            if (newWidth < 20 || newHeight < 20) continue;

            const resizedSub = new cv.Mat();
            cv.resize(templateImg, resizedSub, new cv.Size(newWidth, newHeight), 0, 0, cv.INTER_AREA);

            for (const roiInfo of roisWithType) {
                const searchRoiMat = roiInfo.mat; // Reuse pre-extracted sub-Mat
                // Skip if template is larger than search area in either dimension
                if (resizedSub.cols > searchRoiMat.cols || resizedSub.rows > searchRoiMat.rows) continue;

                const res = new cv.Mat();
                cv.matchTemplate(searchRoiMat, resizedSub, res, cv.TM_CCOEFF_NORMED);
                const minMax = cv.minMaxLoc(res);
                res.delete();

                if (minMax.maxVal > globalBestVal) globalBestVal = minMax.maxVal;
                allResults.push({
                    val: minMax.maxVal,
                    loc: {
                        x: minMax.maxLoc.x + roiInfo.offsetX,
                        y: minMax.maxLoc.y + roiInfo.offsetY
                    },
                    scale: s
                });
            }

            resizedSub.delete();
        }

        // Release only the sub-Mats we created; never delete searchBase itself
        for (const roiInfo of roisWithType) {
            if (roiInfo.rect) roiInfo.mat.delete();
        }

        return allResults;
    }

    // Expose to global scope
    global.runTemplateMatch = runTemplateMatch;

})(typeof self !== 'undefined' ? self : this);
