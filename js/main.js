/**
 * main.js
 * -----------------------------------------------------------------------
 * Điều phối toàn bộ máy trạng thái (State Machine) quét 2 bước / máy,
 * nối camera + OCR + CSV manager với giao diện.
 *
 * Cách hoạt động (từ bản này): NGẮM → CHỤP → ĐỌC ẢNH.
 * Người dùng canh phần cần đọc vào trong thước ngắm rồi bấm nút Chụp; ứng
 * dụng cắt đúng vùng đó, làm sạch ảnh và chạy OCR đúng 1 lần. Cách này nhanh
 * và chắc ăn hơn hẳn việc quét liên tục 30fps như trước — Tesseract.js (WASM)
 * mất vài trăm ms tới ~2s cho mỗi khung hình, chạy liên tục vừa nóng máy vừa
 * hay đọc trượt do khung hình rung/mờ.
 *
 *   STEP1_AIMING --[📸 Chụp]--> đọc thông số --> STEP1_FROZEN
 *   STEP1_FROZEN --[Tiếp tục]--> STEP2_AIMING
 *   STEP2_AIMING --[📸 Chụp]--> đọc ngày bảo trì --> STEP2_FROZEN
 *   STEP2_FROZEN --[Xác nhận & Lưu]--> ghi CSV, tăng bộ đếm, về STEP1_AIMING
 *   (*_FROZEN) --[Chụp lại]--> *_AIMING tương ứng (xoá dữ liệu bước đó)
 *   (bất kỳ) --[🛑 Kết thúc phiên]--> SESSION_ENDED --> [Chia sẻ CSV] / [Phiên mới]
 *
 * Nếu OCR không đọc được, ứng dụng vẫn giữ nguyên ảnh vừa chụp và cho phép
 * nhập tay — người dùng đọc thẳng số trên ảnh đã đóng băng, không phải canh lại máy.
 * -----------------------------------------------------------------------
 */

const ScanStep = Object.freeze({
    STEP1_AIMING: 'STEP1_AIMING',
    STEP1_FROZEN: 'STEP1_FROZEN',
    STEP2_AIMING: 'STEP2_AIMING',
    STEP2_FROZEN: 'STEP2_FROZEN',
    SESSION_ENDED: 'SESSION_ENDED'
});

