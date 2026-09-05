/**
 * main.js
 * -----------------------------------------------------------------------
 * Điều phối toàn bộ máy trạng thái (State Machine) quét 2 bước / máy,
 * nối camera + OCR realtime + CSV manager với giao diện.
 *
 * Máy trạng thái (giống hệt bản Android — xem ScanStep.kt):
 *
 *   STEP1_SCANNING --(bắt đủ X, Y, ZZ)--> STEP1_FROZEN
 *   STEP1_FROZEN --[Tiếp tục quét ngày bảo trì]--> STEP2_SCANNING
 *   STEP2_SCANNING --(bắt được ngày)--> STEP2_FROZEN
 *   STEP2_FROZEN --[Xác nhận & Lưu]--> ghi CSV, tăng bộ đếm, quay lại STEP1_SCANNING
 *   (*_FROZEN) --[Quét lại]--> *_SCANNING tương ứng (xoá dữ liệu bước đó)
 *   (bất kỳ) --[🛑 Kết thúc phiên]--> SESSION_ENDED --> hiện [Chia sẻ CSV] / [Phiên mới]
 * -----------------------------------------------------------------------
 */

const ScanStep = Object.freeze({
    STEP1_SCANNING: 'STEP1_SCANNING',
    STEP1_FROZEN: 'STEP1_FROZEN',
    STEP2_SCANNING: 'STEP2_SCANNING',
    STEP2_FROZEN: 'STEP2_FROZEN',
    SESSION_ENDED: 'SESSION_ENDED'
});

(function () {
    // ---- Tham chiếu DOM ----
    const $ = (id) => document.getElementById(id);

    const videoEl = $('video');
    const captureCanvas = $('captureCanvas');
    const frozenImg = $('frozenFrameImage');
    const frozenBorder = $('frozenBorder');
    const badge = $('badgeMachineNumber');
    const tvCsvFileName = $('tvCsvFileName');
    const tvScannedCount = $('tvScannedCount');
    const tvCloudStatus = $('tvCloudStatus');
    const tvScanStatus = $('tvScanStatus');
    const btnFlash = $('btnFlash');
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

    let currentStep = ScanStep.STEP1_SCANNING;
    let scannedCount = 0;
    let activeMachineId = '';
    let firebaseSessionId = ''; // dùng chung tên file CSV làm session id trên Firestore

    function pad2(n) { return String(n).padStart(2, '0'); }
    function nowScanTime() {
        const d = new Date();
        return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
    }

    // ============================== KHỞI TẠO ==============================

    let listenersAttached = false;

    async function bootstrap() {
        CameraController.init(videoEl, captureCanvas);
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

        OcrEngine.startLoop(
            () => CameraController.captureFrame(),
            (text) => handleOcrResult(text)
        );
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
        currentStep = ScanStep.STEP1_SCANNING;
        clearAllFields();
        hideBadge();
        unfreezePreview();
        postSessionPanel.hidden = true;
        btnConfirm.textContent = 'Tiếp tục quét ngày bảo trì ➔';
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

    // ============================== XỬ LÝ KẾT QUẢ OCR ==============================

    function handleOcrResult(text) {
        if (currentStep === ScanStep.STEP1_SCANNING) {
            const result = OcrParser.parseStep1(text);
            if (result) onStep1Captured(result.paramX, result.paramY, result.machineId);
        } else if (currentStep === ScanStep.STEP2_SCANNING) {
            const result = OcrParser.parseStep2(text);
            if (result) onStep2Captured(result.maintenanceDateVi);
        }
        // STEP1_FROZEN / STEP2_FROZEN / SESSION_ENDED: bỏ qua kết quả frame này.
    }

    function onStep1Captured(paramX, paramY, machineId) {
        freezePreview();
        etParamX.value = paramX;
        etParamY.value = paramY;
        etMachineId.value = machineId;
        HapticUtil.vibrateTick();
        currentStep = ScanStep.STEP1_FROZEN;
        updateStatusUi();
    }

    function onStep2Captured(maintenanceDateVi) {
        freezePreview();
        etMaintenanceDate.value = maintenanceDateVi;
        HapticUtil.vibrateTick();
        currentStep = ScanStep.STEP2_FROZEN;
        updateStatusUi();
    }

    // ============================== ĐÓNG BĂNG / MỞ LẠI PREVIEW ==============================

    function freezePreview() {
        OcrEngine.setPaused(true);
        const dataUrl = CameraController.captureFreezeFrameDataUrl();
        if (dataUrl) {
            frozenImg.src = dataUrl;
            frozenImg.hidden = false;
        }
        frozenBorder.hidden = false;
    }

    function unfreezePreview() {
        frozenImg.hidden = true;
        frozenImg.removeAttribute('src');
        frozenBorder.hidden = true;
        OcrEngine.setPaused(false);
    }

    // ============================== SỰ KIỆN CLICK ==============================

    function setupClickListeners() {
        btnGrantPermission.addEventListener('click', bootstrap);

        btnFlash.addEventListener('click', async () => {
            const on = await CameraController.toggleTorch();
            btnFlash.style.opacity = on ? '1' : '0.55';
        });

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
            currentStep = ScanStep.STEP1_SCANNING;
            unfreezePreview();
            updateStatusUi();
        } else if (currentStep === ScanStep.STEP2_FROZEN) {
            etMaintenanceDate.value = '';
            currentStep = ScanStep.STEP2_SCANNING;
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
        currentStep = ScanStep.STEP2_SCANNING;
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

        // Bước 3: dọn dẹp & quay về Bước 1 cho máy tiếp theo
        hideBadge();
        clearAllFields();
        btnConfirm.textContent = 'Tiếp tục quét ngày bảo trì ➔';
        currentStep = ScanStep.STEP1_SCANNING;
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
        OcrEngine.setPaused(true);
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
                tvScanStatus.textContent = 'Đã tải file CSV xuống thư mục Downloads của trình duyệt.';
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

    function updateStatusUi() {
        switch (currentStep) {
            case ScanStep.STEP1_SCANNING:
                tvScanStatus.textContent = 'Bước 1/2 — Đang quét thông số máy…';
                setActionButtonsEnabled(false);
                break;
            case ScanStep.STEP1_FROZEN:
                tvScanStatus.textContent = 'Đã bắt được thông số. Kiểm tra và bấm Tiếp tục.';
                setActionButtonsEnabled(true);
                break;
            case ScanStep.STEP2_SCANNING:
                tvScanStatus.textContent = `Bước 2/2 — Đang quét ngày bảo trì máy #${activeMachineId}…`;
                setActionButtonsEnabled(false);
                break;
            case ScanStep.STEP2_FROZEN:
                tvScanStatus.textContent = 'Đã bắt được ngày bảo trì. Kiểm tra và bấm Xác nhận.';
                setActionButtonsEnabled(true);
                break;
            case ScanStep.SESSION_ENDED:
                tvScanStatus.textContent = 'Phiên làm việc đã kết thúc.';
                setActionButtonsEnabled(false);
                break;
        }
    }

    // ============================== VÒNG ĐỜI ==============================

    window.addEventListener('beforeunload', () => {
        CameraController.release();
        OcrEngine.stopLoop();
    });

    // Khởi động khi DOM sẵn sàng
    document.addEventListener('DOMContentLoaded', bootstrap);
})();
