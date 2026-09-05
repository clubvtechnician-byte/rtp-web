/**
 * firebaseConfig.js
 * -----------------------------------------------------------------------
 * ⚠️ THAY CÁC GIÁ TRỊ BÊN DƯỚI bằng config dự án Firebase THẬT của bạn.
 *
 * Lấy config này ở đâu:
 *   1. Vào https://console.firebase.google.com → chọn (hoặc tạo) project.
 *   2. Bật Firestore Database (Build → Firestore Database → Create database,
 *      chọn "Start in production mode").
 *   3. Bật Anonymous Auth (Build → Authentication → Sign-in method →
 *      bật "Anonymous").
 *   4. Vào Project settings (icon bánh răng) → tab "General" → mục
 *      "Your apps" → bấm "</>" (Web) → đặt tên app → Firebase sẽ hiện ra
 *      đúng khối `firebaseConfig` này, copy dán đè vào bên dưới.
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
    apiKey: "REPLACE_WITH_YOUR_API_KEY",
    authDomain: "REPLACE_WITH_YOUR_PROJECT.firebaseapp.com",
    projectId: "REPLACE_WITH_YOUR_PROJECT_ID",
    storageBucket: "REPLACE_WITH_YOUR_PROJECT.appspot.com",
    messagingSenderId: "REPLACE_WITH_SENDER_ID",
    appId: "REPLACE_WITH_APP_ID"
};