(function () {
    // ---- Tham chiếu DOM ----
    const $ = (id) => document.getElementById(id);

    const videoEl = $('video');
    const captureCanvas = $('captureCanvas');
    const viewfinderEl = $('viewfinder');
    const viewfinderLayer = $('viewfinderLayer');
    const frozenImg = $('frozenFrameImage');
    const frozenBorder = $('frozenBorder');
    const badge = $('badgeMachineNumber');
    const tvCsvFileName = $('tvCsvFileName');
    const tvScannedCount = $('tvScannedCount');
    const tvCloudStatus = $('tvCloudStatus');
    const tvScanStatus = $('tvScanStatus');
    const btnFlash = $('btnFlash');
    const btnShutter = $('btnShutter');
    const btnEndSession = $('btnEndSession');
    const btnRescan = $('btnRescan');
    const btnConfirm = $('btnConfirm');
    const etMachineId = $('etMachineId');
    const etParamX = $('etParamX');
    const etParamY = $('etParamY');
    const etMaintenanceDate = $('etMaintenanceDate');
    const postSessionPanel = $('postSessionPanel');
    const btnShareCsv = $('btnShareCsv');
    const btnNewSession = $('btnNewSession');
    const permissionOverlay = $('permissionOverlay');
    const btnGrantPermission = $('btnGrantPermission');
    const loadingOverlay = $('loadingOverlay');
    const processingOverlay = $('processingOverlay');

    let currentStep = ScanStep.STEP1_AIMING;
    let scannedCount = 0;
    let activeMachineId = '';
    let firebaseSessionId = ''; // dùng chung tên file CSV làm session id trên Firestore
    let isProcessing = false;   // chặn bấm Chụp chồng lên nhau khi đang đọc ảnh

    function pad2(n) { return String(n).padStart(2, '0'); }
    function nowScanTime() {
        const d = new Date();
        return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
    }

    // ============================== KHỞI TẠO ==============================

    let listenersAttached = false;

    async function bootstrap() {
        CameraController.init(videoEl, captureCanvas, viewfinderEl);
        if (!listenersAttached) {
            setupClickListeners();
            listenersAttached = true;
        }

        try {
            await CameraController.startCamera();
            permissionOverlay.hidden = true;
        } catch (e) {
            console.error('Không thể mở camera', e);
            permissionOverlay.hidden = false;
            return;
        }

        btnFlash.style.display = CameraController.isTorchSupported() ? '' : 'none';

        loadingOverlay.hidden = false;
        try {
            await OcrEngine.init();
        } catch (e) {
            alert('Không thể khởi tạo bộ máy OCR (Tesseract.js): ' + e.message);
        }
        loadingOverlay.hidden = true;

        await initFirebaseSync();
        await beginNewSession();
    }

    // ============================== ĐỒNG BỘ FIREBASE (tuỳ chọn) ==============================

    async function initFirebaseSync() {
        if (!FirebaseManager.isConfigured()) {
            tvCloudStatus.textContent = '☁ Firebase: chưa cấu hình (chỉ lưu CSV cục bộ)';
            tvCloudStatus.className = '';
            return;
        }
        tvCloudStatus.textContent = '☁ Đang kết nối Firebase…';
        const ok = await FirebaseManager.init();
        if (ok) {
            tvCloudStatus.textContent = '☁ Firebase: đã kết nối';
            tvCloudStatus.className = 'cloud-ok';
        } else {
            tvCloudStatus.textContent = '⚠ Firebase lỗi kết nối (vẫn lưu CSV cục bộ bình thường)';
            tvCloudStatus.className = 'cloud-error';
        }
    }

    // ============================== QUẢN LÝ PHIÊN ==============================

    async function beginNewSession() {
        const resumed = tryResumePendingSession();
        if (!resumed) {
            const fileName = await CsvManager.startNewSession();
            tvCsvFileName.textContent = fileName;
            scannedCount = 0;
            firebaseSessionId = fileName;
            if (FirebaseManager.isReady()) {
                await FirebaseManager.createSessionDoc(firebaseSessionId, fileName);
            }
        } else {
            firebaseSessionId = CsvManager.getCurrentFileName();
        }
        updateScannedCountUi();
        currentStep = ScanStep.STEP1_AIMING;
        clearAllFields();
        hideBadge();
        unfreezePreview();
        postSessionPanel.hidden = true;
        btnConfirm.textContent = 'Tiếp tục (Bước 2) ➔';
        updateStatusUi();
    }

    function tryResumePendingSession() {
        const pending = CsvManager.loadPendingSession();
        if (!pending || pending.rows.length === 0) return false;
        const ok = confirm(
            `Phát hiện phiên làm việc dở dang (${pending.rows.length} máy) từ file "${pending.fileName}".\n` +
            `Bạn có muốn khôi phục và tiếp tục phiên này không?`
        );
        if (!ok) return false;
        CsvManager.resumeSession(pending);
        tvCsvFileName.textContent = pending.fileName;
        scannedCount = pending.rows.length;
        return true;
    }

    // ============================== CHỤP & ĐỌC ẢNH ==============================

    async function onShutterClicked() {
        if (isProcessing) return;
        if (currentStep !== ScanStep.STEP1_AIMING && currentStep !== ScanStep.STEP2_AIMING) return;
        if (!OcrEngine.isReady()) {
            alert('Bộ máy OCR chưa sẵn sàng, vui lòng đợi vài giây rồi thử lại.');
            return;
        }

        const shot = CameraController.captureShot();
        if (!shot) {
            alert('Chưa lấy được hình từ camera, vui lòng thử lại.');
            return;
        }

        isProcessing = true;
        HapticUtil.vibrateTick();
        // Đóng băng ngay tấm vừa chụp để người dùng thấy đúng vùng đã được đọc
        freezePreview(shot.previewDataUrl);
        processingOverlay.hidden = false;
        setShutterEnabled(false);

        const capturedStep = currentStep;
        try {
            const result = await readShot(shot, capturedStep);
            if (capturedStep === ScanStep.STEP1_AIMING) {
                applyStep1Result(result);
            } else {
                applyStep2Result(result);
            }
        } catch (e) {
            console.error('Lỗi khi đọc ảnh', e);
            currentStep = capturedStep === ScanStep.STEP1_AIMING
                ? ScanStep.STEP1_FROZEN
                : ScanStep.STEP2_FROZEN;
            setStatus('Lỗi khi đọc ảnh: ' + e.message + ' — nhập tay hoặc bấm Chụp lại.', 'status-error');
            setActionButtonsEnabled(true);
            setShutterVisible(false);
        } finally {
            processingOverlay.hidden = true;
            isProcessing = false;
        }
    }

    /**
     * Chạy OCR trên tấm ảnh vừa chụp. Thử 2 kiểu tiền xử lý:
     *   1. auto-levels  — giữ được nét chữ, đúng cho đa số ảnh chụp màn hình
     *   2. nhị phân hoá — dự phòng khi ảnh quá tối/loá khiến lượt 1 đọc trượt
     * Chỉ chạy lượt 2 khi lượt 1 không bóc được dữ liệu, nên trường hợp thuận
     * lợi vẫn chỉ tốn đúng 1 lần OCR.
     */
    async function readShot(shot, step) {
        const parse = (text) => step === ScanStep.STEP1_AIMING
            ? OcrParser.parseStep1(text)
            : OcrParser.parseStep2(text);

        for (const mode of ['levels', 'binary']) {
            const prepared = CameraController.prepareForOcr(shot.crop, mode);
            const text = await OcrEngine.recognize(prepared);
            console.log(`[OCR/${mode}]`, text);
            const parsed = parse(text);
            if (parsed) return parsed;
        }
        return null;
    }

    function applyStep1Result(result) {
        currentStep = ScanStep.STEP1_FROZEN;
        if (result) {
            etParamX.value = result.paramX;
            etParamY.value = result.paramY;
            etMachineId.value = result.machineId;
            HapticUtil.vibrateConfirm();
            setStatus('Đã đọc được thông số. Kiểm tra rồi bấm Tiếp tục.', 'status-ok');
        } else {
            setStatus('Không đọc được thông số — nhập tay theo ảnh, hoặc bấm Chụp lại.', 'status-error');
        }
        setActionButtonsEnabled(true);
        setShutterVisible(false);
    }

    function applyStep2Result(result) {
        currentStep = ScanStep.STEP2_FROZEN;
        if (result) {
            etMaintenanceDate.value = result.maintenanceDateVi;
            HapticUtil.vibrateConfirm();
            setStatus('Đã đọc được ngày bảo trì. Kiểm tra rồi bấm Xác nhận.', 'status-ok');
        } else {
            setStatus('Không đọc được ngày bảo trì — nhập tay theo ảnh, hoặc bấm Chụp lại.', 'status-error');
        }
        setActionButtonsEnabled(true);
        setShutterVisible(false);
    }

    // ============================== ĐÓNG BĂNG / MỞ LẠI PREVIEW ==============================

    function freezePreview(dataUrl) {
        if (dataUrl) {
            frozenImg.src = dataUrl;
            frozenImg.hidden = false;
        }
        frozenBorder.hidden = false;
        viewfinderLayer.hidden = true;
    }

    function unfreezePreview() {
        frozenImg.hidden = true;
        frozenImg.removeAttribute('src');
        frozenBorder.hidden = true;
        viewfinderLayer.hidden = false;
    }

    // ============================== SỰ KIỆN CLICK ==============================

    function setupClickListeners() {
        btnGrantPermission.addEventListener('click', bootstrap);

        btnFlash.addEventListener('click', async () => {
            const on = await CameraController.toggleTorch();
            btnFlash.style.opacity = on ? '1' : '0.55';
        });

        btnShutter.addEventListener('click', onShutterClicked);
        btnEndSession.addEventListener('click', confirmEndSession);
        btnRescan.addEventListener('click', onRescanClicked);
        btnConfirm.addEventListener('click', onConfirmClicked);
        btnShareCsv.addEventListener('click', onShareCsvClicked);
        btnNewSession.addEventListener('click', beginNewSession);
    }

    function onRescanClicked() {
        if (currentStep === ScanStep.STEP1_FROZEN) {
            etMachineId.value = '';
            etParamX.value = '';
            etParamY.value = '';
            currentStep = ScanStep.STEP1_AIMING;
            unfreezePreview();
            updateStatusUi();
        } else if (currentStep === ScanStep.STEP2_FROZEN) {
            etMaintenanceDate.value = '';
            currentStep = ScanStep.STEP2_AIMING;
            unfreezePreview();
            updateStatusUi();
        }
    }

    function onConfirmClicked() {
        if (currentStep === ScanStep.STEP1_FROZEN) {
            confirmStep1();
        } else if (currentStep === ScanStep.STEP2_FROZEN) {
            confirmStep2AndSave();
        }
    }

    function confirmStep1() {
        const machineId = etMachineId.value.trim();
        const paramX = etParamX.value.trim();
        const paramY = etParamY.value.trim();

        if (!machineId || !paramX || !paramY) {
            alert('Vui lòng nhập đầy đủ và đúng định dạng dữ liệu');
            return;
        }

        activeMachineId = machineId;
        showBadge(machineId);
        etMaintenanceDate.value = '';
        btnConfirm.textContent = `Xác nhận & Lưu máy #${machineId}`;
        currentStep = ScanStep.STEP2_AIMING;
        unfreezePreview();
        updateStatusUi();
    }

    async function confirmStep2AndSave() {
        const maintenanceDate = etMaintenanceDate.value.trim();
        if (!maintenanceDate) {
            alert('Vui lòng nhập đầy đủ và đúng định dạng dữ liệu');
            return;
        }

        const record = {
            machineId: etMachineId.value.trim(),
            paramX: etParamX.value.trim(),
            paramY: etParamY.value.trim(),
            maintenanceDate,
            scanTime: nowScanTime()
        };

        const saved = await CsvManager.appendRecord(record);
        if (saved) {
            scannedCount++;
            updateScannedCountUi();
            BeepUtil.playBeep();
            HapticUtil.vibrateConfirm();
        } else {
            alert('Lỗi ghi file CSV — dữ liệu vẫn được giữ tạm, hãy thử [Chia sẻ file CSV] để tải về!');
        }

        // Đồng bộ song song lên Firebase (best-effort — không chặn/làm hỏng luồng CSV cục bộ)
        if (FirebaseManager.isReady()) {
            FirebaseManager.pushMachineRecord(firebaseSessionId, record).then((ok) => {
                tvCloudStatus.textContent = ok ? '☁ Firebase: đã đồng bộ' : '⚠ Firebase: lỗi đồng bộ máy vừa lưu';
                tvCloudStatus.className = ok ? 'cloud-ok' : 'cloud-error';
            });
        }

        // Dọn dẹp & quay về Bước 1 cho máy tiếp theo
        hideBadge();
        clearAllFields();
        btnConfirm.textContent = 'Tiếp tục (Bước 2) ➔';
        currentStep = ScanStep.STEP1_AIMING;
        unfreezePreview();
        updateStatusUi();
    }

    // ============================== KẾT THÚC PHIÊN / CHIA SẺ ==============================

    function confirmEndSession() {
        const ok = confirm(
            `Bạn đã quét tổng cộng ${scannedCount} máy trong phiên này.\n` +
            `File: ${CsvManager.getCurrentFileName()}\n\nKết thúc phiên làm việc?`
        );
        if (ok) endSession();
    }

    function endSession() {
        CsvManager.endSession();
        currentStep = ScanStep.SESSION_ENDED;
        hideBadge();
        postSessionPanel.hidden = false;
        updateStatusUi();
        if (FirebaseManager.isReady()) {
            FirebaseManager.endSessionDoc(firebaseSessionId);
        }
    }

    async function onShareCsvClicked() {
        try {
            const result = await CsvManager.shareCsv();
            if (result === 'downloaded') {
                setStatus('Đã tải file CSV xuống thư mục Downloads của trình duyệt.', 'status-ok');
            }
        } catch (e) {
            if (e.name !== 'AbortError') { // người dùng huỷ hộp thoại share -> bỏ qua, không báo lỗi
                alert('Không thể chia sẻ file: ' + e.message);
            }
        }
    }

    // ============================== CẬP NHẬT GIAO DIỆN ==============================

    function updateScannedCountUi() {
        tvScannedCount.textContent = `Đã quét: ${scannedCount} máy`;
    }

    function showBadge(machineId) {
        activeMachineId = machineId;
        badge.textContent = `Machine number: #${machineId}`;
        badge.hidden = false;
    }

    function hideBadge() {
        activeMachineId = '';
        badge.hidden = true;
    }

    function clearAllFields() {
        etMachineId.value = '';
        etParamX.value = '';
        etParamY.value = '';
        etMaintenanceDate.value = '';
    }

    function setActionButtonsEnabled(enabled) {
        btnRescan.disabled = !enabled;
        btnConfirm.disabled = !enabled;
        btnRescan.style.opacity = enabled ? '1' : '0.5';
        btnConfirm.style.opacity = enabled ? '1' : '0.5';
    }

    function setShutterVisible(visible) {
        btnShutter.hidden = !visible;
        if (visible) setShutterEnabled(true);
    }

    function setShutterEnabled(enabled) {
        btnShutter.disabled = !enabled;
    }

    function setStatus(text, cssClass) {
        tvScanStatus.textContent = text;
        tvScanStatus.className = cssClass || '';
    }

    function updateStatusUi() {
        switch (currentStep) {
            case ScanStep.STEP1_AIMING:
                setStatus('Bước 1/2 — Đưa thông số máy vào khung rồi bấm nút chụp.');
                setActionButtonsEnabled(false);
                setShutterVisible(true);
                break;
            case ScanStep.STEP1_FROZEN:
                setStatus('Đã đọc được thông số. Kiểm tra rồi bấm Tiếp tục.', 'status-ok');
                setActionButtonsEnabled(true);
                setShutterVisible(false);
                break;
            case ScanStep.STEP2_AIMING:
                setStatus(`Bước 2/2 — Đưa ngày bảo trì máy #${activeMachineId} vào khung rồi bấm nút chụp.`);
                setActionButtonsEnabled(false);
                setShutterVisible(true);
                break;
            case ScanStep.STEP2_FROZEN:
                setStatus('Đã đọc được ngày bảo trì. Kiểm tra rồi bấm Xác nhận.', 'status-ok');
                setActionButtonsEnabled(true);
                setShutterVisible(false);
                break;
            case ScanStep.SESSION_ENDED:
                setStatus('Phiên làm việc đã kết thúc.');
                setActionButtonsEnabled(false);
                setShutterVisible(false);
                break;
        }
    }

    // ============================== VÒNG ĐỜI ==============================

    window.addEventListener('beforeunload', () => {
        CameraController.release();
        OcrEngine.terminate();
    });

    // Khởi động khi DOM sẵn sàng
    document.addEventListener('DOMContentLoaded', bootstrap);
})();
