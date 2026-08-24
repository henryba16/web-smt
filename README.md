# Classroom AI MVP

Classroom AI is a teacher-facing MVP for generating differentiated lessons and diagnostic practice from curriculum sources. The current version supports:

- Email authentication with Supabase Auth.
- PDF/image textbook upload and multimodal OCR with Gemini.
- Original lesson upload with three differentiated versions: Support, Core, and Stretch.
- Multiple-choice quiz generation, browser-based submission, and weak-topic storage.
- Curriculum-grounded questions and answers.
- Lesson versions and quiz attempts stored in Supabase with RLS.

## Setup

1. Copy `.env.example` to `.env`.
2. Set `VITE_SBASE_URL` and `VITE_SBASE_PKEY` to your Supabase project URL and publishable key.
3. Set `GEMINI_API_KEY` using a key from Google AI Studio. Keep it server-only; never prefix it with `VITE_`.
4. Rotate any Supabase secret that was previously exposed. The browser only needs the publishable key in `VITE_SBASE_PKEY`.
5. Apply the migration in `supabase/migrations/202608230001_learning_schema.sql`.
6. Start the API in one terminal:

```powershell
npm.cmd run api
```

7. Start Vite in another terminal:

```powershell
npm.cmd run dev
```

Open the Vite URL, sign in, and visit `home.html`.

## Free AI for the hackathon

Gemini 2.5 Flash currently has free input/output token access with project-specific limits. Gemini Embedding also has a free tier if the pgvector pipeline is enabled later. Create a key at:

https://aistudio.google.com/apikey

See the current limits: https://ai.google.dev/gemini-api/docs/pricing

The prototype uses `gemini-3.1-flash-lite` by default. Set `GEMINI_FALLBACK_MODELS` as a comma-separated list and optionally tune `GEMINI_REQUEST_TIMEOUT_MS`. If Gemini returns quota, rate-limit, temporary overload, unavailable-model, or timeout errors, the API automatically tries the next configured model. Prompt and validation errors are returned immediately without wasting requests.

## Local test textbook

The `test-materials` folder contains the official OpenStax High School Physics PDF and a focused electric-circuits sample for upload testing:

- Full source: `test-materials/OpenStax-Physics.pdf`
- Focused upload sample: `test-materials/OpenStax-Physics-Electric-Circuits-Sample.pdf`
- Official source page: https://openstax.org/details/books/physics
- License: Creative Commons Attribution 4.0 International

## Current prototype boundary

The API currently keeps the latest processed textbook in memory for fast demos; restarting the server clears the query context. Metadata, lesson versions, and quiz attempts are stored in Supabase. The next production step is to chunk textbooks, call `gemini-embedding-001`, store 768-dimensional vectors in `document_chunks`, and call `match_document_chunks` before generation.
