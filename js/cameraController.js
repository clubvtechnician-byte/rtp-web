/**
 * cameraController.js
 * -----------------------------------------------------------------------
 * Bọc toàn bộ logic camera: mở stream (getUserMedia), hiển thị lên <video>,
 * chụp frame vào <canvas> ẩn để đưa cho OCR, bật/tắt đèn flash (torch),
 * và cơ chế "đóng băng" preview bằng cách chụp snapshot rồi che video lại.
 */

const CameraController = (() => {
    let videoEl = null;
    let captureCanvas = null; // canvas ẩn, dùng để lấy ImageData cho OCR
    let stream = null;
    let track = null;
    let torchOn = false;
    let torchSupported = false;

    function init(videoElement, hiddenCanvasElement) {
        videoEl = videoElement;
        captureCanvas = hiddenCanvasElement;
    }

    /** Mở camera sau (environment) — phù hợp để soi vào màn hình máy. */
    async function startCamera() {
        stream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: { ideal: 'environment' },
                width: { ideal: 1280 },
                height: { ideal: 720 }
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

    /**
     * Chụp frame hiện tại của video vào canvas ẩn, trả về ImageData/canvas
     * để đưa cho OCR engine, đồng thời trả về dataURL để hiển thị khi freeze.
     */
    function captureFrame() {
        if (!videoEl || videoEl.readyState < 2) return null;
        const w = videoEl.videoWidth;
        const h = videoEl.videoHeight;
        if (!w || !h) return null;

        captureCanvas.width = w;
        captureCanvas.height = h;
        const ctx = captureCanvas.getContext('2d');
        ctx.drawImage(videoEl, 0, 0, w, h);
        return captureCanvas;
    }

    /** Lấy ảnh tĩnh (dataURL) từ canvas hiện tại — dùng để hiển thị overlay khi "đóng băng". */
    function captureFreezeFrameDataUrl() {
        const canvas = captureFrame();
        return canvas ? canvas.toDataURL('image/jpeg', 0.85) : null;
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
        captureFrame,
        captureFreezeFrameDataUrl,
        release
    };
})();
