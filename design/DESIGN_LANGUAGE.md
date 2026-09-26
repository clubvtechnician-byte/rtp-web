<!--
  Nguồn: chắt lọc từ 2 lần xuất Stitch (DESIGN.md kèm mỗi màn hình + Project
  Brief), đối chiếu với code thật, bỏ hết phần bịa và phần không cần cho
  việc giữ theme. Đây là file DUY NHẤT cần đọc trước khi thiết kế thêm bất
  kỳ màn hình/tính năng nào cho rtp-web — để cùng theme, cùng ngôn ngữ
  thiết kế với các màn hình đã có.
-->

# Ngôn ngữ thiết kế — V Club Audit Scanner

**Định hướng:** "Bảng điều khiển kỹ thuật công nghiệp" (technician's
diagnostic console) — không phải app tiêu dùng. Không gradient, không
glassmorphism, không bóng đổ mờ, không bo tròn mềm mại kiểu fintech.

## 1. Màu sắc

| Vai trò | Màu | Quy tắc dùng |
|---|---|---|
| Nền (ground) | `#121316` | Toàn bộ canvas |
| Nền panel/card | `#1a1c22` | Container, form, camera envelope |
| Nền phần tử active | `#252830` | Nút, toggle, overlay đang mở |
| Viền mặc định | `#323642` | 1px, mọi container |
| **Accent (brass/amber)** | `#e5a93c` | **CHỈ** dùng cho khung ngắm camera + nút hành động chính. Không dùng để trang trí, không lặp lại cho ý nghĩa khác |
| Verified/tin cậy cao | `#22c55e` (xanh lá) | Đọc OCR thành công |
| Auto-corrected/cần xem lại | `#f97316` (cam) | Giá trị hệ thống tự sửa — **không phải lỗi**, giọng điệu bình tĩnh |
| Destructive | `#ef4444` (đỏ) | Kết thúc phiên, huỷ, cảnh báo nghiêm trọng |
| Chữ chính | `#f3f4f6` | Số liệu, nội dung chính |
| Chữ phụ | `#9ca3af` | Nhãn, mô tả phụ |

Nguyên tắc quan trọng nhất: **accent (vàng) và màu trạng thái (xanh/cam/đỏ)
tách biệt hoàn toàn** — không dùng vàng để báo "đúng" hay dùng đỏ cho việc
không phải lỗi thật.

## 2. Typography

- **IBM Plex Sans** — giao diện, nhãn, tiêu đề, hướng dẫn
- **JetBrains Mono** — **mọi** số liệu không ngoại lệ: RTP%, mã máy, ngày
  tháng, bộ đếm. Tabular figures để số luôn gióng thẳng hàng
- Nhãn phụ (label-caps): viết hoa, letter-spacing rộng, cỡ nhỏ (11px)

## 3. Hình khối & khoảng cách

- Bo góc nhỏ `4px` cho card/button/input — không bo tròn pill, trừ badge/chip nhỏ
- Viền 1px mặc định; khi active/focus → 2px + màu accent hoặc màu trạng thái tương ứng
- Không dùng shadow mờ để tạo chiều sâu — phân lớp bằng độ sáng nền + viền
- Chạm tối thiểu: nút chính cao **52px**, input cao **48px** (ngón cái bấm chắc)

## 4. Nguyên tắc UX bắt buộc (áp dụng cho mọi màn hình mới)

1. **1 tay thao tác** — nút hành động chính luôn nằm trong tầm ngón cái (1/3 dưới màn hình)
2. **Tương phản cao** — môi trường tối, màn hình nguồn dễ loá; không dùng overlay mờ nhạt
3. **Khung ngắm camera (nếu có) phải khớp đúng vị trí thật của dữ liệu cần đọc** — không đặt giữa cho cân đối nếu vị trí thật lệch
4. **Trạng thái "đang quét" (live) và "đã dừng xem lại" (frozen)** phải phân biệt rõ ràng ngay từ liếc mắt đầu tiên
5. **Auto-corrected dùng cam + câu giải thích ngắn**, không dùng đỏ, không dùng ngôn ngữ báo lỗi
6. **Trường nhập tay (không qua OCR)** phải có dấu hiệu khác biệt rõ (viền/nhãn riêng) để không bị hiểu nhầm là tự động

## 5. Quy tắc nội dung — không bịa số liệu/tên hệ thống

Không tự thêm tên server, chuẩn kiểm định, thuật toán bảo mật, con số hiệu
năng... nếu không có thật trong code. Muốn minh hoạ ý tưởng tương lai thì
ghi rõ "chưa triển khai", không trình bày như tính năng đang chạy thật.
