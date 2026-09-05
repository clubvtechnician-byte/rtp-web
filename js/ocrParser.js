/**
 * ocrParser.js
 * -----------------------------------------------------------------------
 * Bộ phân tích Regex cho 2 màn hình OCR của máy (port 1-1 logic từ
 * ScreenParser.kt / DateFormatter.kt của bản Android).
 *
 * BƯỚC 1: tìm dòng "0.000%"/"0%" cuối cùng trong văn bản OCR, sau đó lấy
 *         2 giá trị % kế tiếp làm Param X / Param Y, và số nguyên đứng
 *         ngay trước dấu "$" làm Machine ID (ZZ).
 *
 * BƯỚC 2: tìm chuỗi "[Thứ] [Ngày] [Tháng] [Năm] [Giờ:Phút:Giây]" rồi quy
 *         đổi sang định dạng Việt Nam DD/MM/YYYY.
 * -----------------------------------------------------------------------
 */

const OcrParser = (() => {

    // Dòng phần trăm bằng 0: "0%", "0.0%", "0.000%"...
    const ZERO_PERCENT_LINE = /^0(\.0+)?\s*%$/;

    // Một cụm phần trăm bất kỳ, ví dụ "92.734%"
    const PERCENT_TOKEN = /(\d{1,3}(?:\.\d+)?)\s*%/g;

    // Số nguyên đứng ngay trước dấu "$", ví dụ "12$"
    const MACHINE_ID_TOKEN = /(\d{1,4})\s*\$/;

    // "Mon 23 Mar 2026 07:50:05" (không phân biệt hoa thường)
    const MAINTENANCE_DATE_REGEX =
        /(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\.?\s+(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/i;

    const MONTH_MAP = {
        jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
        jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
    };

    /** Quy đổi ngày/tháng chữ/năm sang chuỗi "DD/MM/YYYY", hoặc null nếu không hợp lệ. */
    function toVietnameseDate(day, monthAbbrEn, year) {
        const dayNum = parseInt(day, 10);
        const monthNum = MONTH_MAP[monthAbbrEn.trim().toLowerCase()];
        const yearNum = parseInt(year, 10);

        if (!monthNum || isNaN(dayNum) || isNaN(yearNum)) return null;
        if (dayNum < 1 || dayNum > 31 || yearNum < 1970) return null;

        const dd = String(dayNum).padStart(2, '0');
        const mm = String(monthNum).padStart(2, '0');
        return `${dd}/${mm}/${yearNum}`;
    }

    /**
     * @param {string} rawText toàn bộ text OCR nhận diện được từ 1 frame (giữ nguyên xuống dòng)
     * @returns {{paramX: string, paramY: string, machineId: string} | null}
     */
    function parseStep1(rawText) {
        if (!rawText || !rawText.trim()) return null;

        const lines = rawText.split('\n').map(l => l.trim()).filter(l => l.length > 0);

        // Tìm vị trí dòng "0%"/"0.000%" CUỐI CÙNG trong toàn bộ văn bản
        let zeroIdx = -1;
        for (let i = 0; i < lines.length; i++) {
            if (ZERO_PERCENT_LINE.test(lines[i])) {
                zeroIdx = i;
            }
        }
        if (zeroIdx === -1) return null;

        // Gom các dòng phía sau dòng 0% lại thành 1 cụm để quét theo cửa sổ,
        // vì layout OCR đôi khi tách/dính dòng khác với văn bản gốc.
        const windowText = lines.slice(zeroIdx + 1).join(' ');
        if (!windowText.trim()) return null;

        const percentMatches = [...windowText.matchAll(PERCENT_TOKEN)].map(m => m[1]);
        if (percentMatches.length < 2) return null;
        const paramX = percentMatches[0];
        const paramY = percentMatches[1];

        const idMatch = windowText.match(MACHINE_ID_TOKEN);
        if (!idMatch) return null;
        const machineId = idMatch[1];

        return { paramX, paramY, machineId };
    }

    /**
     * @param {string} rawText toàn bộ text OCR nhận diện được từ 1 frame
     * @returns {{maintenanceDateVi: string} | null}
     */
    function parseStep2(rawText) {
        if (!rawText || !rawText.trim()) return null;
        const match = rawText.match(MAINTENANCE_DATE_REGEX);
        if (!match) return null;

        const [, day, month, year] = match; // bỏ giờ:phút:giây theo đúng đặc tả
        const viDate = toVietnameseDate(day, month, year);
        if (!viDate) return null;

        return { maintenanceDateVi: viDate };
    }

    return { parseStep1, parseStep2, toVietnameseDate };
})();
