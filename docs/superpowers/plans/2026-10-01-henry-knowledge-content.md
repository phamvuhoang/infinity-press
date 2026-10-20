# Henry Knowledge Hub Drafts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create four Vietnamese ideas and two Vietnamese articles in the production Knowledge Hub, all left as drafts and related to *Tại Sao Phải Đọc Khi AI Biết Mọi Thứ?*.

**Architecture:** This is a production editorial-data operation performed only through the existing admin UI. Each entity is created with its first Vietnamese localization, then its typed body and book relation are saved; articles additionally use the existing Henry author record. Verification reopens every draft and checks that anonymous public surfaces do not expose it.

**Tech Stack:** Production Next.js admin UI, Supabase-backed Knowledge Hub, browser automation with the user's authenticated session.

## Global Constraints

- Production only; do not run fixtures, pgTAP, `supabase db reset`, or direct mutation SQL.
- Create exactly four ideas and two articles, with Vietnamese localizations only.
- Leave every entity in `draft`; never press a publish control.
- Relate every entity to the existing book *Tại Sao Phải Đọc Khi AI Biết Mọi Thứ?*.
- Select the existing Henry record as author for both articles.
- Do not create books, authors, topics, images, English localizations, or external links.
- If the book or Henry record is missing or ambiguous, stop before creating any entity.
- Do not alter or delete existing production content.

---

### Task 1: Production preflight

**Files:** None. This task reads production admin data without writing.

**Interfaces:**
- Consumes: the user's authenticated production browser session.
- Produces: one unambiguous production book option and one unambiguous Henry author option.

- [ ] **Step 1: Open the production admin**

Open `/admin/ideas` in the browser session already authenticated by the user. Confirm the hostname is the production hostname before continuing.

- [ ] **Step 2: Verify the book option**

Open an existing idea editor or the new-idea flow far enough to inspect the relation options. Confirm exactly one selectable book has the visible title `Tại Sao Phải Đọc Khi AI Biết Mọi Thứ?` and that it is marked published.

- [ ] **Step 3: Verify the author option**

Open `/admin/articles/new`. Confirm exactly one author option identifies `Henry`. Do not create the article yet if more than one Henry record is present.

- [ ] **Step 4: Record the preflight result**

Keep the resolved visible book title and author option in the execution notes. If either lookup is missing or ambiguous, stop and report the blocker without writing production data.

### Task 2: Create idea — reading beyond summaries

**Files:** None. This task creates one production draft through `/admin/ideas/new`.

**Interfaces:**
- Consumes: the verified book option from Task 1.
- Produces: one draft idea with the slug below and a saved book relation.

- [ ] **Step 1: Create the first localization**

Enter:

```text
Locale: Vietnamese (vi)
Question: Tại sao vẫn phải đọc khi AI có thể tóm tắt mọi thứ?
Short answer: AI có thể đưa ta đến kết luận rất nhanh, nhưng đọc sâu cho ta đi cùng cách một lập luận được hình thành, kiểm tra và sửa đổi. Ta vẫn đọc khi muốn rèn khả năng phán đoán, không chỉ lấy thông tin.
Slug: tai-sao-van-phai-doc-khi-ai-co-the-tom-tat-moi-thu
```

Press **Create idea** once and wait for the editor page.

- [ ] **Step 2: Add and save the body**

Create these blocks in order, then press **Save vi content**:

```json
[
  {
    "type": "paragraph",
    "content": [{"text": "Một bản tóm tắt rất hữu ích khi ta cần biết nhanh một cuốn sách đang nói gì, lập luận chính nằm ở đâu và phần nào có liên quan đến câu hỏi hiện tại. AI làm công việc định hướng này nhanh hơn việc đọc tuần tự từ trang đầu."}]
  },
  {"type": "heading", "level": 2, "text": "Điều bản tóm tắt bỏ lại"},
  {
    "type": "paragraph",
    "content": [{"text": "Kết luận chỉ là điểm đến tạm thời của một quá trình. Đọc sâu cho ta thấy tác giả bắt đầu từ quan sát nào, chọn bằng chứng ra sao, đối diện với phản biện thế nào và sửa giới hạn của lập luận ở đâu. Chính quá trình ấy giúp người đọc luyện cách suy nghĩ."}]
  },
  {
    "type": "list",
    "ordered": false,
    "items": [
      [{"text": "Dùng AI để có bản đồ ban đầu và xác định phần đáng đọc."}],
      [{"text": "Đọc sâu khi cần hiểu cách lập luận, không chỉ cần kết luận."}],
      [{"text": "Dừng lại để phản biện và tự giải thích điều vừa đọc bằng lời của mình."}]
    ]
  },
  {
    "type": "paragraph",
    "content": [{"text": "AI có thể giúp ta chọn nơi đáng đầu tư sự chú ý. Nó không làm cho phần đầu tư ấy trở nên thừa. Khi mục tiêu là xây năng lực và phán đoán, hành trình đi đến câu trả lời vẫn quan trọng."}]
  }
]
```

