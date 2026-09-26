/**
 * ocrParser.js
 * -----------------------------------------------------------------------
 * Bóc tách dữ liệu từ kết quả đã nhận diện theo DÒNG/TOKEN (không còn dùng
 * regex trên text OCR tổng quát như bản Tesseract cũ).
 *
 * BƯỚC 1 (màn Audit) — mặc định anchor-relative theo ký tự "$" (đã
 * validate trên ảnh thật): dòng chứa "$" làm mốc → mốc-1 = Machine No,
 * mốc-2 = RTP2, mốc-3 = RTP1. Không tìm được dòng "$" → coi như thất bại
 * toàn bộ, đẩy qua xác nhận tay.
 *
 * Có thêm tuỳ chọn thử nghiệm `useMgmdAnchor` — đổi mốc sang cụm "MGMD"
 * (model 4.0 có lớp riêng cho nguyên cụm 4 chữ này, luôn nằm đúng 1 dòng
 * dưới dòng "$0.01" → mốc-1=denom (bỏ qua), mốc-2=Machine No, mốc-3=RTP2,
 * mốc-4=RTP1 — về vị trí trỏ ĐÚNG CÙNG 3 dòng với mốc "$").
 * ⚠️ ĐÃ KIỂM CHỨNG THỰC NGHIỆM: model KHÔNG phân biệt được "MGMD" thật với
 * bất kỳ token 4-box nào khác (số "1234", "2026", "0012" đều bị nhận nhầm
 * thành "mgmd" 100%, có vẻ chỉ phản ứng theo tỉ lệ khung ~4:1 của crop,
 * không thực sự đọc nội dung). Tuỳ chọn này để lại phục vụ thử nghiệm/so
 * sánh trực tiếp trên ảnh thật, mặc định TẮT — bật lên có rủi ro đọc nhầm
 * dòng neo mà vẫn hiện độ tin cậy cao, không có dấu hiệu cảnh báo.
 *
 * BƯỚC 2 (màn ngày) — chỉ đọc NGÀY + NĂM bằng model số (model tháng chưa
 * có, để Giai đoạn 2). Trong dòng ngày có nhiều token xen lẫn chữ (thứ,
 * tên tháng) mà model không đọc được (confidence thấp) — lọc lấy token
 * số có confidence cao: token 4 chữ số = năm, token 1-2 chữ số đứng
 * TRƯỚC token năm (theo thứ tự trái->phải) = ngày.
 * -----------------------------------------------------------------------
 */

