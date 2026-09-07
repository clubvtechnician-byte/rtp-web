# RTP OCR Scanner (Web) — Mô tả kỹ thuật

> Tài liệu này mô tả **bản web**, dùng để nhờ người khác tư vấn.
> Bản Android native (repo `rtp-android`) là bản chính, chạy tốt — bản web là
> phương án chạy trên mọi máy không cài được APK.

- Repo: https://github.com/clubvtechnician-byte/rtp-web
- Live: https://clubvtechnician-byte.github.io/rtp-web/
- Kiến trúc: 100% client-side, không có backend riêng.

---

## 1. Bài toán

Kỹ thuật viên đi kiểm tra từng máy slot trong club. Mỗi máy phải ghi lại 4 dữ liệu
đọc từ **màn hình LCD của máy**:

| Trường | Ví dụ | Nguồn trên màn hình máy |
|---|---|---|
| `Machine_ID` | `12` | Số nguyên đứng ngay trước dấu `$` |
| `Param_X` | `92.734` | Giá trị `%` thứ nhất sau dòng `0.000%` |
| `Param_Y` | `93.63` | Giá trị `%` thứ hai sau dòng `0.000%` |
| `Maintenance_Date` | `23/03/2026` | `Mon 23 Mar 2026 07:50:05` → bỏ thứ & giờ |

Mỗi phiên làm việc quét vài chục máy, xuất ra 1 file CSV.

Ràng buộc thực địa: chụp **màn hình phát sáng** bằng camera điện thoại → ảnh
thường bị moiré (sọc/lưới RGB), loá, và nghiêng.

---

## 2. Stack

| Thành phần | Lựa chọn |
|---|---|
| OCR | Tesseract.js v5 (WASM, on-device) qua jsDelivr CDN |
| Camera | `getUserMedia` + `<video>` |
| Xử lý ảnh | Canvas 2D thuần (không dùng thư viện) |
| Lưu file | File System Access API, fallback `<a download>` / Web Share API |
| Cloud | Firebase Firestore + Anonymous Auth (compat SDK 10.13.2) |
| UI | HTML/CSS/JS thuần, không framework, không build step |
| Hosting | GitHub Pages qua GitHub Actions |

Không có bước build: repo push lên là chạy.

---

## 3. Thay đổi kiến trúc quan trọng nhất

**Bản đầu:** OCR chạy vòng lặp liên tục trên từng khung hình camera (mô phỏng
`ImageAnalysis` của bản Android).

**Vấn đề:** Tesseract.js là WASM chạy trên luồng JS — mất ~0,5–2s cho mỗi khung
hình *toàn màn hình màu*. Máy nóng, UI giật, và tỉ lệ đọc trượt cao vì phần lớn
khung hình bị rung/mờ/lệch nét. Bản Android dùng ML Kit (C++ native, tăng tốc
phần cứng) nên cùng cách làm lại chạy tốt — kết luận: **không thể bê nguyên
kiến trúc realtime từ native sang WASM**.

**Bản hiện tại:** đổi sang **ngắm → chụp → đọc**.

```
Preview camera (không OCR, mượt)
   ↓ người dùng canh vào thước ngắm, bấm nút chụp
Cắt đúng vùng thước ngắm  ──► phóng to 900px ──► xám hoá + auto-levels
   ↓
OCR 1 lần  ──►  regex bóc tách
   ↓ nếu bóc không ra
OCR lần 2 trên ảnh nhị phân hoá Otsu
   ↓
Điền form + đóng băng ảnh để người dùng đối chiếu
```

Đổi lại: mỗi máy tốn 2 lần bấm chụp thay vì tự động. Trong thực tế đây lại là
điểm cộng — kỹ thuật viên chủ động canh khung, không phải đứng chờ.

---

## 4. Máy trạng thái (`js/main.js`)

```
STEP1_AIMING  --[📸]--> đọc thông số  --> STEP1_FROZEN
STEP1_FROZEN  --[Tiếp tục]---------->     STEP2_AIMING
STEP2_AIMING  --[📸]--> đọc ngày BT   --> STEP2_FROZEN
STEP2_FROZEN  --[Xác nhận & Lưu]----->    ghi CSV + đẩy Firestore --> STEP1_AIMING
(*_FROZEN)    --[Chụp lại]---------->     *_AIMING (xoá dữ liệu bước đó)
(bất kỳ)      --[Kết thúc phiên]----->    SESSION_ENDED
```

**Khi OCR đọc trượt, app vẫn chuyển sang `*_FROZEN`** và giữ nguyên ảnh vừa
chụp. Người dùng đọc số thẳng trên ảnh đó rồi gõ tay — không phải canh lại máy.
Đây là quyết định UX có chủ ý: đọc trượt là chuyện thường, nên nó phải là một
nhánh bình thường của luồng chứ không phải trạng thái lỗi.

---

## 5. Cắt đúng vùng thước ngắm (`js/cameraController.js`)

