/**
 * ocrEngine.js
 * -----------------------------------------------------------------------
 * Thay thế bản Tesseract.js cũ — pipeline nhanh dùng model số tự train:
 * threshold+dedither (ImageProcessing) -> tách dòng/ký tự -> batch qua
 * DigitClassifier (onnxruntime-web) -> trả về DÒNG/TOKEN đã nhận diện cho
 * OcrParser xử lý tiếp (anchor-"$" ở Bước 1, ngày/năm ở Bước 2).
 *
 * Tối ưu tốc độ:
 *  - Chỉ xử lý dải giữa khung ngắm (GUIDE_BAND), không xử lý cả frame.
 *  - Chạy pipeline nặng theo nhịp throttle (~200ms), không phải mỗi frame video.
 *  - Gộp toàn bộ ký tự phát hiện được trong 1 khung thành 1 lần gọi model
 *    (batch inference) thay vì gọi từng ký tự.
 * -----------------------------------------------------------------------
 */

const OcrEngine = (() => {
    // Tỉ lệ dải khung ngắm (khớp 2 đường ngang overlay trong CSS/SVG).
    const GUIDE_BAND = { yStart: 0.30, yEnd: 0.70 };
    const TICK_INTERVAL_MS = 200;

    let running = false;
    let paused = false;
    let loopHandle = null;
    let liveFilterEnabled = false;

    const workCanvas = document.createElement('canvas');

    async function init() {
        await ImageProcessing.waitForOpenCv();
        await DigitClassifier.init();
    }

    function setLiveFilterEnabled(value) { liveFilterEnabled = value; }
    function isLiveFilterEnabled() { return liveFilterEnabled; }

    /** Cắt frame về đúng dải khung ngắm, trả về canvas mới (dùng cho cả xử lý và live filter). */
    function cropToGuideBand(frameCanvas) {
        const w = frameCanvas.width;
        const h = frameCanvas.height;
        const y0 = Math.round(h * GUIDE_BAND.yStart);
        const y1 = Math.round(h * GUIDE_BAND.yEnd);
        workCanvas.width = w;
        workCanvas.height = y1 - y0;
        const ctx = workCanvas.getContext('2d');
        ctx.drawImage(frameCanvas, 0, y0, w, y1 - y0, 0, 0, w, y1 - y0);
        return workCanvas;
    }

    /**
     * Xử lý 1 khung hình, trả về danh sách "dòng" (mỗi dòng có thể chứa
     * nhiều token nếu tokenizeRows=true, dùng cho màn ngày).
     */
    async function processFrame(frameCanvas, { tokenizeRows } = { tokenizeRows: false }) {
        const band = cropToGuideBand(frameCanvas);
        const binMat = ImageProcessing.thresholdAndDedither(band);
        try {
            const rowBands = ImageProcessing.segmentRows(binMat);
            if (rowBands.length === 0) return [];

            // Gom toàn bộ ký tự của mọi dòng lại để classify 1 lần (batch).
            const allCharImages = [];
            // rowMeta[i] = { tokenRanges: [{start,end}] } chỉ số vào allCharImages
            const rowMeta = [];

            for (const rowBand of rowBands) {
                const gapForBreak = tokenizeRows ? 10 : 100000; // step1: không tách token trong dòng
                const tokens = ImageProcessing.segmentCharsIntoTokens(binMat, rowBand, gapForBreak);
                const tokenRanges = [];
                for (const token of tokens) {
                    const start = allCharImages.length;
                    for (const box of token) {
                        allCharImages.push(ImageProcessing.cropCharTo64(binMat, rowBand, box));
                    }
                    tokenRanges.push({ start, end: allCharImages.length });
                }
                rowMeta.push({ tokenRanges });
            }

            if (allCharImages.length === 0) return [];
            const classified = await DigitClassifier.classifyBatch(allCharImages);

            const rows = rowMeta.map(({ tokenRanges }) => {
                const tokens = tokenRanges.map(({ start, end }) => {
                    const chars = classified.slice(start, end);
                    const text = chars.map((c) => c.char).join('');
                    const meanConfidence = chars.length
                        ? chars.reduce((s, c) => s + c.confidence, 0) / chars.length
                        : 0;
                    return { text, meanConfidence };
                });
                const text = tokens.map((t) => t.text).join('');
                const meanConfidence = tokens.length
                    ? tokens.reduce((s, t) => s + t.meanConfidence, 0) / tokens.length
                    : 0;
                return { text, meanConfidence, tokens };
            });

            return rows;
        } finally {
            binMat.delete();
        }
    }

    /**
     * @param {() => HTMLCanvasElement|null} getFrame
     * @param {() => 'step1'|'step2'} getStep
     * @param {(rows: any[], step: string) => void} onResult
     * @param {(filteredCanvas: HTMLCanvasElement) => void} [onLiveFilterFrame] gọi mỗi lần có bản lọc live (nếu bật)
     */
    function startLoop(getFrame, getStep, onResult, onLiveFilterFrame) {
        running = true;
        paused = false;

        const previewCanvas = document.createElement('canvas');

        const tick = async () => {
            if (!running) return;
            if (paused) { loopHandle = setTimeout(tick, 150); return; }

            try {
                const frame = getFrame();
                if (frame) {
                    if (liveFilterEnabled && onLiveFilterFrame) {
                        const band = cropToGuideBand(frame);
                        previewCanvas.width = band.width;
                        previewCanvas.height = band.height;
                        ImageProcessing.liveThresholdPreview(band, previewCanvas);
                        onLiveFilterFrame(previewCanvas);
                    }

                    const step = getStep();
                    const rows = await processFrame(frame, { tokenizeRows: step === 'step2' });
                    if (!paused) onResult(rows, step);
                }
            } catch (e) {
                console.error('Lỗi xử lý khung hình', e);
            } finally {
                if (running) loopHandle = setTimeout(tick, TICK_INTERVAL_MS);
            }
        };
        tick();
    }

    function setPaused(value) { paused = value; }
    function isPaused() { return paused; }
    function stopLoop() { running = false; if (loopHandle) clearTimeout(loopHandle); }

    return {
        init, startLoop, stopLoop, setPaused, isPaused,
        setLiveFilterEnabled, isLiveFilterEnabled,
        processFrame, GUIDE_BAND,
    };
})();
