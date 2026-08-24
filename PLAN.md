# PLAN — Pipeline "Bài giảng hôm nay → Quiz chẩn đoán → Radar kỹ năng → 3 Level"

## Mục tiêu pipeline

```
[SGK textbook] ──┐
                 ├─► RAG (chunk + embedding + pgvector) ──► Context chuẩn nhất
[Bài giảng hôm nay]┘                                              │
                                                                  ▼
                                              Sinh quiz tổng quát có "bẫy misconception"
                              (VD: điện = dòng nước → AI giải thích sai chỗ nào)
                                                                  │
                                                                  ▼
                                                  Học sinh làm quiz (link share)
                                                                  │
                        ┌─────────────────────────────────────────┤
                        ▼                                         ▼
          Bản kỹ năng hình sao (radar từng HS)      Sơ đồ median theo topic (cả lớp thiếu gì)
                        │                                         │
                        └───────────────┬─────────────────────────┘
                                        ▼
                    AI sinh 3 bài giảng Support / Core / Stretch
                                        │
                                        ▼
                     Gán tự động cho học sinh phù hợp (+ link riêng)
```

## Kiểm kê cấu trúc hiện tại (đã verify ngày 2026-08-24)

### Đã hỗ trợ sẵn — không cần thêm thư viện

| Thành phần | Trạng thái | Ghi chú |
|---|---|---|
| `document_chunks` (vector 768) + hnsw index | ✅ có trong migration | Chỉ thiếu code ghi/đọc |
| RPC `match_document_chunks(vector,int,uuid)` | ✅ có (`202608230001_learning_schema.sql:205`) | Đủ dùng cho retrieval |
| Bảng `misconceptions`, `skill_radar`, `class_analytics` | ✅ có, đúng shape | Chưa được frontend gọi |
| `/api/misconceptions`, `/api/skill-radar`, `/api/class-analytics`, `/api/differentiated-lessons` | ✅ có trong `server.cjs:470-628` | Cần nối vào flow học sinh |
| Dashboard Step 01→06 (textbook, lesson, quiz, share, analytics, diff lessons) | ✅ có trong `teacher-dashboard.html` | Thêm radar chart + panel assignments |
| Flow quiz 1 câu/trang cho học sinh | ✅ có trong `student-quiz.html` | Thêm nhập tên + hiển thị misconception |
| Embedding qua Gemini | ✅ chỉ cần fetch tới `gemini-embedding-001:batchEmbedContents` | Dùng lại pattern `httpsFetch`/fetch hiện có |

### Thiếu / lỗi phải sửa

| # | Vấn đề | Vị trí |
|---|---|---|
| T1 | Chưa có code chunking + embedding + retrieve (RAG chưa chạy thật) | `server.cjs` |
| T2 | `userDocuments` chỉ 1 slot/user — upload bài giảng **ghi đè SGK** | `server.cjs:196` |
| T3 | `documents` thiếu cột `kind` phân biệt textbook/lesson | migration |
| T4 | Không có bảng `students` cho HS không đăng nhập (`student_profiles` bắt buộc references auth.users) | migration |
| T5 | `quiz_responses` thiếu `student_name` | migration |
| T6 | Không có bảng `assignments` (HS ↔ level ↔ lesson_version) | migration |
| T7 | Prompt quiz chung chung, chưa ép sinh distractor kiểu misconception, chưa tag topic | `server.cjs:241` |
| T8 | Bug: `lessonDocument?.context` luôn undefined (API không trả field `context`) | `teacher-dashboard.js:259` |
| T9 | Analytics tính median trên tổng điểm + hardcode `'Quiz Topic'`, studentId = response id | `teacher-dashboard.js:211-215` |
| T10 | `.env.example` thiếu biến model embedding | `.env.example` |

---

## Giai đoạn 1 — Nền tảng RAG (SGK = nguồn sự thật)

**Migration mới:** `supabase/migrations/<ts>_rag_and_students.sql`

```sql
alter table public.documents add column if not exists kind text not null default 'textbook'
  check (kind in ('textbook','lesson'));

create table if not exists public.students (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid not null references auth.users(id) on delete cascade,
    class_id text not null default 'default-class',
    display_name text not null,
    created_at timestamptz not null default now(),
    unique (owner_id, class_id, display_name)
);

alter table public.quiz_responses add column if not exists student_name text;

create table if not exists public.assignments (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid not null references auth.users(id) on delete cascade,
    lesson_version_id uuid not null references public.lesson_versions(id) on delete cascade,
    student_id uuid references public.students(id) on delete cascade,
    level text not null check (level in ('support','core','stretch')),
    status text not null default 'assigned' check (status in ('assigned','opened','done')),
    created_at timestamptz not null default now()
);
-- + index, RLS owner_all cho students/assignments, select công khai cho assignments (HS mở link)
```