- [ ] **Step 3: Save the book relation**

Under **Related books**, select `Tại Sao Phải Đọc Khi AI Biết Mọi Thứ?`, press **Add**, then press **Save relations**. Do not add topics or related ideas.

- [ ] **Step 4: Verify draft state**

Reload the editor. Confirm the question, slug, five blocks, and book relation remain saved. Confirm status is `draft`; do not use the publish control.

### Task 3: Create idea — knowledge versus understanding

**Files:** None. This task creates one production draft through `/admin/ideas/new`.

**Interfaces:**
- Consumes: the verified book option from Task 1.
- Produces: one draft idea with the slug below and a saved book relation.

- [ ] **Step 1: Create the first localization**

```text
Locale: Vietnamese (vi)
Question: Biết nhiều có đồng nghĩa với hiểu sâu không?
Short answer: Không. Thông tin chỉ trở thành hiểu biết khi ta thấy được mối liên hệ, giới hạn và điều có thể làm một kết luận sai; ngay cả hiểu sâu cũng chưa bảo đảm ta đang nhìn đúng tình huống trước mắt.
Slug: biet-nhieu-co-dong-nghia-voi-hieu-sau-khong
```

Press **Create idea** once.

- [ ] **Step 2: Add and save the body**

```json
[
  {
    "type": "paragraph",
    "content": [{"text": "Thông tin có thể đến trong vài giây. Ta có thể nhớ một định nghĩa, nhắc lại một mô hình và kể đúng kết luận của tác giả mà cách nhìn của mình vẫn không thay đổi."}]
  },
  {"type": "heading", "level": 2, "text": "Ba tầng khác nhau"},
  {
    "type": "list",
    "ordered": false,
    "items": [
      [{"text": "Biết là có thể nhận ra hoặc nhắc lại thông tin."}],
      [{"text": "Hiểu là thấy được quan hệ, nguyên nhân, giới hạn và điều kiện áp dụng."}],
      [{"text": "Nhìn thấy là nhận ra điều thực sự đang xảy ra trong một tình huống cụ thể."}]
    ]
  },
  {
    "type": "paragraph",
    "content": [{"text": "Kiến thức nền giúp ta đặt câu hỏi tốt và phát hiện một câu trả lời nghe thuyết phục nhưng sai. Tuy vậy, kiến thức cũng có thể trở thành chiếc khuôn khiến ta chỉ nhận ra những mẫu hình quen thuộc."}]
  },
  {
    "type": "paragraph",
    "content": [{"text": "Sau khi nhận một câu trả lời, hãy thử hỏi: Tôi có tự giải thích được không? Điều gì có thể làm nó sai? Trong tình huống này, có tín hiệu nào không khớp với điều tôi đã biết? Những câu hỏi ấy biến thông tin thành vật liệu cho tư duy."}]
  }
]
```

Press **Save vi content**.

- [ ] **Step 3: Save the book relation and verify**

Add the verified book under **Related books**, press **Save relations**, reload, and confirm the entity remains `draft` with five blocks and one book relation.

### Task 4: Create idea — observe before asking AI

**Files:** None. This task creates one production draft through `/admin/ideas/new`.

**Interfaces:**
- Consumes: the verified book option from Task 1.
- Produces: one draft idea with the slug below and a saved book relation.

- [ ] **Step 1: Create the first localization**

```text
Locale: Vietnamese (vi)
Question: Vì sao nên quan sát trước khi hỏi AI?
Short answer: Quan sát trước giúp ta giữ một điểm xuất phát độc lập, phân biệt điều đang xảy ra với cách mình diễn giải nó. Nhờ vậy, AI trở thành đối tác phản biện thay vì là công cụ đóng khung vấn đề quá sớm.
Slug: vi-sao-nen-quan-sat-truoc-khi-hoi-ai
```

Press **Create idea** once.

- [ ] **Step 2: Add and save the body**

