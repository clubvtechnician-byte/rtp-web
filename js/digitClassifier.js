/**
 * digitClassifier.js
 * -----------------------------------------------------------------------
 * Bọc onnxruntime-web để chạy `digit_model.onnx` — bản "Model 4.0", 13 lớp:
 * 0-9, dollar($), percent(%), mgmd. Lớp "mgmd" KHÔNG được dùng để định vị
 * (đã thử dùng làm mốc neo thay cho "$", nhưng kiểm chứng thực nghiệm cho
 * thấy model không phân biệt được cụm "MGMD" thật với bất kỳ token 4-box
 * nào khác — xem ghi chú trong OcrParser.js/OcrEngine.js). Mốc neo vẫn là
 * ký tự "$" như bản cũ; lớp "mgmd" hiện chỉ tồn tại trong model, không có
 * tác dụng trong pipeline.
 *
 * Input model: tensor "input" float32 [N,1,32,128] — khác bản cũ (32x32
 * vuông): giờ là khung DẸT NGANG (cao 32, rộng 128).
 * Chuẩn hoá: (pixel/255 - 0.5) / 0.5 — GIỮ NGUYÊN công thức bản cũ (xác
 * nhận qua classes.json bản cũ có ghi rõ normalization mean/std=0.5, và số
 * lượng mẫu train mỗi lớp digit 0-9 giống hệt bản cũ → cùng pipeline train,
 * chỉ đổi kích thước khung + thêm lớp mgmd). Ảnh đưa vào được letterbox
 * (giữ tỉ lệ gốc, đệm nền trắng) về đúng 128x32, xem imageProcessing.js.
 *
 * Output model: tensor "output" float32 [N,13] — logits thô, cần softmax
 * để ra xác suất/độ tin cậy.
 *
 * Dùng batch inference (gộp toàn bộ ký tự phát hiện được trong 1 khung
 * thành 1 lần gọi model) để tối ưu tốc độ thay vì gọi từng ký tự.
 * -----------------------------------------------------------------------
 */

const DigitClassifier = (() => {
    const INPUT_W = 128;
    const INPUT_H = 32;
    let session = null;
    let classes = null; // mảng ký tự hiển thị, đã map "dollar"->"$", "percent"->"%", "mgmd"->"MGMD"
    let modelName = null; // model_name khai báo trong classes.json — hiển thị nhỏ ở góc UI để biết đang chạy bản nào

    async function init(modelUrl = 'models/digit_model.onnx', classesUrl = 'models/classes.json') {
        if (ort.env && ort.env.wasm) {
            ort.env.wasm.simd = true;
            // Số luồng hợp lý cho điện thoại — tránh chiếm hết CPU khi vẫn
            // phải render camera preview song song.
            ort.env.wasm.numThreads = Math.min(4, navigator.hardwareConcurrency || 2);
        }
        session = await ort.InferenceSession.create(modelUrl, {
            executionProviders: ['wasm'],
        });
        const res = await fetch(classesUrl);
        const meta = await res.json();
        const displayMap = meta.label_display_map || {};
        classes = meta.classes.map((c) => displayMap[c] || c);
        modelName = meta.model_name || null;
    }

    function isReady() { return !!session && !!classes; }
    function getModelName() { return modelName; }

    function softmax(logits) {
        const max = Math.max(...logits);
        const exps = logits.map((v) => Math.exp(v - max));
        const sum = exps.reduce((a, b) => a + b, 0);
        return exps.map((v) => v / sum);
    }

    /**
     * @param {Float32Array[]} charImages mảng ảnh ký tự đã chuẩn hoá 32x32 (1 kênh, [-1,1])
     * @returns {{char: string, confidence: number}[]} kết quả theo đúng thứ tự đầu vào
     */
    async function classifyBatch(charImages) {
        if (!isReady()) throw new Error('DigitClassifier chưa init');
        if (charImages.length === 0) return [];

        const n = charImages.length;
        const area = INPUT_W * INPUT_H;
        const batchData = new Float32Array(n * area);
        for (let i = 0; i < n; i++) {
            batchData.set(charImages[i], i * area);
        }
        const tensor = new ort.Tensor('float32', batchData, [n, 1, INPUT_H, INPUT_W]);
        const results = await session.run({ input: tensor });
        const output = results.output; // [n, 13]
        const numClasses = output.dims[1];

        const out = [];
        for (let i = 0; i < n; i++) {
            const logits = Array.from(output.data.slice(i * numClasses, (i + 1) * numClasses));
            const probs = softmax(logits);
            let bestIdx = 0;
            for (let c = 1; c < probs.length; c++) if (probs[c] > probs[bestIdx]) bestIdx = c;
            out.push({ char: classes[bestIdx], confidence: probs[bestIdx] });
        }
        return out;
    }

    return { init, isReady, classifyBatch, getModelName };
})();