**Code (`server.cjs`):**
1. Hàm `embedTexts(texts[])` → POST `gemini-embedding-001:batchEmbedContents` (taskType `RETRIEVAL_DOCUMENT`).
2. Trong `/api/process-document`: nhận thêm field `kind`; sau OCR → chunk ~1000 ký tự (overlap 150) → embed batch → insert `document_chunks`.
3. Thay `userDocuments` Map bằng load theo kind: `getActiveDoc(ownerId, 'textbook' | 'lesson')` đọc từ Supabase (hết lỗi mất context khi restart, hết ghi đè).
4. Hàm `retrieveContext(ownerId, query, kinds)`: embed query (`RETRIEVAL_QUERY`) → RPC `match_document_chunks` → trả `{ sgkContext, lessonContext }`.
5. Sửa `/api/ask`, `/api/quiz`, `/api/differentiated-lessons` dùng `retrieveContext`.

**Env:** thêm `GEMINI_EMBEDDING_MODEL=gemini-embedding-001` vào `.env.example`.

## Giai đoạn 2 — Bài giảng hôm nay + quiz chẩn đoán misconception

6. Endpoint `POST /api/upload-lesson`: OCR bài dạy → trích chủ đề/mục tiêu → so với SGK bằng RAG → trả cảnh báo "bài dạy lệch/thiếu X so với SGK".
7. Nâng prompt `/api/quiz`: mỗi câu bắt buộc ≥1 distractor dựa trên misconception phổ biến (VD: analogi nước cho dòng điện); JSON schema thêm `topic` + `misconception_hint` cho mỗi câu.
8. `student-quiz.html`: màn hình nhập tên học sinh trước khi làm bài → gửi kèm `studentName` khi submit.

## Giai đoạn 3 — Giải thích lỗ hổng + bản kỹ năng hình sao

9. `student-quiz.html` sau submit: gọi `/api/misconceptions` **kèm context SGK** để AI giải thích "bạn hiểu điện như dòng nước → sai ở điểm nào, đúng ra là gì" (hiện endpoint này tồn tại nhưng chưa ai gọi).
10. Server upsert `skill_radar` theo topic: `mastery_score = %đúng trong topic`, `attempts += 1`.
11. Vẽ radar SVG tự viết (không cần lib) ở trang kết quả học sinh + dashboard giáo viên (chọn HS → xem radar).

## Giai đoạn 4 — Median cả lớp + gán 3 level

12. `class-analytics`: tính median **từng topic** (không chỉ tổng điểm); dashboard vẽ biểu đồ cột/radar "cả lớp yếu gì".
13. Endpoint `POST /api/assign-lessons`: lấy analytics + radar → `/api/differentiated-lessons` → tạo `assignments` map HS→level (score < median*0.7 → support; > median*1.3 → stretch; còn lại core) → trả link `/student-lesson.html?aid=<assignment_id>` từng nhóm.
14. Trang mới `student-lesson.html` hiển thị nội dung version được gán.
15. Panel "Step 07 — Assignments" trên `teacher-dashboard.html`: bảng HS → level → nút copy link.

---

## Thứ tự thực hiện & điểm kiểm tra

| Bước | Việc | Kiểm tra |
|---|---|---|
| 1 | Migration SQL mới | Chạy trong Supabase SQL Editor, smoke-test `scripts/smoke-test.cjs` |
| 2 | Chunk + embed + retrieve trong `server.cjs` | Upload `test-materials/OpenStax-Physics-Electric-Circuits-Sample.pdf`, query thử thấy chunks |
| 3 | Tách kind textbook/lesson, sửa bug T8/T9 | Upload SGK rồi bài giảng → cả hai cùng còn nguyên |
| 4 | Quiz misconception + nhập tên HS | Link share làm thử → response có student_name |
| 5 | Misconception feedback + skill_radar | Sai câu analogi nước → feedback chỉ ra đúng lỗ hổng; `skill_radar` có dòng theo topic |
| 6 | Median theo topic + assign-lessons + student-lesson.html | 3 link level khác nhau mở được, dashboard hiện bảng gán |

**Ước lượng:** GĐ1 ~ nửa buổi, GĐ2+3 mỗi giai đoạn ~1 buổi, GĐ4 ~1 buổi.