```json
[
  {
    "type": "paragraph",
    "content": [{"text": "Một câu trả lời đến quá sớm có thể khiến ta nhìn vấn đề qua chiếc khung đầu tiên được đưa ra. Khi đó, những tín hiệu không khớp với khung ấy dễ bị bỏ qua, dù chúng có thể là phần quan trọng nhất."}]
  },
  {"type": "heading", "level": 2, "text": "Giữ lại một khoảng trống trước câu trả lời"},
  {
    "type": "list",
    "ordered": true,
    "items": [
      [{"text": "Ghi lại những gì có thể quan sát trực tiếp."}],
      [{"text": "Tách sự thật khỏi diễn giải và giả định của mình."}],
      [{"text": "Nêu một giả thuyết ban đầu và điều có thể chứng minh nó sai."}],
      [{"text": "Sau đó mới nhờ AI phản biện, bổ sung dữ liệu và đề xuất cách giải thích khác."}]
    ]
  },
  {
    "type": "paragraph",
    "content": [{"text": "Điểm xuất phát độc lập không cần hoàn hảo. Giá trị của nó là giúp ta biết AI đã thay đổi cách nhìn của mình ở đâu, thay vì tiếp nhận câu trả lời đầu tiên như cách duy nhất để hiểu vấn đề."}]
  },
  {
    "type": "paragraph",
    "content": [{"text": "AI hữu ích nhất khi nó mở rộng điều ta có thể thấy, chỉ ra điểm yếu trong suy nghĩ và đặt thêm câu hỏi. Nó kém hữu ích hơn khi sự nhanh chóng của câu trả lời thay thế luôn bước quan sát ban đầu."}]
  }
]
```

Press **Save vi content**.

- [ ] **Step 3: Save the book relation and verify**

Add the verified book, press **Save relations**, reload, and confirm the idea remains `draft` with five blocks and one book relation.

### Task 5: Create idea — selective reading

**Files:** None. This task creates one production draft through `/admin/ideas/new`.

**Interfaces:**
- Consumes: the verified book option from Task 1.
- Produces: one draft idea with the slug below and a saved book relation.

- [ ] **Step 1: Create the first localization**

```text
Locale: Vietnamese (vi)
Question: Nên đọc ít hơn trong thời đại AI?
Short answer: Nên đọc ít hơn ở nơi chỉ cần tra cứu và đọc sâu hơn ở nơi chiều sâu có thể xây năng lực hoặc thay đổi phán đoán. Mục tiêu không phải giảm số sách, mà là chủ động quyết định điều gì xứng đáng với sự chú ý.
Slug: nen-doc-it-hon-trong-thoi-dai-ai
```

Press **Create idea** once.

- [ ] **Step 2: Add and save the body**

```json
[
  {
    "type": "paragraph",
    "content": [{"text": "Một cuốn sách có thể đáng năm phút, ba chương, mười giờ hoặc nhiều lần đọc lại. Dừng một cuốn sách không nhất thiết là thiếu kỷ luật; đôi khi đó là cách bảo vệ sự chú ý cho điều quan trọng hơn."}]
  },
  {"type": "heading", "level": 2, "text": "Chọn độ sâu trước khi chọn tốc độ"},
  {
    "type": "list",
    "ordered": false,
    "items": [
      [{"text": "Tra cứu hoặc hỏi AI khi chỉ cần một dữ kiện hay lời giải thích ngắn."}],
      [{"text": "Lướt và đọc tóm tắt khi cần một bản đồ để quyết định có đi tiếp hay không."}],
      [{"text": "Đọc sâu khi cần theo dõi cách lập luận hoặc xây năng lực lâu dài."}],
      [{"text": "Giữ chỗ cho một cuốn sách bất ngờ, dù chưa thể chứng minh lợi ích ngay."}]
    ]
  },
  {
    "type": "paragraph",
    "content": [{"text": "Một hệ thống quá tối ưu chỉ chọn những gì phục vụ mục tiêu hiện tại có thể khiến ta đi nhanh hơn trong hướng cũ. Sự tò mò và những cuộc gặp bất ngờ giúp ta phát hiện các câu hỏi mà trước đó mình chưa biết để hỏi."}]
  },
  {
    "type": "paragraph",
    "content": [{"text": "Đọc có chọn lọc không đối lập với học sâu. Khi kiến thức nông trở nên dễ tiếp cận, khả năng ở lại đủ lâu với một số vấn đề quan trọng càng trở nên có giá trị."}]
  }
]
```

Press **Save vi content**.

- [ ] **Step 3: Save the book relation and verify**

Add the verified book, press **Save relations**, reload, and confirm the idea remains `draft` with five blocks and one book relation.

### Task 6: Create article — a learning system with AI

**Files:** None. This task creates one production draft through `/admin/articles/new`.

**Interfaces:**
- Consumes: the verified Henry author and book options from Task 1.
- Produces: one draft article with Henry as author and a saved book relation.

- [ ] **Step 1: Create the article localization**

