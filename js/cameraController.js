/**
 * cameraController.js
 * -----------------------------------------------------------------------
 * Bọc toàn bộ logic camera: mở stream (getUserMedia), hiển thị lên <video>,
 * bật/tắt đèn flash (torch), và — quan trọng nhất — CHỤP đúng vùng nằm
 * trong thước ngắm rồi tiền xử lý ảnh trước khi đưa cho OCR.
 *
 * Vì OCR giờ chỉ chạy 1 lần mỗi lần bấm nút Chụp (không còn quét liên tục
 * 30fps), ta có "ngân sách" thời gian rộng rãi để xử lý ảnh cho thật sạch:
 * cắt đúng vùng ngắm → phóng to → xám hoá → auto-levels (kéo giãn tương phản).
 * Ảnh vào Tesseract sạch hơn ⇒ đọc nhanh hơn và chính xác hơn nhiều so với
 * việc ném nguyên khung hình màu 1280×720 vào như trước.
 */

const CameraController = (() => {
    let videoEl = null;
    let captureCanvas = null;  // canvas ẩn, giữ nguyên khung hình gốc
    let viewfinderEl = null;   // phần tử DOM của thước ngắm (để tính vùng cắt)
    let stream = null;
    let track = null;
    let torchOn = false;
    let torchSupported = false;

    // Bề ngang ảnh đưa vào Tesseract. Vùng ngắm thường nhỏ hơn con số này nên
    // ảnh sẽ được PHÓNG TO — chữ to hơn thì Tesseract đọc chuẩn hơn hẳn.
    const OCR_TARGET_WIDTH = 900;

    function init(videoElement, hiddenCanvasElement, viewfinderElement) {
        videoEl = videoElement;
        captureCanvas = hiddenCanvasElement;
        viewfinderEl = viewfinderElement || null;
    }

    /** Mở camera chính (camera sau) — phù hợp để soi vào màn hình máy. */
    async function startCamera() {
        stream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: { ideal: 'environment' },
                width: { ideal: 1920 },
                height: { ideal: 1080 }
            },
            audio: false
        });
        videoEl.srcObject = stream;
        await videoEl.play();

        track = stream.getVideoTracks()[0];
        try {
            const capabilities = track.getCapabilities ? track.getCapabilities() : {};
            torchSupported = !!capabilities.torch;
        } catch (e) {
            torchSupported = false;
        }
    }

    function isTorchSupported() { return torchSupported; }

    /** Bật/tắt đèn flash. Trả về trạng thái mới (hoặc false nếu thiết bị không hỗ trợ). */
    async function toggleTorch() {
        if (!track || !torchSupported) return false;
        try {
            torchOn = !torchOn;
            await track.applyConstraints({ advanced: [{ torch: torchOn }] });
            return torchOn;
        } catch (e) {
            console.error('Lỗi bật/tắt flash', e);
            torchOn = false;
            return false;
        }
    }

    // ====================== CHỤP & CẮT THEO THƯỚC NGẮM ======================

    /**
     * Quy đổi hình chữ nhật thước ngắm (toạ độ trên màn hình) về toạ độ pixel
     * thật của khung hình camera.
     *
     * <video> đang dùng `object-fit: cover` nên ảnh bị phóng to & cắt bớt để
     * lấp đầy khung — phải bù lại đúng hệ số scale và phần lề bị tràn ra ngoài,
     * nếu không vùng OCR sẽ lệch so với vùng người dùng nhìn thấy trong thước ngắm.
     */
    function getViewfinderSourceRect() {
        const vw = videoEl.videoWidth;
        const vh = videoEl.videoHeight;
        if (!vw || !vh) return null;

        // Không có thước ngắm → lấy nguyên khung hình
        if (!viewfinderEl) return { sx: 0, sy: 0, sw: vw, sh: vh };

        const videoRect = videoEl.getBoundingClientRect();
        const finderRect = viewfinderEl.getBoundingClientRect();
        if (!videoRect.width || !videoRect.height || !finderRect.width || !finderRect.height) {
            return { sx: 0, sy: 0, sw: vw, sh: vh };
        }

        // object-fit: cover ⇒ scale = max, ảnh tràn ra ngoài khung theo 1 chiều
        const scale = Math.max(videoRect.width / vw, videoRect.height / vh);
        const displayedW = vw * scale;
        const displayedH = vh * scale;
        const originX = videoRect.left + (videoRect.width - displayedW) / 2;
        const originY = videoRect.top + (videoRect.height - displayedH) / 2;

        let sx = (finderRect.left - originX) / scale;
        let sy = (finderRect.top - originY) / scale;
        let sw = finderRect.width / scale;
        let sh = finderRect.height / scale;

        // Kẹp lại trong biên khung hình để drawImage không nhận vùng âm/vượt biên
        sx = Math.max(0, Math.min(vw - 1, sx));
        sy = Math.max(0, Math.min(vh - 1, sy));
        sw = Math.max(1, Math.min(vw - sx, sw));
        sh = Math.max(1, Math.min(vh - sy, sh));

        return { sx, sy, sw, sh };
    }

    /**
     * Chụp 1 khung hình tại thời điểm gọi và cắt lấy đúng vùng thước ngắm.
     * @returns {{crop: HTMLCanvasElement, previewDataUrl: string}|null}
     */
    function captureShot() {
        if (!videoEl || videoEl.readyState < 2) return null;
        const vw = videoEl.videoWidth;
        const vh = videoEl.videoHeight;
        if (!vw || !vh) return null;

        // 1. Đóng băng khung hình gốc vào canvas ẩn
        captureCanvas.width = vw;
        captureCanvas.height = vh;
        captureCanvas.getContext('2d').drawImage(videoEl, 0, 0, vw, vh);

        // 2. Cắt đúng vùng thước ngắm, đồng thời phóng về OCR_TARGET_WIDTH
        const rect = getViewfinderSourceRect();
        const zoom = OCR_TARGET_WIDTH / rect.sw;
        const crop = document.createElement('canvas');
        crop.width = Math.round(rect.sw * zoom);
        crop.height = Math.round(rect.sh * zoom);

        const ctx = crop.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(
            captureCanvas,
            rect.sx, rect.sy, rect.sw, rect.sh,
            0, 0, crop.width, crop.height
        );

        return { crop, previewDataUrl: crop.toDataURL('image/jpeg', 0.9) };
    }

    // ====================== TIỀN XỬ LÝ ẢNH CHO OCR ======================

    /**
     * Chuẩn bị ảnh cho Tesseract.
     * @param {HTMLCanvasElement} srcCanvas ảnh đã cắt theo thước ngắm
     * @param {'levels'|'binary'} mode
     *        - 'levels': xám hoá + auto-levels (kéo giãn tương phản) — dùng cho lượt đọc đầu
     *        - 'binary': xám hoá + nhị phân hoá Otsu — lượt đọc dự phòng khi lượt đầu thất bại
     */
    function prepareForOcr(srcCanvas, mode = 'levels') {
        const out = document.createElement('canvas');
        out.width = srcCanvas.width;
        out.height = srcCanvas.height;
        const ctx = out.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(srcCanvas, 0, 0);

        const imageData = ctx.getImageData(0, 0, out.width, out.height);
        const data = imageData.data;

        // Xám hoá (luminosity) + dựng histogram trong cùng 1 lượt duyệt
        const histogram = new Uint32Array(256);
        for (let i = 0; i < data.length; i += 4) {
            const gray = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000 | 0;
            data[i] = data[i + 1] = data[i + 2] = gray;
            histogram[gray]++;
        }

        const totalPixels = data.length / 4;
        const lut = (mode === 'binary')
            ? buildOtsuLut(histogram, totalPixels)
            : buildAutoLevelsLut(histogram, totalPixels);

        for (let i = 0; i < data.length; i += 4) {
            const v = lut[data[i]];
            data[i] = data[i + 1] = data[i + 2] = v;
        }

        ctx.putImageData(imageData, 0, 0);
        return out;
    }

    /**
     * Auto-levels: bỏ 2% pixel tối nhất và 2% sáng nhất rồi kéo giãn phần còn
     * lại ra full 0-255. Ảnh chụp màn hình máy thường bị "xám xịt" do phản
     * quang/độ sáng nền — bước này làm chữ bật hẳn lên mà không phá nét như
     * việc nhân thẳng hệ số tương phản.
     */
    function buildAutoLevelsLut(histogram, totalPixels) {
        const cut = Math.max(1, Math.floor(totalPixels * 0.02));

        let low = 0, acc = 0;
        for (let v = 0; v < 256; v++) {
            acc += histogram[v];
            if (acc >= cut) { low = v; break; }
        }
        let high = 255;
        acc = 0;
        for (let v = 255; v >= 0; v--) {
            acc += histogram[v];
            if (acc >= cut) { high = v; break; }
        }

        // Ảnh gần như một màu → giữ nguyên, kéo giãn sẽ chỉ khuếch đại nhiễu
        if (high - low < 16) { low = 0; high = 255; }

        const range = high - low;
        const lut = new Uint8ClampedArray(256);
        for (let v = 0; v < 256; v++) {
            lut[v] = Math.max(0, Math.min(255, Math.round((v - low) * 255 / range)));
        }
        return lut;
    }

    /**
     * Nhị phân hoá Otsu: tự tìm ngưỡng đen/trắng tối ưu từ histogram.
     * Dùng làm lượt đọc dự phòng — ảnh chỉ còn đen & trắng nên Tesseract rất
     * dễ tách chữ, đổi lại có thể mất nét ở vùng chữ mảnh/mờ.
     */
    function buildOtsuLut(histogram, totalPixels) {
        let sum = 0;
        for (let v = 0; v < 256; v++) sum += v * histogram[v];

        let sumBackground = 0;
        let weightBackground = 0;
        let maxVariance = -1;
        let threshold = 128;

        for (let v = 0; v < 256; v++) {
            weightBackground += histogram[v];
            if (weightBackground === 0) continue;
            const weightForeground = totalPixels - weightBackground;
            if (weightForeground === 0) break;

            sumBackground += v * histogram[v];
            const meanBackground = sumBackground / weightBackground;
            const meanForeground = (sum - sumBackground) / weightForeground;
            const variance = weightBackground * weightForeground *
                (meanBackground - meanForeground) * (meanBackground - meanForeground);

            if (variance > maxVariance) {
                maxVariance = variance;
                threshold = v;
            }
        }

        const lut = new Uint8ClampedArray(256);
        for (let v = 0; v < 256; v++) lut[v] = v > threshold ? 255 : 0;
        return lut;
    }

    function release() {
        try {
            if (torchOn && track) {
                track.applyConstraints({ advanced: [{ torch: false }] }).catch(() => {});
            }
            if (stream) {
                stream.getTracks().forEach(t => t.stop());
            }
        } catch (e) {
            console.error('Lỗi giải phóng camera', e);
        }
    }

    return {
        init,
        startCamera,
        isTorchSupported,
        toggleTorch,
        captureShot,
        prepareForOcr,
        release
    };
})();
