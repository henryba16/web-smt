# Student Quiz & Chat Flow

## Overview
Students access interactive quizzes and AI chat through shareable links provided by teachers.

## Architecture

### 1. **Teacher Dashboard** (home.html)
- Upload textbook/curriculum
- Generate quiz from content
- Click "Share with students" → Get unique shareable link
- Copy & send link to students

### 2. **Student Quiz Flow** (student-quiz.html)
Access URL: `http://127.0.0.1:5173/student-quiz.html?quiz_id=<UUID>`

**Features:**
- One question per page (not overwhelming)
- Radio buttons to select answers
- Back/Next navigation
- Progress bar at top
- Submit at end
- Instant score + percentage
- AI-generated feedback for each question
  - ✓ Correct / ✗ Incorrect indicator
  - Brief explanation (1-2 sentences)
  - Learning tip for improvement

**Flow:**
```
Load Quiz → Display Q1 → [Select Answer] → Next Q2 → ... → Submit
  ↓
Calculate Score → Fetch AI Feedback → Display Results + Explanations
```

### 3. **Student Chat Flow** (student-chat.html)
Access URL: `http://127.0.0.1:5173/student-chat.html?doc_id=<UUID>`

**Features:**
- Interactive chat interface
- Ask questions about the textbook
- AI responds based on curriculum context
- Real-time message feed
- Mobile-friendly design

**Flow:**
```
Load Document → Display Chat → [Type Question] → Send
  ↓
API calls /api/ask → AI generates answer using textbook context
  ↓
Display response in chat
```

## Backend APIs

### Quiz APIs
- `POST /api/quiz-share` - Create shareable quiz with unique ID
  - Returns: `{ quizId, shareUrl }`
  
- `GET /api/quiz/:quizId` - Fetch quiz (public, no auth needed)
  - Returns: `{ quiz: { title, questions: [...] } }`
  
- `POST /api/quiz-submit` - Submit student answers
  - Payload: `{ quizId, answers: {...} }`
  - Returns: `{ score, total }`
  
- `POST /api/quiz-feedback` - AI evaluation of answers
  - Payload: `{ quiz, answers, attemptId }`
  - Returns: `{ details: [ { questionNum, isCorrect, feedback } ] }`

### Chat APIs
- `POST /api/ask` - Answer questions about curriculum
  - Payload: `{ question, documentId, level, goal }`
  - Returns: `{ answer, source }`

## Database Schema

### New Tables
- `quizzes` - Store teacher-created quizzes
  - id (UUID)
  - owner_id (teacher)
  - title, questions (JSONB)
  - is_shared (boolean)
  - created_at

- `quiz_responses` - Store student submissions
  - id (UUID)
  - quiz_id
  - answers (JSONB - answer indices)
  - score, total
  - created_at

### Existing Tables Used
- `documents` - Curriculum content (textbooks)
- `learning_sessions` - Q&A sessions
- `quizzes` - Quiz definitions

## File Structure
```
project/
├── student-quiz.html      # Student quiz page (paginated)
├── student-chat.html      # Student chat page
├── js/home.js             # Teacher dashboard (added share function)
├── server.cjs             # Backend APIs (added quiz-share, quiz-feedback)
├── supabase/migrations/
│   └── 202608230001_learning_schema.sql  # Updated with quizzes & quiz_responses tables
├── AI_PROMPT_GUIDELINES.md    # AI feedback generation guidelines
└── STUDENT_FLOW.md           # This file
```

## Workflow Example

### Teacher
1. Sign in → Upload OpenStax Physics PDF
2. Go to "Assessments" section
3. Click "Quick quiz" → Generates 5-10 questions
4. Click "Share with students"
5. Copy link: `http://127.0.0.1:5173/student-quiz.html?quiz_id=abc123def456`
6. Send to class (email, LMS, etc.)

### Student
1. Click teacher's link
2. Load Quiz: "Physics Quiz - Electric Circuits"
3. Read Q1 → Select answer → Click "Next"
4. Progress: 1/5 questions (progress bar fills)
5. Repeat for Q2-Q5
6. Click "Submit Quiz"
7. See score: 80% (4/5 correct)
8. Read AI feedback for each question:
   - Q1: ✓ Correct! Ohm's law is resistance = voltage/current...
   - Q2: ✗ Incorrect. Current flows from positive to negative terminal...

### Optional: Chat
Student can also click "Learn Together" to:
- Ask: "What is the difference between voltage and current?"
- Get AI response grounded in the uploaded textbook
- Continue conversation

## Configuration

### Environment Variables (`.env`)
```
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=...
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-3.1-flash-lite
API_PORT=8787
GEMINI_REQUEST_TIMEOUT_MS=90000
```

### AI Feedback Prompt
Located in `AI_PROMPT_GUIDELINES.md`
- Encourages students
- Explains misconceptions
- Provides learning tips
- Keeps explanations brief (1-3 sentences)

## Limitations & Future Work

**Current:**
- Quiz is one question per page
- Student quiz has no authentication (anyone with link can take it)
- Feedback is generated after submission (not real-time)
- No skill tracking or adaptive learning paths

**Future Enhancements:**
- Student profiles / progress tracking
- Skill mastery graphs
- Adaptive quiz difficulty based on performance
- Timed quizzes
- Question shuffling / randomization
- Integration with student management system (Clever, ClassLink, etc.)
- Teacher dashboard showing class performance analytics
- Open-ended (essay) questions with AI grading