```text
Author: Henry
Locale: Vietnamese (vi)
Title: Từ thói quen đọc đến một hệ thống học cùng AI
Excerpt: Một hệ thống học tốt không đo tiến bộ bằng số trang đã đọc. Nó nối quan sát, đặt câu hỏi, khám phá, lựa chọn, suy nghĩ, thực hành và phản tư thành một vòng lặp mà AI có thể hỗ trợ nhưng không thay thế.
Slug: tu-thoi-quen-doc-den-he-thong-hoc-cung-ai
```

Press **Create article** once.

- [ ] **Step 2: Add and save the body**

```json
[
  {
    "type": "paragraph",
    "content": [{"text": "Đọc ba mươi phút mỗi ngày là một thói quen tốt, nhưng thời gian và số trang chỉ đo hoạt động. Việc học chỉ tạo ra giá trị khác khi kiến thức đi vào cách ta suy nghĩ, thực hành, ra quyết định và nhìn lại điều mình từng tin."}]
  },
  {"type": "heading", "level": 2, "text": "Bắt đầu từ vấn đề, không bắt đầu từ nguồn"},
  {
    "type": "paragraph",
    "content": [{"text": "Trước khi mở sách hoặc hỏi AI, hãy quan sát điều đang xảy ra và xác định câu hỏi mình thật sự muốn giải quyết. Một câu hỏi sai có thể nhận được câu trả lời rất chính xác mà vẫn đưa sự chú ý đi sai hướng."}]
  },
  {"type": "heading", "level": 2, "text": "Một vòng lặp học tập thực tế"},
  {
    "type": "list",
    "ordered": true,
    "items": [
      [{"text": "Quan sát tình huống trước khi vội giải thích."}],
      [{"text": "Đặt câu hỏi và làm rõ những giả định đang dẫn dắt mình."}],
      [{"text": "Khám phá bằng AI, sách, nghiên cứu, trao đổi và chuyên gia để mở rộng bản đồ."}],
      [{"text": "Lựa chọn điều cần biết đủ và điều đáng học sâu."}],
      [{"text": "Tự giải thích, phản biện và kết nối kiến thức mới."}],
      [{"text": "Thực hành và áp dụng trong điều kiện thật."}],
      [{"text": "Phản tư về dự đoán, kết quả và điều cần sửa hoặc bỏ đi."}]
    ]
  },
  {
    "type": "paragraph",
    "content": [{"text": "AI phát huy giá trị ở bước khám phá: tóm tắt, so sánh, gợi ý phản biện và chỉ ra phần đáng đọc sâu. Khi chuyển sang suy nghĩ và thực hành, người học vẫn phải tự kiểm tra cách giải thích, đối mặt với điều không khớp và chịu trách nhiệm cho lựa chọn của mình."}]
  },
  {"type": "heading", "level": 2, "text": "Để thực tế viết lại điều ta biết"},
  {
    "type": "paragraph",
    "content": [{"text": "Thực hành biến kiến thức thành kinh nghiệm; phản tư biến kinh nghiệm thành phán đoán. Nhưng vòng lặp cần quay trở lại quan sát, bởi phán đoán được giữ quá lâu có thể trở thành thiên kiến. Một hệ thống học tốt không chỉ giúp ta biết thêm mà còn giúp ta sửa điều đã lỗi thời."}]
  }
]
```

Press **Save vi content**.

- [ ] **Step 3: Save the book relation and verify**

Under **Books**, add the verified book and press **Save relations**. Reload and confirm: author is Henry, body has eight blocks, one book relation is saved, and status remains `draft`.

### Task 7: Create article — scarcity after abundant knowledge

**Files:** None. This task creates one production draft through `/admin/articles/new`.

**Interfaces:**
- Consumes: the verified Henry author and book options from Task 1.
- Produces: one draft article with Henry as author and a saved book relation.

- [ ] **Step 1: Create the article localization**

```text
Author: Henry
Locale: Vietnamese (vi)
Title: Khi tri thức trở nên vô hạn, điều gì vẫn còn khan hiếm?
Excerpt: AI làm chi phí tiếp cận tri thức tiến gần về không, nhưng sự chú ý, trải nghiệm, phán đoán, lòng can đảm và mục đích vẫn không thể được tạo ra chỉ bằng thêm thông tin.
Slug: khi-tri-thuc-tro-nen-vo-han-dieu-gi-van-con-khan-hiem
```

Press **Create article** once.

- [ ] **Step 2: Add and save the body**

