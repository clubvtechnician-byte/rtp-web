/**
 * digitClassifier.js
 * -----------------------------------------------------------------------
 * Bọc onnxruntime-web để chạy model digit_model_64x64.onnx (Model 1.2,
 * "10-Segments Drop") — classifier 64x64, 13 lớp: 0-9, %, $, .
 *
 * Input model: tensor "input" float32 [N,1,64,64] (đã xác nhận qua kiểm
 * tra trực tiếp model, N = batch động).
 * Output model: tensor "output" float32 [N,13] — logits thô, cần softmax
 * để ra xác suất/độ tin cậy.
 *
 * Dùng batch inference (gộp toàn bộ ký tự phát hiện được trong 1 khung
 * thành 1 lần gọi model) để tối ưu tốc độ thay vì gọi từng ký tự.
 * -----------------------------------------------------------------------
 */

const DigitClassifier = (() => {
    let session = null;
    let labels = null;

    async function init(modelUrl = 'models/digit_model_64x64.onnx', labelsUrl = 'models/labels.json') {
        if (ort.env && ort.env.wasm) {
            ort.env.wasm.simd = true;
            // Số luồng hợp lý cho điện thoại — tránh chiếm hết CPU khi vẫn
            // phải render camera preview song song.
            ort.env.wasm.numThreads = Math.min(4, navigator.hardwareConcurrency || 2);
        }
        session = await ort.InferenceSession.create(modelUrl, {
            executionProviders: ['wasm'],
        });
        const res = await fetch(labelsUrl);
        labels = await res.json();
    }

    function isReady() { return !!session && !!labels; }

    function softmax(logits) {
        const max = Math.max(...logits);
        const exps = logits.map((v) => Math.exp(v - max));
        const sum = exps.reduce((a, b) => a + b, 0);
        return exps.map((v) => v / sum);
    }

    /**
     * @param {Float32Array[]} charImages mảng ảnh ký tự đã chuẩn hoá 64x64 (1 kênh, [0,1])
     * @returns {{char: string, confidence: number}[]} kết quả theo đúng thứ tự đầu vào
     */
    async function classifyBatch(charImages) {
        if (!isReady()) throw new Error('DigitClassifier chưa init');
        if (charImages.length === 0) return [];

        const n = charImages.length;
        const batchData = new Float32Array(n * 64 * 64);
        for (let i = 0; i < n; i++) {
            batchData.set(charImages[i], i * 64 * 64);
        }
        const tensor = new ort.Tensor('float32', batchData, [n, 1, 64, 64]);
        const results = await session.run({ input: tensor });
        const output = results.output; // [n, 13]
        const numClasses = output.dims[1];

        const out = [];
        for (let i = 0; i < n; i++) {
            const logits = Array.from(output.data.slice(i * numClasses, (i + 1) * numClasses));
            const probs = softmax(logits);
            let bestIdx = 0;
            for (let c = 1; c < probs.length; c++) if (probs[c] > probs[bestIdx]) bestIdx = c;
            out.push({ char: labels[bestIdx], confidence: probs[bestIdx] });
        }
        return out;
    }

    return { init, isReady, classifyBatch };
})();