Chỉ vùng nằm trong thước ngắm (280×315 CSS px, co lại theo màn hình nhỏ) được
đưa vào OCR. `<video>` dùng `object-fit: cover` nên khung hình bị phóng và cắt
lề — phải bù ngược lại, nếu không vùng OCR sẽ **lệch so với vùng người dùng nhìn thấy**:

```js
const scale   = Math.max(videoRect.width / vw, videoRect.height / vh);
const originX = videoRect.left + (videoRect.width  - vw * scale) / 2;
const originY = videoRect.top  + (videoRect.height - vh * scale) / 2;

sx = (finderRect.left - originX) / scale;
sy = (finderRect.top  - originY) / scale;
sw = finderRect.width  / scale;
sh = finderRect.height / scale;
```

Vùng cắt sau đó được **phóng to** về bề ngang 900px (`OCR_TARGET_WIDTH`), không
phải thu nhỏ. Tesseract đọc chuẩn hơn khi chữ cao khoảng 30–40px, nên downscale
để "cho nhanh" là phản tác dụng — cắt hẹp lại mới là thứ giảm thời gian.

---

## 6. Tiền xử lý ảnh

Một lượt duyệt pixel duy nhất vừa xám hoá (luminosity `0.299R + 0.587G + 0.114B`)
vừa dựng histogram, rồi áp một bảng tra (LUT) 256 phần tử. Hai chế độ:

**`levels` — auto-levels (mặc định).** Bỏ 2% pixel tối nhất và 2% sáng nhất, kéo
giãn phần còn lại ra full 0–255. Ảnh chụp màn hình máy hay bị "xám xịt" do
phản quang; cách này làm chữ bật lên mà không phá nét như nhân thẳng hệ số
tương phản. Có chốt an toàn: nếu `high - low < 16` (ảnh gần như một màu) thì bỏ
qua, tránh khuếch đại nhiễu.

**`binary` — nhị phân hoá Otsu (dự phòng).** Tự tìm ngưỡng đen/trắng tối ưu từ
histogram. Chỉ chạy khi lượt `levels` bóc không ra dữ liệu.

**Đã thử và bỏ:** median filter 3×3 để khử moiré. Trong JS thuần nó tốn ~1–3s
cho ảnh cỡ này — đắt hơn cả bản thân bước OCR, không đáng.

Cách xử lý moiré hiện tại là **hướng dẫn thao tác**: chụp chếch 30–45° thay vì
vuông góc, và tăng độ sáng màn hình máy.

---

## 7. Bóc tách dữ liệu (`js/ocrParser.js`)

Port 1-1 từ `ScreenParser.kt` của bản Android.

**Bước 1:** tìm dòng `0%`/`0.000%` **cuối cùng** → gom toàn bộ text phía sau
thành một cụm → lấy 2 giá trị `%` đầu tiên làm X, Y → tìm số nguyên đứng trước `$`
làm Machine ID.

**Bước 2:** regex `(Mon|Tue|…|Sun) DD (Jan|…|Dec) YYYY HH:MM:SS`, bỏ thứ và
giờ, đổi tháng chữ sang số.

**Một khác biệt riêng của bản web:** Tesseract rất hay đọc `12$` thành `12%`
(ML Kit trên bản Android không mắc lỗi này). Luật "số đứng trước `$`" vì thế
trượt dù ảnh rất rõ. Đã thêm nhánh dự phòng: khi **không tìm thấy `$` nào**,
lấy số nguyên đầu tiên nằm sau giá trị Y — đúng vị trí Machine ID trên màn hình.
Nhánh này chỉ chạy khi luật gốc thất bại nên không đổi hành vi cũ.

---

## 8. Lưu CSV (`js/csvManager.js`)

Tên file: `DD_MM_YYYY_HH_mm_ss.csv` (thời điểm mở phiên).
Header: `Machine_ID,Param_X,Param_Y,Maintenance_Date,Scan_Time`, xuống dòng CRLF.

Hai lớp chống mất dữ liệu:

1. **File System Access API** (Chrome/Edge, Chrome Android): người dùng chọn nơi
   lưu **một lần** đầu phiên. Mỗi lần lưu một máy → `createWritable()` **ghi đè
   lại toàn bộ nội dung** file. Trình duyệt không cho append, nên đây là cách ghi
   xuống đĩa ngay lập tức duy nhất. Với vài chục dòng thì chi phí không đáng kể.
2. **localStorage** (`rtp_ocr_current_session`): luôn mirror toàn bộ phiên sau
   mỗi lần lưu. Mở lại trang sau khi crash → app hỏi có khôi phục phiên dở dang không.

`fileHandle` **không** phục hồi được qua reload (giới hạn bảo mật của trình
duyệt) — phiên khôi phục chỉ còn tải file thủ công.

Trình duyệt không hỗ trợ (Safari, Firefox): giữ trong bộ nhớ + localStorage,
xuất qua Web Share API hoặc `<a download>`.

---

