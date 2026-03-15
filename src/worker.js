
// Worker for OpenCV Template Matching

// Load OpenCV.js and Shared Logic
try {
    importScripts('../assets/vendor/opencv.js');
    importScripts('match-logic.js');
} catch (e) {
    console.error('Failed to load scripts in worker', e);
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
        baseAlphaMaskData,
        templateData,
        maskData,
        scaleDownRes,
        roiCandidates,
        scaleRange,
        step
    } = payload;

    const searchBase = createMatFromData(baseData);
    const searchBaseAlphaMask = baseAlphaMaskData ? createMatFromData(baseAlphaMaskData) : null;
    const templateImg = createMatFromData(templateData);
    const templateMask = maskData ? createMatFromData(maskData) : null;
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

    if (!self.runTemplateMatch) {
         throw new Error("runTemplateMatch not loaded");
    }

const allResults = self.runTemplateMatch(cv, searchBase, templateImg, scaleDownRes, roiCandidates, scalesToCheck, templateMask, searchBaseAlphaMask);

    searchBase.delete();
    if (searchBaseAlphaMask) searchBaseAlphaMask.delete();
    templateImg.delete();
    if (templateMask) templateMask.delete();
    
    return allResults;
}
