// Shared matching logic for both Main Thread and Worker

(function(global) {
    
    // Core template matching function
    // Depends on 'cv' being available
    function runTemplateMatch(cv, searchBase, templateImg, scaleDownRes, roiCandidates, scales) {
        let allResults = [];
        
        // Pre-process ROI candidates to avoid repeated calculations
        let roisWithType = [];
        if (!roiCandidates || roiCandidates.length === 0) {
            roisWithType.push({ rect: null }); // Full search
        } else {
            for (const cand of roiCandidates) {
                const roiX = Math.max(0, Math.round(cand.x));
                const roiY = Math.max(0, Math.round(cand.y));
                const roiW = Math.min(searchBase.cols - roiX, Math.round(cand.width));
                const roiH = Math.min(searchBase.rows - roiY, Math.round(cand.height));
                
                if (roiW > 0 && roiH > 0) {
                     roisWithType.push({ 
                         rect: new cv.Rect(roiX, roiY, roiW, roiH)
                     });
                }
            }
        }

        for (const s of scales) {
            const finalS = s * scaleDownRes;
            const newWidth = Math.round(templateImg.cols * finalS);
            const newHeight = Math.round(templateImg.rows * finalS);

            if (newWidth < 20 || newHeight < 20) {
                 continue;
            }

            const resizedSub = new cv.Mat();
            cv.resize(templateImg, resizedSub, new cv.Size(newWidth, newHeight), 0, 0, cv.INTER_AREA);

            for (const roiInfo of roisWithType) {
                let searchRoiMat;
                let roiOffsetX = 0;
                let roiOffsetY = 0;

                if (roiInfo.rect) {
                    // If the ROI is smaller than the template in any dimension, skip
                    if (roiInfo.rect.width < resizedSub.cols || roiInfo.rect.height < resizedSub.rows) {
                        continue; 
                    }
                    searchRoiMat = searchBase.roi(roiInfo.rect);
                    roiOffsetX = roiInfo.rect.x;
                    roiOffsetY = roiInfo.rect.y;
                } else {
                    searchRoiMat = searchBase;
                }

                // Ensure search area is larger or equal to template
                if (resizedSub.cols <= searchRoiMat.cols && resizedSub.rows <= searchRoiMat.rows) {
                    const res = new cv.Mat();
                    cv.matchTemplate(searchRoiMat, resizedSub, res, cv.TM_CCOEFF_NORMED);
                    const minMax = cv.minMaxLoc(res);

                    allResults.push({
                        val: minMax.maxVal,
                        loc: {
                            x: minMax.maxLoc.x + roiOffsetX,
                            y: minMax.maxLoc.y + roiOffsetY
                        },
                        scale: s
                    });
                    
                    res.delete();
                }
                
                if (roiInfo.rect) {
                     searchRoiMat.delete();
                }
            }
            
            resizedSub.delete();
        }

        return allResults;
    }

    // Expose to global scope
    global.runTemplateMatch = runTemplateMatch;

})(typeof self !== 'undefined' ? self : this);