## 9. Đồng bộ Firestore (`js/firebaseManager.js`)

```
sessions/{fileName}
  ├─ fileName, createdAt, endedAt, totalMachines, deviceInfo
  └─ machines/{autoId}
       machineId, paramX, paramY, maintenanceDate, scanTime, savedAt
```

Thiết kế **best-effort, không chặn luồng chính**: luôn ghi CSV cục bộ trước,
đẩy Firestore song song. Firebase lỗi hay mất mạng đều không ảnh hưởng việc quét.
Bật `enablePersistence({ synchronizeTabs: true })` để lệnh ghi lúc mất mạng xếp
hàng trong IndexedDB và tự đồng bộ lại.

Auth: `signInAnonymously()`. Rules yêu cầu `request.auth != null`.

> ⚠️ **Chưa chạy được:** console báo `auth/configuration-not-found` — Anonymous
> Auth chưa được bật trong Firebase Console. Phần CSV cục bộ không bị ảnh hưởng.

---

## 10. Số đo hiệu năng

Đo trên **Chrome desktop, ảnh giả lập** (canvas vẽ chữ mô phỏng màn hình máy) —
**chưa đo trên điện thoại thật**, số thực tế sẽ cao hơn:

| Bước | Thời gian |
|---|---|
| Khởi tạo Tesseract worker (1 lần khi mở app) | 1.638 ms |
| Tiền xử lý ảnh (cắt + phóng + xám + auto-levels) | 24 ms |
| OCR bước 1 (thông số máy) | 281 ms |
| OCR bước 2 (ngày bảo trì) | 236 ms |

Cả hai bước bóc tách đúng ngay lượt `levels` đầu tiên, không cần đến lượt Otsu.

Text OCR trả về ở bước 1: `Speed 100%\n0.000%\n92.734%\n93.63%\n\n12%\n`
→ thấy rõ `$` bị đọc thành `%` như mục 7 mô tả.

---

## 11. Hỗ trợ trình duyệt

| | Camera | OCR | Ghi thẳng file | Rung |
|---|---|---|---|---|
| Chrome Android | ✅ | ✅ | ✅ | ✅ |
| Chrome / Edge desktop | ✅ | ✅ | ✅ | — |
| Safari iOS 15+ | ✅ | ✅ | ❌ (tải thủ công) | ❌ |
| Firefox | ✅ | ✅ | ❌ (tải thủ công) | ❌ |

Đèn flash (`torch`) chỉ có trên Chrome Android. Khuyến nghị dùng Chrome Android.

---

## 12. Hạn chế đã biết & câu hỏi cần tư vấn

1. **Chưa có bước khử moiré nào chạy được trong ngân sách thời gian.** Median
   filter quá chậm trong JS thuần. Có nên chuyển sang WebGL shader / WebGPU, hay
   một notch filter trên miền tần số? Hay chấp nhận giải quyết bằng thao tác chụp?
2. **Tesseract nhầm `$` ↔ `%`.** Hiện xử lý bằng nhánh dự phòng ở tầng regex.
   Có cách nào tốt hơn ở tầng OCR — train lại chữ số, hay dùng
   `tessedit_char_whitelist` hẹp hơn cho từng vùng?
3. **Toàn bộ xử lý chạy trên luồng chính.** Tesseract.js có worker riêng nhưng
   phần canvas/pixel thì không. Có đáng chuyển sang Web Worker + OffscreenCanvas không?
4. **Chỉ dùng traineddata `eng` mặc định.** Màn hình máy dùng font
   segment/monospace khá đặc thù — có nên train một traineddata riêng không, và
   chi phí thực tế của việc đó?
5. **Ghi đè toàn bộ file CSV mỗi lần lưu.** Chấp nhận được ở quy mô vài chục dòng,
   nhưng có API nào cho phép append thật không?
6. **Kích thước thước ngắm (280×315) đang là số cố định.** Trên máy màn hình nhỏ
   nó bị co lại (`max-height`), làm vùng OCR hẹp hơn dự kiến. Nên tính theo tỉ lệ
   khung hình thay vì px cứng?

---

## 13. Cấu trúc file

```
rtp-web/
├── index.html
├── css/style.css
├── js/
│   ├── cameraController.js   # camera, cắt theo thước ngắm, tiền xử lý ảnh
│   ├── ocrEngine.js          # bọc Tesseract.js worker (PSM 6 + whitelist)
│   ├── ocrParser.js          # regex bóc tách bước 1 & 2
│   ├── csvManager.js         # phiên làm việc + ghi/chia sẻ CSV
│   ├── firebaseManager.js    # đồng bộ Firestore (best-effort)
│   ├── firebaseConfig.js     # config project ocr-rtp
│   ├── util.js               # rung + tiếng bíp
│   └── main.js               # máy trạng thái + điều phối UI
├── firestore.rules
├── .github/workflows/deploy-pages.yml
└── backup/                   # bản code cũ, không đẩy lên GitHub (.gitignore)
```
