/**
 * firebaseManager.js
 * -----------------------------------------------------------------------
 * Đồng bộ dữ liệu quét lên Firebase Firestore (cloud database) song song
 * với việc ghi CSV cục bộ (CsvManager) — để nhiều nhân viên quét trên
 * nhiều điện thoại khác nhau đều đổ dữ liệu về 1 nơi tập trung, xem được
 * theo thời gian thực trên Firebase Console hoặc 1 trang tổng hợp riêng.
 *
 * Thiết kế "best-effort, không chặn luồng chính":
 *   - Nếu chưa cấu hình Firebase (firebaseConfig.js còn để giá trị mẫu)
 *     hoặc mất mạng, toàn bộ app vẫn hoạt động bình thường với CSV cục bộ
 *     + localStorage — KHÔNG bao giờ để lỗi Firebase làm hỏng luồng quét.
 *   - Bật `enablePersistence()` của Firestore: các lệnh ghi khi mất mạng
 *     sẽ được xếp hàng trong IndexedDB của trình duyệt và tự động đồng bộ
 *     lại khi có mạng — thêm 1 lớp chống mất dữ liệu nữa ngoài CSV/localStorage.
 *
 * Cấu trúc dữ liệu Firestore:
 *   sessions/{sessionId}                     — 1 phiên làm việc
 *     ├─ fileName, createdAt, endedAt, totalMachines, deviceInfo
 *     └─ machines/{autoId}                   — 1 máy đã quét trong phiên
 *          machineId, paramX, paramY, maintenanceDate, scanTime, savedAt
 * -----------------------------------------------------------------------
 */

const FirebaseManager = (() => {
    let app = null;
    let db = null;
    let auth = null;
    let ready = false; // true khi đã init + đăng nhập ẩn danh thành công

    function isConfigured() {
        return FIREBASE_CONFIG && !String(FIREBASE_CONFIG.apiKey).startsWith('REPLACE_WITH');
    }

    /** Khởi tạo Firebase + đăng nhập ẩn danh. Không throw ra ngoài — chỉ trả về true/false. */
    async function init() {
        if (!isConfigured()) {
            console.warn('[FirebaseManager] Chưa cấu hình firebaseConfig.js — bỏ qua đồng bộ cloud.');
            return false;
        }
        try {
            app = firebase.initializeApp(FIREBASE_CONFIG);
            db = firebase.firestore();
            auth = firebase.auth();

            try {
                await db.enablePersistence({ synchronizeTabs: true });
            } catch (e) {
                // Không hỗ trợ (vd nhiều tab cùng lúc không bật synchronizeTabs, hoặc trình duyệt
                // không hỗ trợ IndexedDB) — vẫn tiếp tục hoạt động, chỉ mất tính năng cache offline.
                console.warn('[FirebaseManager] Không bật được offline persistence', e.code || e);
            }

            await auth.signInAnonymously();
            ready = true;
            return true;
        } catch (e) {
            console.error('[FirebaseManager] Khởi tạo Firebase thất bại', e);
            ready = false;
            return false;
        }
    }

    function isReady() { return ready; }

    /** Tạo document phiên làm việc mới trên Firestore. */
    async function createSessionDoc(sessionId, fileName) {
        if (!ready) return false;
        try {
            await db.collection('sessions').doc(sessionId).set({
                fileName,
                createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                totalMachines: 0,
                deviceInfo: navigator.userAgent
            });
            return true;
        } catch (e) {
            console.error('[FirebaseManager] Lỗi tạo session doc', e);
            return false;
        }
    }

    /** Đẩy 1 bản ghi máy đã quét lên subcollection machines của phiên hiện tại. */
    async function pushMachineRecord(sessionId, record) {
        if (!ready) return false;
        try {
            await db.collection('sessions').doc(sessionId).collection('machines').add({
                ...record,
                savedAt: firebase.firestore.FieldValue.serverTimestamp()
            });
            await db.collection('sessions').doc(sessionId).update({
                totalMachines: firebase.firestore.FieldValue.increment(1)
            });
            return true;
        } catch (e) {
            console.error('[FirebaseManager] Lỗi đẩy bản ghi máy lên Firestore', e);
            return false;
        }
    }

    /** Đánh dấu phiên đã kết thúc. */
    async function endSessionDoc(sessionId) {
        if (!ready) return false;
        try {
            await db.collection('sessions').doc(sessionId).update({
                endedAt: firebase.firestore.FieldValue.serverTimestamp()
            });
            return true;
        } catch (e) {
            console.error('[FirebaseManager] Lỗi đóng session doc', e);
            return false;
        }
    }

    /** Tải toàn bộ bản ghi máy của 1 phiên từ Firestore (dùng để đối chiếu/khôi phục nếu cần). */
    async function fetchSessionMachines(sessionId) {
        if (!ready) return [];
        try {
            const snap = await db.collection('sessions').doc(sessionId)
                .collection('machines').orderBy('savedAt', 'asc').get();
            return snap.docs.map(d => d.data());
        } catch (e) {
            console.error('[FirebaseManager] Lỗi tải dữ liệu phiên từ Firestore', e);
            return [];
        }
    }

    return {
        isConfigured,
        init,
        isReady,
        createSessionDoc,
        pushMachineRecord,
        endSessionDoc,
        fetchSessionMachines
    };
})();
