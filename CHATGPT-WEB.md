# Auto Coursera 1.3 — ChatGPT Web

## Cài bản cập nhật

1. Nếu dùng ZIP, giải nén vào một thư mục cố định.
2. Mở `edge://extensions` hoặc `chrome://extensions`, bật Developer mode.
3. Với extension đang trỏ vào thư mục mã nguồn này, bấm Reload. Nếu cài từ ZIP, chọn Load unpacked và thư mục vừa giải nén. Chỉ bật một bản Auto Coursera.
4. Tải lại tab Coursera và các tab ChatGPT đã mở để nhận content script mới.
5. Trong popup, chọn **ChatGPT Web / Pro**, bấm **Mở tab ChatGPT / Đăng nhập Pro**. Đăng nhập tài khoản Pro trong cùng trình duyệt và hồ sơ đang chạy extension. Giữ tab riêng này mở, không nhập thêm bản nháp trong lúc công cụ đang chạy.
6. Chạy lại thao tác quiz trong popup. Nếu lần trước đã tạm dừng, chủ động chạy lại sau khi xử lý lỗi.

Không cần API key khi chọn ChatGPT web. Cấu hình Gemini cũ được chuyển sang ChatGPT web; API là tùy chọn riêng.

## Chọn chế độ và chờ đáp án

- **Unlimited attempts:** dùng Instant/Fast nếu có, hoặc mức suy luận thấp nhất của trình chọn hiện tại. Chờ tối đa 5 phút.
- **3 attempts every 24 hours** và mọi trường hợp giới hạn lượt: chọn **Trò chuyện → Pro**, đặt mức suy luận cao nhất. Chờ tối đa 30 phút.
- Không đọc được thông tin số lượt: dùng Pro cao nhất. Chính sách lưu theo từng bài, tránh lấy chế độ của bài trước.

Công cụ chỉ lấy câu trả lời mới sau khi AI hoàn tất và kiểm tra đủ đáp án trước khi điền. Nếu không xác nhận được Pro, không đặt được mức suy luận, mất kết nối, hết thời gian hoặc đáp án thiếu/sai định dạng, luồng chạy tạm dừng. Không tự chuyển sang Gemini/API hay dùng câu trả lời đang viết dở. Mức suy luận cao không bảo đảm đáp án luôn đúng.

Nếu gặp lỗi kết nối sau khi cập nhật, Reload extension rồi mở lại tab ChatGPT bằng nút trong popup. Nếu ChatGPT đang tạo phản hồi hoặc có bản nháp, chờ hoàn tất hoặc xử lý bản nháp trước khi chạy lại.

## Kiểm chứng

Chạy `node --test *.test.js` tại thư mục mã nguồn. Bộ kiểm thử kiểm tra phân loại lượt, chọn chế độ, chờ phản hồi hoàn tất, giao tiếp với service worker và dừng khi có lỗi.

Phiên ChatGPT Pro thực tế trong Edge chưa được kiểm chứng ở lần cập nhật này vì trình duyệt đó chưa kết nối với công cụ điều khiển. Giao diện ChatGPT có thể thay đổi; khi không xác nhận được các điều kiện trên, extension sẽ dừng và báo lỗi.
