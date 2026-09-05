/**
 * ocrEngine.js
 * -----------------------------------------------------------------------
 * Bọc Tesseract.js (OCR chạy hoàn toàn trên trình duyệt client, WASM,
 * không cần server/API key).
 *
 * Từ bản này, OCR KHÔNG còn chạy vòng lặp liên tục theo từng khung hình nữa.
 * OCR bằng WASM mất vài trăm ms tới ~2s / khung hình, nên quét realtime vừa
 * chậm vừa nóng máy mà vẫn hay đọc trượt vì khung hình đang rung/mờ.
 * Thay vào đó: người dùng canh vào thước ngắm rồi bấm Chụp — ta chỉ chạy OCR
 * đúng 1 lần trên 1 tấm ảnh tĩnh, sắc nét, đã được cắt & làm sạch sẵn.
 */

const OcrEngine = (() => {
    let worker = null;

    async function init(onProgress) {
        // Tesseract.js v5 API (tải qua CDN, xem index.html)
        worker = await Tesseract.createWorker('eng', 1, {
            logger: onProgress || (() => {})
        });
        await worker.setParameters({
            // Giới hạn tập ký tự nhận diện để tăng tốc & giảm nhiễu — chỉ cần
            // chữ cái, số và các ký hiệu xuất hiện trong 2 màn hình OCR mục tiêu.
            tessedit_char_whitelist:
                'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.:%$ \n',
            // PSM 6 = "một khối văn bản đồng nhất". Vùng trong thước ngắm luôn là
            // vài dòng chữ nằm ngay ngắn cạnh nhau, nên chế độ này chuẩn hơn chế độ
            // tự động (PSM 3) vốn hay cố tách cột/khối không tồn tại.
            tessedit_pageseg_mode: '6'
        });
    }

    function isReady() { return worker !== null; }

    /** Nhận diện text từ 1 canvas/ảnh, trả về chuỗi text (giữ xuống dòng). */
    async function recognize(canvasOrImage) {
        if (!worker) throw new Error('OcrEngine chưa được khởi tạo');
        const { data } = await worker.recognize(canvasOrImage);
        return data.text || '';
    }

    async function terminate() {
        if (worker) {
            await worker.terminate();
            worker = null;
        }
    }

    return { init, isReady, recognize, terminate };
})();
