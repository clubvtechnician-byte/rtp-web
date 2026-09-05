/**
 * ocrEngine.js
 * -----------------------------------------------------------------------
 * Bọc Tesseract.js (OCR chạy hoàn toàn trên trình duyệt client, WASM,
 * không cần server/API key) thành 1 vòng lặp nhận diện liên tục.
 *
 * Vì OCR bằng WASM chậm hơn nhiều so với ML Kit/Vision native (thường
 * mất vài trăm ms tới ~1-2s / frame tuỳ máy), ta KHÔNG cố ép chạy đúng
 * 30fps như CameraX. Thay vào đó, vòng lặp hoạt động theo kiểu
 * "xử lý xong khung hình này thì chụp ngay khung hình mới nhất rồi xử lý
 * tiếp" — tương đương chiến lược STRATEGY_KEEP_ONLY_LATEST của CameraX,
 * tự động bỏ qua các khung hình dư thừa trong lúc đang bận.
 */

const OcrEngine = (() => {
    let worker = null;
    let running = false;
    let paused = false;
    let loopHandle = null;

    async function init(onProgress) {
        // Tesseract.js v5 API (tải qua CDN, xem index.html)
        worker = await Tesseract.createWorker('eng', 1, {
            logger: onProgress || (() => {})
        });
        // Giới hạn tập ký tự nhận diện để tăng tốc & giảm nhiễu — chỉ cần
        // chữ cái, số và các ký hiệu xuất hiện trong 2 màn hình OCR mục tiêu.
        await worker.setParameters({
            tessedit_char_whitelist:
                'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.:%$ \n'
        });
    }

    /** Nhận diện text từ 1 canvas/ảnh, trả về chuỗi text (giữ xuống dòng). */
    async function recognize(canvasOrImage) {
        if (!worker) throw new Error('OcrEngine chưa được khởi tạo');
        const { data } = await worker.recognize(canvasOrImage);
        return data.text || '';
    }

    /**
     * Bắt đầu vòng lặp nhận diện liên tục.
     * @param {() => (HTMLCanvasElement|null)} getFrame hàm chụp khung hình mới nhất
     * @param {(text: string) => void} onResult callback khi có kết quả OCR (chạy dù rỗng)
     */
    function startLoop(getFrame, onResult) {
        running = true;
        paused = false;

        const tick = async () => {
            if (!running) return;
            if (paused) {
                loopHandle = setTimeout(tick, 150);
                return;
            }
            try {
                const frame = getFrame();
                if (frame) {
                    const text = await recognize(frame);
                    if (!paused) onResult(text);
                }
            } catch (e) {
                console.error('Lỗi nhận diện OCR', e);
            } finally {
                if (running) {
                    loopHandle = setTimeout(tick, 60); // nghỉ ngắn giữa 2 lần để không "đơ" UI thread
                }
            }
        };
        tick();
    }

    function setPaused(value) { paused = value; }
    function isPaused() { return paused; }

    function stopLoop() {
        running = false;
        if (loopHandle) clearTimeout(loopHandle);
    }

    async function terminate() {
        stopLoop();
        if (worker) {
            await worker.terminate();
            worker = null;
        }
    }

    return { init, recognize, startLoop, stopLoop, setPaused, isPaused, terminate };
})();
