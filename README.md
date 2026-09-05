# RTP OCR Scanner — bản Web (chạy trong trình duyệt)

Bản web tương đương app Android, chạy hoàn toàn ở phía client (không cần server/backend
riêng) — dùng camera của điện thoại/máy tính qua trình duyệt, OCR bằng
[Tesseract.js](https://github.com/naptha/tesseract.js) (WASM, chạy on-device trong trình duyệt),
lưu CSV cục bộ + đồng bộ song song lên **Firebase Firestore** (tuỳ chọn), host miễn phí trên
**GitHub Pages**.

## 1. Cấu trúc

Đây là project độc lập, tách riêng khỏi bản Android (xem repo `rtp-android` cạnh repo này).
Gốc repo = gốc trang web luôn (không có thư mục `web/` lồng bên trong):

```
.
├── index.html            # Bố cục chia đôi màn hình (camera trên / dữ liệu dưới)
├── css/style.css         # Giao diện theme tối, giống bản Android
├── js/
│   ├── ocrParser.js       # Regex bóc tách Bước 1 & Bước 2 (port từ ScreenParser.kt)
│   ├── csvManager.js      # Quản lý phiên + ghi CSV (File System Access API / localStorage)
│   ├── cameraController.js # getUserMedia, chụp frame, torch, freeze snapshot
│   ├── ocrEngine.js       # Bọc Tesseract.js thành vòng lặp nhận diện liên tục
│   ├── firebaseConfig.js  # ⚠️ Nơi bạn dán config project Firebase của mình
│   ├── firebaseManager.js # Đồng bộ dữ liệu quét lên Firestore (song song với CSV)
│   ├── util.js            # Haptic (Vibration API) + tiếng bíp (Web Audio API)
│   └── main.js            # State machine + điều phối toàn bộ UI (tương đương MainActivity.kt)
├── firestore.rules                    # Rules bảo mật Firestore — dán vào Firebase Console
└── .github/workflows/deploy-pages.yml # Tự động deploy lên GitHub Pages khi push
```

## 2. Chạy thử cục bộ (trước khi deploy)

Trình duyệt **chặn `getUserMedia` (camera)** nếu trang không chạy trên `https://` hoặc
`http://localhost` — mở trực tiếp file `index.html` (giao thức `file://`) sẽ **không** xin
được quyền camera. Cần chạy qua 1 server tĩnh đơn giản:

```bash
# Cách 1: Python (có sẵn trên hầu hết máy) — chạy ngay tại thư mục gốc repo này
python -m http.server 8080

# Cách 2: Node.js
npx serve . -l 8080
```

Sau đó mở `http://localhost:8080`. Khi chưa cấu hình Firebase, app vẫn chạy đầy đủ 100%
chức năng quét + CSV cục bộ — góc trên bên trái sẽ hiện dòng "☁ Firebase: chưa cấu hình".

## 3. Triển khai Production: GitHub Pages (host) + Firebase (database)

### 3.1. Tạo project Firebase (bắt buộc phải làm bằng tài khoản Google của bạn)

1. Vào **[console.firebase.google.com](https://console.firebase.google.com)** → **Add project**
   → đặt tên (vd `rtp-ocr-scanner`) → tạo xong.
2. Menu trái → **Build → Firestore Database** → **Create database** → chọn 1 region gần VN
   (vd `asia-southeast1`) → **Start in production mode**.
3. Menu trái → **Build → Authentication** → tab **Sign-in method** → bật **Anonymous**.
   (App dùng đăng nhập ẩn danh để Firestore Rules biết request đến từ app hợp lệ, không cần
   nhân viên phải đăng nhập tài khoản gì cả — hoàn toàn tự động phía sau).
4. Vào **Project settings** (icon bánh răng, góc trên trái) → tab **General** → cuộn xuống
   **Your apps** → bấm icon **`</>`** (Web) → đặt nickname bất kỳ → **Register app**.
   Firebase sẽ hiện ra 1 khối `firebaseConfig = {...}` — copy toàn bộ khối đó.
5. Mở [`js/firebaseConfig.js`](js/firebaseConfig.js), dán đè lên `FIREBASE_CONFIG`.
6. Vào tab **Firestore Database → Rules**, xoá hết nội dung mặc định, dán nội dung file
   [`firestore.rules`](firestore.rules) ở thư mục gốc repo vào, bấm **Publish**.

> Bỏ qua bước này nếu bạn chỉ cần bản CSV cục bộ — app vẫn hoạt động đầy đủ, chỉ là không có
> bản sao tập trung trên cloud để nhiều máy cùng đồng bộ về 1 chỗ.

### 3.2. Đẩy code lên GitHub

```bash
# Từ thư mục gốc repo này (D:\Huy\rtp-web)
git remote add origin https://github.com/<username>/<ten-repo>.git
git branch -M main
git push -u origin main
```

(Repo cần ở chế độ **Public** để dùng GitHub Pages miễn phí, trừ khi bạn có gói GitHub Pro/Team/Enterprise.)

### 3.3. Bật GitHub Pages

Trên GitHub: **Settings → Pages → Build and deployment → Source: chọn "GitHub Actions"**.

Workflow [`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml) đã có sẵn
trong repo — mỗi lần `git push` vào nhánh `main`, GitHub tự động build & deploy toàn bộ repo
(vì giờ gốc repo = gốc site). Theo dõi tiến trình ở tab **Actions** của repo. Sau khi chạy xong
(khoảng 30s-1p), trang sẽ có tại:

```
https://<username>.github.io/<ten-repo>/
```

GitHub Pages tự phục vụ qua **HTTPS** — giải quyết luôn yêu cầu bảo mật `getUserMedia`
(camera) mà không cần localhost/server riêng.

### 3.4. Cập nhật sau này

Mỗi khi sửa code, chỉ cần:

```bash
git add -A
git commit -m "Mô tả thay đổi"
git push
```

GitHub Actions sẽ tự deploy lại, không cần thao tác thủ công gì thêm.

## 4. Quy trình quét — giống hệt bản Android

Xem chi tiết trong `js/main.js` (đầu file có sơ đồ state machine). Quy trình 2 bước / máy,
freeze preview, badge `Machine number: #ZZ`, đếm số máy, ghi CSV, kết thúc phiên + chia sẻ —
đều được giữ nguyên logic. Nếu đã cấu hình Firebase, mỗi lần **Xác nhận & Lưu máy #ZZ** sẽ
đồng thời đẩy bản ghi lên Firestore (collection `sessions/{tên_file_csv}/machines/`) — xem
được real-time trong Firebase Console → Firestore Database → Data, hoặc query lại bằng
`FirebaseManager.fetchSessionMachines(sessionId)` để build 1 trang tổng hợp riêng nếu cần.

## 5. Khác biệt so với bản Android (do giới hạn của trình duyệt)

| Tính năng | Android (native) | Web |
|---|---|---|
| OCR engine | ML Kit (native, rất nhanh) | Tesseract.js (WASM, chậm hơn — mỗi frame mất ~0.3-2s tuỳ máy) |
| Tốc độ quét | ~30fps phân tích liên tục | Quét theo kiểu "xong khung này chụp khung mới nhất" (xem `ocrEngine.js`) — không thật sự 30fps nhưng vẫn "gần thời gian thực" |
| Flash/Torch | Luôn có nếu máy có đèn | Chỉ hoạt động trên **Chrome Android** (Safari iOS và Chrome desktop không hỗ trợ bật torch qua Web API) — nút Flash tự ẩn nếu trình duyệt không hỗ trợ |
| Rung (Haptic) | Luôn có | **Không hoạt động trên Safari/iOS** (Apple không hỗ trợ Vibration API); hoạt động tốt trên Chrome Android |
| Ghi CSV tức thì xuống đĩa | File API ghi trực tiếp | Chỉ **Chrome/Edge (desktop & Android)** hỗ trợ ghi trực tiếp liên tục xuống 1 file đã chọn (`File System Access API`). Các trình duyệt khác (Safari, Firefox): dữ liệu được giữ trong bộ nhớ + tự động sao lưu vào `localStorage` sau mỗi lần lưu máy (khôi phục lại được nếu tab bị đóng đột ngột), người dùng bấm **[Chia sẻ file CSV]** để tải file hoặc gửi qua Web Share API |
| Chia sẻ file | Intent `ACTION_SEND` (mọi app) | `navigator.share()` với file đính kèm — hoạt động trên Chrome Android, Safari iOS 15+; trên desktop thường không hỗ trợ chia sẻ file nên sẽ tự động tải file CSV xuống thay thế |
| Database tập trung | Không có (chỉ CSV/máy) | **Firebase Firestore** (tuỳ chọn, xem mục 3.1) — nhiều điện thoại cùng đổ dữ liệu về 1 nơi theo thời gian thực |

## 6. Lưu ý về Regex OCR

Giống hệt cảnh báo trong bản Android: `ocrParser.js` bám sát ví dụ trong đặc tả (dòng
`0.000%` cuối cùng → 2 dòng % kế tiếp là X/Y → số nguyên trước `$` là Machine ID; chuỗi
ngày `Mon 23 Mar 2026 07:50:05`). **Cần thử với ảnh/video thật của màn hình máy** để tinh
chỉnh lại các regex trong `ocrParser.js` nếu bố cục thực tế khác — đặc biệt Tesseract.js có
thể tách dòng khác với ML Kit nên độ chính xác OCR có thể cần thêm bước tiền xử lý ảnh
(crop vùng quan tâm, tăng tương phản) để cải thiện — có thể bổ sung sau trong `cameraController.js`
(hàm `captureFrame`) bằng cách crop `captureCanvas` về đúng vùng màn hình máy trước khi đưa
cho `OcrEngine.recognize()`.

## 7. Bảo mật Firebase — những điều cần nhớ

- `firebaseConfig.js` (apiKey, projectId...) sẽ **công khai** trong code JS phía client sau khi
  deploy lên GitHub Pages (repo public) — đây là chuyện **bình thường** với Firebase Web SDK,
  không phải rò rỉ bí mật. Lớp bảo mật thật sự nằm ở **Firestore Rules** (`firestore.rules`).
- Rules mặc định trong repo yêu cầu `request.auth != null` (đã có qua Anonymous Auth) — chặn
  người lạ trên Internet đọc/ghi tuỳ ý dù họ biết `projectId`. Vẫn còn giới hạn: **bất kỳ ai
  mở được trang web của bạn** cũng coi như "đã đăng nhập ẩn danh" và ghi được dữ liệu — phù hợp
  cho công cụ nội bộ (nhân viên trong công ty dùng), nhưng nếu deploy dạng public hoàn toàn
  không kiểm soát ai truy cập, cân nhắc thêm Firebase Auth (email/password) + custom claims để
  giới hạn đúng nhóm nhân viên được ghi dữ liệu.
- Theo dõi usage ở Firebase Console → **Usage and billing** để tránh vượt free tier (Spark
  plan) nếu quét số lượng máy rất lớn mỗi ngày.

## 8. Có thể nâng cấp thêm (không bắt buộc)

- Biến thành PWA (thêm `manifest.json` + Service Worker) để cài lên màn hình chính điện thoại
  và chạy được cả khi mất mạng (Tesseract.js model có thể cache lại).
- Cho phép người dùng vẽ khung ROI (Region of Interest) để crop đúng vùng % và ngày bảo trì
  trước khi OCR — tăng tốc độ và độ chính xác đáng kể so với quét toàn khung hình.
- Thêm 1 trang admin riêng (vd `admin.html`) query toàn bộ `sessions/*/machines` trên
  Firestore để xem tổng hợp nhiều phiên/nhiều nhân viên cùng lúc, xuất Excel tổng.
