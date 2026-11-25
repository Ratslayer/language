# Language Reader
Open a UTF-8 text file (up to 4 MiB), choose the reading and translation languages, then tap a word for its meaning and dictionary form in context. Tap **Translate sentence** to reveal the whole translation. Exceptionally long sentences use a shorter local excerpt.

AI Pages 0.2.1 or later provides the Android file picker, ChatGPT sign-in, storage, and the fast-text profile (gpt-6-luna with reasoning effort none). Each new lookup asks for approval. Recent translations and the page bookmark are saved locally. Short texts reopen automatically. For longer texts, reselect the same file to resume.

Run `npm ci && npm run build` and serve `dist/` over localhost for a browser preview. File import, pagination, and bookmarks work in the browser. Live translation requires AI Pages.