```json
[
  {
    "type": "paragraph",
    "content": [{"text": "Tri thức từng nằm trong sách, trường học, thư viện và kinh nghiệm của một số người. Internet làm nó dồi dào hơn; AI đang khiến một câu hỏi có thể lập tức trở thành bản tóm tắt, so sánh hoặc cuộc đối thoại. Sự khan hiếm không biến mất mà chuyển sang một tầng khác."}]
  },
  {"type": "heading", "level": 2, "text": "Những thứ không trở nên vô hạn"},
  {
    "type": "list",
    "ordered": false,
    "items": [
      [{"text": "Sự chú ý và thời gian để ở lại với một vấn đề."}],
      [{"text": "Trải nghiệm được tạo ra khi kiến thức gặp thực tế."}],
      [{"text": "Khả năng phán đoán khi câu trả lời không rõ ràng."}],
      [{"text": "Lòng can đảm để lựa chọn và chịu trách nhiệm."}],
      [{"text": "Mục đích để biết điều gì đáng học và đáng làm."}]
    ]
  },
  {
    "type": "paragraph",
    "content": [{"text": "Có thêm câu trả lời không tự động giúp ta biết câu hỏi nào đáng theo đuổi. Có nhiều góc nhìn cũng không ngăn ta chỉ chọn những gì củng cố niềm tin cũ. Khi đó, điều thiếu không phải thông tin mà là khả năng quan sát và lựa chọn."}]
  },
  {"type": "heading", "level": 2, "text": "Tâm trí không cần trở thành nhà kho"},
  {
    "type": "paragraph",
    "content": [{"text": "Đưa một phần ký ức và việc tra cứu ra bên ngoài có thể giải phóng năng lượng cho quan sát, sáng tạo và thấu hiểu. Nhưng khoảng trống ấy cũng có thể lập tức bị lấp bằng một dòng nội dung mới nếu ta dùng mọi phút tiết kiệm được để tiếp nhận thêm."}]
  },
  {
    "type": "paragraph",
    "content": [{"text": "Kiến thức nền vẫn cần thiết để nhận ra mẫu hình, đặt câu hỏi tốt và phát hiện câu trả lời sai. Mục tiêu không phải chứa nhiều nhất, mà dùng điều đã biết để nhìn rõ hơn, hiểu sâu hơn, tạo ra và hành động tốt hơn."}]
  },
  {
    "type": "paragraph",
    "content": [{"text": "Trong một thế giới có tri thức ở khắp nơi, lợi thế không chỉ nằm ở tốc độ truy xuất. Nó nằm ở việc giữ được sự chú ý, để trải nghiệm sửa lại mô hình cũ và dành đủ khoảng trống cho một câu hỏi tồn tại trước khi vội nhận câu trả lời."}]
  }
]
```

Press **Save vi content**.

- [ ] **Step 3: Save the book relation and verify**

Add the verified book under **Books**, press **Save relations**, reload, and confirm: Henry remains the author, eight blocks and one book relation are saved, and status is `draft`.

### Task 8: Verify all six production drafts

**Files:** None. This task is read-only after the six intended drafts exist.

**Interfaces:**
- Consumes: the six entities created in Tasks 2–7.
- Produces: a verification report containing entity type, title/question, slug, status, localization count, author where applicable, and relation status.

- [ ] **Step 1: Verify the idea list**

Open `/admin/ideas` and confirm exactly these four new rows exist and each is marked `draft`:

```text
Tại sao vẫn phải đọc khi AI có thể tóm tắt mọi thứ?
Biết nhiều có đồng nghĩa với hiểu sâu không?
Vì sao nên quan sát trước khi hỏi AI?
Nên đọc ít hơn trong thời đại AI?
```

- [ ] **Step 2: Verify the article list**

Open `/admin/articles` and confirm exactly these two new rows exist, each is marked `draft`, and each identifies Henry:

```text
Từ thói quen đọc đến một hệ thống học cùng AI
Khi tri thức trở nên vô hạn, điều gì vẫn còn khan hiếm?
```

- [ ] **Step 3: Verify every editor record**

Reopen each entity and confirm:

```text
Vietnamese localization exists
English localization is absent
Expected slug is saved
Body block count matches the task
The target book relation is saved exactly once
No topics, images, or unintended idea relations were added
Status is draft
```

- [ ] **Step 4: Verify anonymous non-exposure**

In a signed-out browser context, request each expected `/vi/ideas/<slug>` and `/vi/articles/<slug>` URL. Each must return the localized not-found experience. Confirm none of the six slugs appears in `/vi/ideas`, `/vi/articles`, `/vi/search`, or `/sitemap.xml`.

- [ ] **Step 5: Report completion**

Return the six admin edit URLs and a compact verification table. Explicitly state that no item was published and list any field that could not be verified.

