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
    const TICK_INTERVAL_MS = 200;
    // Camera điện thoại độ phân giải cao (>10MP) chụp cận màn hình LCD sẽ lộ
    // rõ từng điểm ảnh của màn hình (hiệu ứng moiré/lưới chấm dày đặc) — đã
    // xác nhận thực nghiệm điều này phá hỏng hoàn toàn threshold+segment nếu
    // xử lý ở độ phân giải gốc. Luôn resize vùng crop về độ rộng chuẩn này
    // trước khi threshold (downscale đóng vai trò lọc thông thấp, xoá nhiễu
    // lưới chấm) — không upscale nếu crop đã nhỏ hơn.
    const PROCESSING_TARGET_WIDTH = 700;

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

    /**
     * Cắt frame về đúng vùng khung ngắm NGƯỜI DÙNG NHÌN THẤY trên màn hình.
     *
     * `<video>` dùng `object-fit: cover` để hiển thị đẹp (phóng to + cắt lề),
     * nhưng canvas chụp từ videoWidth/videoHeight lại là khung hình GỐC chưa
     * cắt của camera — 2 hệ toạ độ khác nhau. Phải bù ngược lại scale/crop
     * của `cover` thì vùng cắt để xử lý mới đúng khớp với khung ngắm hiển thị
     * (nếu không, model xử lý nhầm vùng khác hẳn so với cái nhân viên đang
     * canh trên màn hình — nghi vấn chính khiến không đọc ra số trên ảnh thật).
     */
    function cropToGuideBand(frameCanvas) {
        const videoEl = document.getElementById('video');
        const guideEl = document.getElementById('guideOverlay');
        const vw = frameCanvas.width;
        const vh = frameCanvas.height;

        const videoRect = videoEl.getBoundingClientRect();
        const guideRect = guideEl.getBoundingClientRect();

        const scale = Math.max(videoRect.width / vw, videoRect.height / vh);
        const originX = videoRect.left + (videoRect.width - vw * scale) / 2;
        const originY = videoRect.top + (videoRect.height - vh * scale) / 2;

        const sx = Math.max(0, Math.round((guideRect.left - originX) / scale));
        const sy = Math.max(0, Math.round((guideRect.top - originY) / scale));
        const sw = Math.min(vw - sx, Math.round(guideRect.width / scale));
        const sh = Math.min(vh - sy, Math.round(guideRect.height / scale));

        let outW = sw, outH = sh;
        if (sw > PROCESSING_TARGET_WIDTH) {
            const ratio = PROCESSING_TARGET_WIDTH / sw;
            outW = PROCESSING_TARGET_WIDTH;
            outH = Math.round(sh * ratio);
        }

        workCanvas.width = outW;
        workCanvas.height = outH;
        const ctx = workCanvas.getContext('2d');
        ctx.drawImage(frameCanvas, sx, sy, sw, sh, 0, 0, outW, outH);
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
        processFrame,
    };
})();
