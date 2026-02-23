
// Worker for OpenCV Template Matching

// Load OpenCV.js
try {
    importScripts('https://docs.opencv.org/4.5.4/opencv.js');
} catch (e) {
    console.error('Failed to load opencv.js in worker', e);
}

let cvReady = false;

if (typeof cv !== 'undefined') {
    if (cv.getBuildInformation) {
        cvReady = true;
        postMessage({ type: 'cvReady' });
    } else {
        cv.onRuntimeInitialized = () => {
            cvReady = true;
            postMessage({ type: 'cvReady' });
        };
    }
}

function createMatFromData(dataObj) {
    // dataObj: { rows, cols, type, data: Uint8Array/Uint8ClampedArray }
    const mat = new cv.Mat(dataObj.rows, dataObj.cols, dataObj.type);
    mat.data.set(dataObj.data);
    return mat;
}

self.onmessage = function(e) {
    const { id, cmd, payload } = e.data;

    if (!cvReady) {
        postMessage({ type: 'error', id, error: 'OpenCV not ready in worker' });
        return;
    }

    if (cmd === 'match') {
        try {
            const results = performTemplateMatch(payload);
            postMessage({ type: 'result', id, results });
        } catch (err) {
            console.error('Worker error:', err);
            postMessage({ type: 'error', id, error: err.message });
        }
    }
};

function performTemplateMatch(payload) {
    const { 
        baseData, 
        templateData, 
        scaleDownRes, 
        roiCandidates, 
        scaleRange, 
        step 
    } = payload;

    const searchBase = createMatFromData(baseData);
    const templateImg = createMatFromData(templateData);

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

    let scalesToCheck = [];
    if (payload.scales) {
        scalesToCheck = payload.scales;
    } else {
        let s = scaleRange.min;
        while (s <= scaleRange.max) {
             scalesToCheck.push(s);
             const multiplier = 1 + Math.max(0.01, step);
             s = s * multiplier;
        }
    }

    let allResults = [];

    for (const s of scalesToCheck) {
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

    searchBase.delete();
    templateImg.delete();
    
    // roiInfo.rect is garbage collected
    
    return allResults;
}