const OcrParser = (() => {
    const RTP_MIN = 80, RTP_MAX = 99;
    const MACHINE_NO_MIN = 0, MACHINE_NO_MAX = 900;
    const ROW_CONFIDENCE_OK = 0.6; // dưới ngưỡng này -> hạ confidence tổng

    /** Chèn dấu chấm khi model không đọc được "." — coi phần nguyên luôn 2 chữ số (RTP 80-99). */
    function fixMissingDecimalForRtp(digitsOnly) {
        if (digitsOnly.length <= 2) return { value: Number(digitsOnly), corrected: false };
        const intPart = digitsOnly.slice(0, 2);
        const fracPart = digitsOnly.slice(2);
        return { value: Number(`${intPart}.${fracPart}`), corrected: true };
    }

    /**
     * @param {string} rowText chuỗi ký tự đã ghép của 1 dòng, ví dụ "93.358%", "1", "$0.01"
     * @returns {{numeric: number|null, hasDollar: boolean, autoCorrected: boolean}}
     */
    function parseNumericRow(rowText) {
        const hasDollar = rowText.includes('$');
        const digitsOnly = rowText.replace(/[^0-9]/g, '');
        if (!digitsOnly) return { numeric: null, hasDollar, autoCorrected: false };

        if (rowText.includes('.')) {
            const numMatch = rowText.match(/[0-9]+\.[0-9]+/);
            return { numeric: numMatch ? Number(numMatch[0]) : null, hasDollar, autoCorrected: false };
        }
        return { numeric: Number(digitsOnly), hasDollar, autoCorrected: false };
    }

    /**
     * @param {{text: string, meanConfidence: number}[]} rows danh sách dòng đã nhận diện, thứ tự trên->dưới
     * @param {{useMgmdAnchor?: boolean}} [opts] bật để dùng mốc "MGMD" thử nghiệm thay vì "$" (xem cảnh báo ở đầu file)
     * @returns {null | {
     *   machineNo: number, rtp1: number, rtp2: number,
     *   confidence: {machineNo:number, rtp1:number, rtp2:number},
     *   autoCorrected: {rtp1:boolean, rtp2:boolean}
     * }}
     */
    function parseStep1(rows, opts) {
        if (!rows || rows.length === 0) return null;
        const useMgmdAnchor = !!(opts && opts.useMgmdAnchor);

        let machineRow, rtp2Row, rtp1Row;

        if (useMgmdAnchor) {
            const mgmdIdx = rows.findIndex((r) => r.tokens.some((t) => t.mgmdMatch));
            if (mgmdIdx < 4) return null; // không đủ 4 dòng phía trên mốc
            // mgmdIdx - 1 = denom, không dùng
            machineRow = rows[mgmdIdx - 2];
            rtp2Row = rows[mgmdIdx - 3];
            rtp1Row = rows[mgmdIdx - 4];
        } else {
            const dollarIdx = rows.findIndex((r) => r.text.includes('$'));
            if (dollarIdx < 3) return null; // không đủ 3 dòng phía trên mốc
            machineRow = rows[dollarIdx - 1];
            rtp2Row = rows[dollarIdx - 2];
            rtp1Row = rows[dollarIdx - 3];
        }

        const machineDigits = machineRow.text.replace(/[^0-9]/g, '');
        if (!machineDigits) return null;
        const machineNo = Number(machineDigits);

        const rtp1Fallback = !rtp1Row.text.includes('.') && rtp1Row.text.replace(/[^0-9]/g, '').length > 2;
        const rtp2Fallback = !rtp2Row.text.includes('.') && rtp2Row.text.replace(/[^0-9]/g, '').length > 2;

        const rtp1Digits = rtp1Row.text.replace(/[^0-9]/g, '');
        const rtp2Digits = rtp2Row.text.replace(/[^0-9]/g, '');
        const rtp1 = rtp1Fallback
            ? fixMissingDecimalForRtp(rtp1Digits).value
            : Number((rtp1Row.text.match(/[0-9]+\.[0-9]+/) || [rtp1Digits])[0]);
        const rtp2 = rtp2Fallback
            ? fixMissingDecimalForRtp(rtp2Digits).value
            : Number((rtp2Row.text.match(/[0-9]+\.[0-9]+/) || [rtp2Digits])[0]);

        if ([machineNo, rtp1, rtp2].some((v) => Number.isNaN(v))) return null;

        const machineNoValid = machineNo >= MACHINE_NO_MIN && machineNo <= MACHINE_NO_MAX;
        const rtp1Valid = rtp1 >= RTP_MIN && rtp1 <= RTP_MAX;
        const rtp2Valid = rtp2 >= RTP_MIN && rtp2 <= RTP_MAX;

        return {
            machineNo, rtp1, rtp2,
            confidence: {
                machineNo: machineNoValid ? machineRow.meanConfidence : 0,
                rtp1: rtp1Valid ? rtp1Row.meanConfidence : 0,
                rtp2: rtp2Valid ? rtp2Row.meanConfidence : 0,
            },
            autoCorrected: { rtp1: rtp1Fallback, rtp2: rtp2Fallback },
            allValid: machineNoValid && rtp1Valid && rtp2Valid,
        };
    }

    /**
     * @param {{text: string, meanConfidence: number}[]} tokens token trên dòng ngày, thứ tự trái->phải
     * @returns {null | {day: number, year: number}}
     */
    function parseStep2(tokens) {
        if (!tokens || tokens.length === 0) return null;

        const reliableNumeric = tokens
            .map((t, idx) => ({ ...t, idx, digitsOnly: t.text.replace(/[^0-9]/g, '') }))
            .filter((t) => t.meanConfidence >= ROW_CONFIDENCE_OK && t.digitsOnly.length === t.text.length && t.digitsOnly.length > 0);

        const yearToken = reliableNumeric.find((t) => t.digitsOnly.length === 4);
        if (!yearToken) return null;

        const dayToken = reliableNumeric.find((t) => t.idx < yearToken.idx && t.digitsOnly.length <= 2);
        if (!dayToken) return null;

        const day = Number(dayToken.digitsOnly);
        const year = Number(yearToken.digitsOnly);
        if (day < 1 || day > 31) return null;

        return { day, year };
    }

    return { parseStep1, parseStep2, parseNumericRow, RTP_MIN, RTP_MAX, MACHINE_NO_MIN, MACHINE_NO_MAX };
})();
