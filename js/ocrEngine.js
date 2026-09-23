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
    // Giống CameraX STRATEGY_KEEP_ONLY_LATEST: không dùng tick cố định chờ hết
    // 200ms mới xử lý tiếp (làm chậm giả tạo khi frame xử lý nhanh) — chỉ nghỉ
    // 1 khoảng ngắn để nhường event loop (UI, camera decode) rồi lấy NGAY frame
    // mới nhất hiện có xử lý tiếp. Tốc độ thực tế tự dao động theo độ phức tạp
    // của từng frame, không bị ép cứng theo 1 nhịp cố định.
    const TICK_IDLE_MS = 30;
    // An toàn: nếu 1 frame nhiễu (loá/moiré) khiến tách ra quá nhiều "ký tự" giả,
    // bỏ qua luôn thay vì tốn thời gian classify hàng trăm box rác — đây là
    // nguyên nhân chính gây "đôi lúc rất chậm" (đã quan sát thực tế).
    const MAX_CHARS_PER_FRAME = 120;
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
        // QUAN TRỌNG: phải lấy rect của thẻ <rect id="guideRect"> BÊN TRONG
        // svg, không phải thẻ <svg id="guideOverlay"> — svg cha phủ toàn bộ
        // camera (inset:0) nên getBoundingClientRect() của nó luôn bằng cả
        // khung hình, không phải đúng khung xanh nửa-phải hiển thị. Lấy nhầm
        // phần tử này khiến pipeline xử lý CẢ khung hình thay vì đúng vùng
        // khung ngắm — đã xác nhận đây là nguyên nhân không đọc ra số trên
        // ảnh thật dù ảnh chụp rất sạch.
        const guideEl = document.getElementById('guideRect');
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
        const { binMat, grayMat } = ImageProcessing.thresholdAndDedither(band);
        try {
            const rowBands = ImageProcessing.segmentRows(binMat);
            if (rowBands.length === 0) return [];

            // Tách token trước (rẻ, chỉ đếm pixel) để biết tổng số "ký tự" phát
            // hiện được trước khi tốn công cắt/resize/classify từng cái. Frame
            // nhiễu nặng (loá/moiré) có thể sinh ra hàng trăm box rác — đây là
            // nguyên nhân chính gây chậm bất thường ở một số frame.
            const rowTokens = rowBands.map((rowBand) => {
                const gapForBreak = tokenizeRows ? 10 : 100000; // step1: không tách token trong dòng
                return { rowBand, tokens: ImageProcessing.segmentCharsIntoTokens(binMat, rowBand, gapForBreak) };
            });
            const totalBoxes = rowTokens.reduce((s, r) => s + r.tokens.reduce((s2, t) => s2 + t.length, 0), 0);
            if (totalBoxes > MAX_CHARS_PER_FRAME) return [];

            // Gom toàn bộ ký tự của mọi dòng lại để classify 1 lần (batch).
            const allCharImages = [];
            // rowMeta[i] = { tokenSlots: [ [{kind:'char',batchIndex}|{kind:'dot'}, ...], ... ] }
            const rowMeta = [];

            for (const { rowBand, tokens } of rowTokens) {
                const tokenSlots = [];

                for (const token of tokens) {
                    // Model không có lớp dấu "." — đưa vào classifier sẽ bị đoán
                    // nhầm thành 1 chữ số bất kỳ (đã xác nhận thực tế trên nhiều
                    // ảnh thật: luôn lệch dấu thập phân). Nhận diện dấu chấm bằng
                    // KÍCH THƯỚC thay vì model: dấu chấm luôn thấp hơn hẳn (~50%)
                    // so với các ký tự số khác trong cùng token.
                    const heights = token.map((box) => {
                        const b = ImageProcessing.tightVerticalBounds(binMat, rowBand, box);
                        return b.y1 - b.y0;
                    });
                    const sortedHeights = [...heights].sort((a, b) => a - b);
                    const medianHeight = sortedHeights[Math.floor(sortedHeights.length / 2)] || 1;

                    const slots = token.map((box, i) => {
                        if (token.length > 1 && heights[i] < medianHeight * 0.5) {
                            return { kind: 'dot' };
                        }
                        const batchIndex = allCharImages.length;
                        allCharImages.push(ImageProcessing.cropCharForClassifier(grayMat, binMat, rowBand, box));
                        return { kind: 'char', batchIndex };
                    });
                    tokenSlots.push(slots);
                }
                rowMeta.push({ tokenSlots });
            }

            const classified = allCharImages.length ? await DigitClassifier.classifyBatch(allCharImages) : [];

            const rows = rowMeta.map(({ tokenSlots }) => {
                const tokens = tokenSlots.map((slots) => {
                    const chars = slots.map((slot) => (slot.kind === 'dot' ? { char: '.', confidence: 1 } : classified[slot.batchIndex]));
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
            grayMat.delete();
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
                if (running) loopHandle = setTimeout(tick, TICK_IDLE_MS);
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
