# Language Reader
Open a UTF-8 text file (up to 4 MiB) or a scanned or selectable-text PDF (up to 32 MiB), choose the reading and translation languages, then tap a word for its meaning and dictionary form in context. Tap **Translate sentence** to reveal the whole translation. Exceptionally long sentences use a shorter local excerpt.

AI Pages 0.2.3 or later provides the Android file picker, ChatGPT sign-in, storage, and the fast-text profile (gpt-6-luna with reasoning effort none). PDF text is extracted on the device and reflows into reader pages. Choose the reading language before importing a scan. Pages without embedded text use offline OCR in that language. Open a PDF from the reader or choose AI Pages under **Open with** in Android Files. Unlock password-protected files before importing them. On AI Pages 0.2.5 or later, tapping a word sends the lookup directly. Recent translations and the page bookmark are saved locally. Short texts reopen automatically. For longer texts, reselect the same file to resume.

Run `npm ci && npm run build` and serve `dist/` over localhost for a browser preview. Plain-text import, pagination, and bookmarks work in the browser. PDF import and live translation require AI Pages.

AI Pages 0.2.6 adds local SQLite books. Use **Open book or language file** to pick a prepared book.sqlite in Android Files or Drive. Use the same button again to import the matching en.sqlite or another target language. The Android TXT/PDF picker also builds local books, including scanned pages through the existing OCR pipeline. Reopening the reader restores the current book and position.

**Offline files → Prepare this page** generates contextual word groups and a sentence translation with Luna. Each complete sentence is validated and committed before requesting the next one. Pausing keeps that progress. Reopening after process termination resumes an unfinished page. A saved translation works without a connection. **Save language file…** exports a standalone SQLite snapshot via the Android picker. Save to a fresh filename when a snapshot already exists. Import merges finished sentences and retains local progress. The original prepared book can be exported separately.

AI Pages 0.2.7 opens the reader to a book grid. The page connects to its built-in Google Drive catalogue automatically on first open. Pull down at the top of Books to refresh. Tapping a tile checks for updates, downloads its source and selected language as needed, and opens the saved reading position. The catalogue currently displays English. The translated-page count includes fully prepared pages offered by Drive or already available on the device.

To publish an update, upload the finished SQLite files to Drive first, then replace the contents of the same catalogue file. The version-1 JSON object contains a `books` array. Each book has a stable `id` (a lowercase slug), `title`, optional `author`, the SQLite metadata’s `bookId`, the total number of reader `pages`, and a `source` object with a Drive `fileId` and lowercase hex `sha256`. Each entry in `languages` (for example `en`) has its own file ID, checksum, and `readyPages` array of zero-based page numbers. Include a page only when every sentence has a completed translation. The reader keeps a local copy of the catalogue for offline access.


AI Pages 0.3.0 gives Language a private directory. Language opens the source and translation databases with bundled SQLite, imports documents, validates downloads, merges translations, and manages the catalogue offline. The upgrade reuses existing SQLite files, catalogue checkpoints, and bookmarks.

Tap the chapter beside the book title to see the table of contents and jump to its first sentence. The reader derives chapters from labels in the book, including repeated labels and chapters that start partway down a page. Unlabelled documents keep the page controls. On older AI Pages versions, the reader can collect available chapter labels through the existing page API when the picker first opens.

Prepared books can include inline illustrations. Add an optional SQLite table
`illustrations(sid INTEGER, position INTEGER, width INTEGER, height INTEGER, mime TEXT, alt TEXT, data BLOB, PRIMARY KEY(sid,position))`.
Each image appears before the sentence with the matching ID. Use the first caption sentence as its anchor. Images sharing an anchor are displayed in position order. Store JPEG, PNG, or WebP bytes and their pixel dimensions. Local and catalogue imports both keep these images offline on AI Pages 0.3.0 or later.
