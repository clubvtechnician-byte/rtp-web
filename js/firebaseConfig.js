/**
 * firebaseConfig.js
 * -----------------------------------------------------------------------
 * Config project Firebase thật (dự án "ocr-rtp") — đã điền, không cần sửa
 * gì thêm trừ khi bạn đổi sang project Firebase khác.
 *
 * Lưu ý bảo mật: các giá trị này (apiKey, projectId...) CHỈ dùng để định
 * danh project với Firebase, không phải bí mật tuyệt đối như API key server
 * — nhưng bảo mật thật sự nằm ở Firestore Security Rules (xem file
 * `firestore.rules` cùng thư mục gốc repo) + Anonymous Auth bắt buộc.
 * KHÔNG tắt Firestore Rules / để rules "allow read, write: if true" khi
 * đã public repo lên GitHub.
 * -----------------------------------------------------------------------
 */
const FIREBASE_CONFIG = {
    apiKey: "AIzaSyCsq5-3_KVxngvhogfJACE4w2Jl-PtqMeo",
    authDomain: "ocr-rtp.firebaseapp.com",
    projectId: "ocr-rtp",
    storageBucket: "ocr-rtp.firebasestorage.app",
    messagingSenderId: "508550086071",
    appId: "1:508550086071:web:fe8d63869ac7db187cfc32"
};
