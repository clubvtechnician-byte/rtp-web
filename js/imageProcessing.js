/**
 * imageProcessing.js
 * -----------------------------------------------------------------------
 * Xử lý ảnh bằng OpenCV.js, thay thế Tesseract.js — chuẩn bị dữ liệu cho
 * DigitClassifier (model số tự train), theo đúng logic đã mô tả:
 *
 *   Bước 1: Adaptive threshold cục bộ (blockSize=21, C=12) ép nền về trắng.
 *   Bước 2: Tẩy hạt dither bằng connected-components + overlap mask với
 *           nét chữ gốc (opening rồi dilate nhẹ để lấy "lõi nét chữ",
 *           thành phần liên thông nào không chạm lõi này bị loại).
 *   Bước 3: Tách dòng bằng horizontal projection profile.
 *   Bước 4: Tách ký tự trong từng dòng bằng vertical projection profile,
 *           gom thành "token" (cụm ký tự liền nhau, cách nhau bởi khoảng
 *           trắng lớn = ranh giới token — dùng cho màn ngày có nhiều cụm
 *           trên 1 dòng: "Sat 24 Jan 2026 08:07:32").
 *
 * Toàn bộ chạy client-side bằng OpenCV.js (WASM), không gửi ảnh lên server.
 * -----------------------------------------------------------------------
 */

const ImageProcessing = (() => {
    let cvReady = false;

    /**
     * Chờ OpenCV.js sẵn sàng. Dùng đúng hook chuẩn `cv.onRuntimeInitialized`
     * của emscripten thay vì chỉ poll `cv.Mat` (poll đơn thuần không đủ tin
     * cậy — quan sát thực tế trên iOS Safari bị timeout dù script đã tải
     * xong, WASM vẫn đang compile/instantiate). Vẫn giữ poll làm phương án
     * dự phòng, tăng timeout lên 45s cho lần tải đầu trên mạng di động.
     */
    function waitForOpenCv(timeoutMs = 45000) {
        return new Promise((resolve, reject) => {
            const start = Date.now();
            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                cvReady = true;
                resolve();
            };

            (function poll() {
                if (settled) return;
                if (typeof cv !== 'undefined' && cv.Mat) {
                    finish();
                    return;
                }
                if (typeof cv !== 'undefined' && !cv.Mat && typeof cv.onRuntimeInitialized !== 'function' && !cv.__hookedByApp) {
                    // `cv` tồn tại nhưng WASM chưa init xong -> gắn hook chính thức.
                    cv.__hookedByApp = true;
                    const prev = cv.onRuntimeInitialized;
                    cv.onRuntimeInitialized = () => {
                        if (typeof prev === 'function') prev();
                        finish();
                    };
                }
                if (Date.now() - start > timeoutMs) {
                    reject(new Error('OpenCV.js không tải được (timeout) — kiểm tra kết nối mạng rồi thử lại'));
                    return;
                }
                setTimeout(poll, 150);
            })();
        });
    }

    function isReady() { return cvReady; }

    /**
     * Threshold rẻ, dùng cho "live filter" hiển thị mượt trên liveview
     * (không chạy dedither/segment nặng — chỉ để nhân viên thấy ảnh sạch
     * hay nhiễu mà tự canh chỉnh).
     * @param {HTMLCanvasElement} srcCanvas
     * @param {HTMLCanvasElement} outCanvas vẽ kết quả ra đây
     */
    function liveThresholdPreview(srcCanvas, outCanvas) {
        const src = cv.imread(srcCanvas);
        const gray = new cv.Mat();
        cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
        const bin = new cv.Mat();
        cv.adaptiveThreshold(
            gray, bin, 255,
            cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY,
            21, 12
        );
        cv.imshow(outCanvas, bin);
        src.delete(); gray.delete(); bin.delete();
    }

    /**
     * Threshold + dedither đầy đủ, trả về Mat nhị phân (text=255 trắng,
     * nền=0 đen) đã tẩy hạt dither. CALLER PHẢI tự .delete() Mat trả về.
     */
    function thresholdAndDedither(srcCanvas) {
        const src = cv.imread(srcCanvas);
        const gray = new cv.Mat();
        cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

        // Bước 1: adaptive threshold — nền về trắng (255), chữ tối hơn.
        const bin = new cv.Mat();
        cv.adaptiveThreshold(
            gray, bin, 255,
            cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY,
            21, 12
        );

        // Đảo âm bản: chữ = trắng (255) trên nền đen (0), chuẩn cho
        // connectedComponents (mong đợi foreground trắng).
        const inv = new cv.Mat();
        cv.bitwise_not(bin, inv);

        // Bước 2: "lõi nét chữ" — opening (erode rồi dilate) để loại pixel
        // lẻ (dither 1-2px), sau đó dilate thêm 1 lần để tạo dung sai —
        // bất kỳ thành phần liên thông nào không chạm lõi này là rác.
        const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(2, 2));
        const core = new cv.Mat();
        cv.morphologyEx(inv, core, cv.MORPH_OPEN, kernel);
        const coreDilated = new cv.Mat();
        const dilateKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
        cv.dilate(core, coreDilated, dilateKernel);

        const labels = new cv.Mat();
        const stats = new cv.Mat();
        const centroids = new cv.Mat();
        const numLabels = cv.connectedComponentsWithStats(inv, labels, stats, centroids, 8, cv.CV_32S);

        const cleaned = new cv.Mat.zeros(inv.rows, inv.cols, cv.CV_8UC1);
        const labelData = labels.data32S;
        const coreData = coreDilated.data;
        // Với mỗi label (bỏ qua 0 = nền), kiểm tra có chạm coreDilated không.
        const touchesCore = new Uint8Array(numLabels);
        for (let i = 0; i < labelData.length; i++) {
            const lbl = labelData[i];
            if (lbl === 0) continue;
            if (coreData[i] > 0) touchesCore[lbl] = 1;
        }
        const cleanedData = cleaned.data;
        const invData = inv.data;
        for (let i = 0; i < labelData.length; i++) {
            const lbl = labelData[i];
            if (lbl !== 0 && touchesCore[lbl]) {
                cleanedData[i] = invData[i];
            }
        }

        src.delete(); gray.delete(); bin.delete(); inv.delete();
        kernel.delete(); core.delete(); coreDilated.delete(); dilateKernel.delete();
        labels.delete(); stats.delete(); centroids.delete();

        return cleaned; // text=255 trắng trên nền đen, caller tự .delete()
    }

    /**
     * Tách dòng bằng horizontal projection profile.
     * @param {cv.Mat} binMat ảnh nhị phân (text=255) từ thresholdAndDedither
     * @param {number} minRowHeight bỏ qua dải quá mỏng (nhiễu)
     * @returns {{y0:number, y1:number}[]} danh sách dải hàng theo thứ tự trên->dưới
     */
    function segmentRows(binMat, minRowHeight = 8) {
        const rows = binMat.rows, cols = binMat.cols;
        const data = binMat.data;
        const rowSum = new Int32Array(rows);
        for (let y = 0; y < rows; y++) {
            let sum = 0;
            const base = y * cols;
            for (let x = 0; x < cols; x++) sum += data[base + x] > 0 ? 1 : 0;
            rowSum[y] = sum;
        }
        // Ngưỡng theo tỉ lệ chiều rộng (không dùng "1 pixel là tính có chữ")
        // để chống nhiễu moiré/JPEG còn sót lại sau dedither — vài pixel lẻ
        // trôi nổi không đủ để nối 2 dòng thật lại thành 1 khối.
        const threshold = Math.max(2, Math.round(cols * 0.01));
        const bands = [];
        let inBand = false, y0 = 0;
        for (let y = 0; y < rows; y++) {
            const active = rowSum[y] >= threshold;
            if (active && !inBand) { inBand = true; y0 = y; }
            if (!active && inBand) {
                inBand = false;
                if (y - y0 >= minRowHeight) bands.push({ y0, y1: y });
            }
        }
        if (inBand && rows - y0 >= minRowHeight) bands.push({ y0, y1: rows });
        return bands;
    }

    /**
     * Tách ký tự trong 1 dải hàng bằng vertical projection profile, gom
     * thành token (cụm ký tự cách nhau khoảng trắng lớn = ranh giới token).
     * @param {cv.Mat} binMat ảnh nhị phân toàn khung
     * @param {{y0:number,y1:number}} band dải hàng cần tách
     * @returns {{tokens: {x0:number,x1:number}[][]}} mảng token, mỗi token là mảng bbox ký tự {x0,x1} (dùng chung y0,y1 của band)
     */
    function segmentCharsIntoTokens(binMat, band, gapForTokenBreak = 10) {
        const cols = binMat.cols;
        const data = binMat.data;
        const colSum = new Int32Array(cols);
        for (let x = 0; x < cols; x++) {
            let sum = 0;
            for (let y = band.y0; y < band.y1; y++) {
                sum += data[y * cols + x] > 0 ? 1 : 0;
            }
            colSum[x] = sum;
        }
        // Tìm các dải cột có chữ (ký tự), rồi gom theo khoảng cách. Cùng lý do
        // chống nhiễu như segmentRows — không dùng "1 pixel là tính có chữ".
        const bandHeight = band.y1 - band.y0;
        const colThreshold = Math.max(2, Math.round(bandHeight * 0.05));
        const charBoxes = [];
        let inChar = false, x0 = 0;
        for (let x = 0; x < cols; x++) {
            const active = colSum[x] >= colThreshold;
            if (active && !inChar) { inChar = true; x0 = x; }
            if (!active && inChar) {
                inChar = false;
                charBoxes.push({ x0, x1: x });
            }
        }
        if (inChar) charBoxes.push({ x0, x1: cols });

        // Gom charBoxes thành token theo khoảng cách giữa 2 box liên tiếp.
        const tokens = [];
        let current = [];
        for (let i = 0; i < charBoxes.length; i++) {
            if (current.length === 0) {
                current.push(charBoxes[i]);
                continue;
            }
            const prev = current[current.length - 1];
            const gap = charBoxes[i].x0 - prev.x1;
            if (gap > gapForTokenBreak) {
                tokens.push(current);
                current = [charBoxes[i]];
            } else {
                current.push(charBoxes[i]);
            }
        }
        if (current.length > 0) tokens.push(current);

        return tokens;
    }

    /**
     * Crop 1 ký tự từ binMat, pad về hình vuông rồi resize 64x64 —
     * trả về Float32Array 64*64 giá trị [0,1] (1 = nét chữ, 0 = nền),
     * đúng format input model (grayscale, chuẩn hoá 0-1).
     */
    function cropCharTo64(binMat, band, box) {
        const rect = new cv.Rect(box.x0, band.y0, box.x1 - box.x0, band.y1 - band.y0);
        const charMat = binMat.roi(rect);

        const side = Math.max(charMat.rows, charMat.cols);
        const pad = Math.round(side * 0.15); // biên đệm nhẹ giống cách train thường dùng
        const squareSide = side + pad * 2;
        const square = new cv.Mat.zeros(squareSide, squareSide, cv.CV_8UC1);
        const xOff = Math.floor((squareSide - charMat.cols) / 2);
        const yOff = Math.floor((squareSide - charMat.rows) / 2);
        const roiTarget = square.roi(new cv.Rect(xOff, yOff, charMat.cols, charMat.rows));
        charMat.copyTo(roiTarget);
        roiTarget.delete();

        const resized = new cv.Mat();
        cv.resize(square, resized, new cv.Size(64, 64), 0, 0, cv.INTER_AREA);

        // TODO: xác nhận lại cách chuẩn hoá pixel [0,1] khớp với lúc train
        // model (best_model_64x64.pth / digit_model_64x64.onnx). Nếu độ
        // chính xác thực tế thấp bất thường, thử đổi sang 0-255 thô hoặc
        // chuẩn hoá mean/std khác ở đây.
        const out = new Float32Array(64 * 64);
        for (let i = 0; i < out.length; i++) out[i] = resized.data[i] / 255;

        charMat.delete(); square.delete(); resized.delete();
        return out;
    }

    return {
        waitForOpenCv,
        isReady,
        liveThresholdPreview,
        thresholdAndDedither,
        segmentRows,
        segmentCharsIntoTokens,
        cropCharTo64,
    };
})();
