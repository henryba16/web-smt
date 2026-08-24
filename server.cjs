const express = require('express')
const cors = require('cors')
const multer = require('multer')
const path = require('path')
const https = require('node:https')
const { createClient } = require('@supabase/supabase-js')
require('dotenv').config()

// Node 24's built-in fetch can fail with IPv6 DNS timeouts on some Windows hosts.
// Use the Node https module for Supabase calls so we hit a single, stable IPv4 path.
function headersToObject(input) {
    if (!input) return {}
    if (typeof input.entries === 'function') return Object.fromEntries(input.entries())
    if (Array.isArray(input)) return Object.fromEntries(input)
    return { ...input }
}

function httpsFetch(url, options = {}) {
    return new Promise((resolve, reject) => {
        try {
            const parsed = new URL(url)
            const req = https.request({
                method: options.method || 'GET',
                hostname: parsed.hostname,
                port: parsed.port || 443,
                path: parsed.pathname + parsed.search,
                headers: headersToObject(options.headers),
                family: 4
            }, (response) => {
                const chunks = []
                response.on('data', (chunk) => chunks.push(chunk))
                response.on('end', () => {
                    const body = Buffer.concat(chunks)
                    resolve({
                        ok: response.statusCode >= 200 && response.statusCode < 300,
                        status: response.statusCode,
                        statusText: response.statusMessage,
                        headers: new Headers(response.headers),
                        text: () => Promise.resolve(body.toString('utf8')),
                        json: () => Promise.resolve(JSON.parse(body.toString('utf8') || '{}')),
                        arrayBuffer: () => Promise.resolve(body)
                    })
                })
            })
        req.on('error', reject)
        if (options.body) {
            const payload = typeof options.body === 'string' || Buffer.isBuffer(options.body) ? options.body : Buffer.from(String(options.body))
            req.write(payload)
        }
        req.end()
        } catch (error) {
            reject(error)
        }
    })
}

const app = express()
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }
})
const port = Number(process.env.API_PORT || 8787)
const geminiModels = [
    process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite',
    ...(process.env.GEMINI_FALLBACK_MODELS || 'gemini-3.5-flash-lite,gemini-flash-lite-latest,gemini-3.6-flash')
        .split(',')
        .map((model) => model.trim())
        .filter(Boolean)
].filter((model, index, models) => models.indexOf(model) === index)
const geminiRequestTimeoutMs = Number(process.env.GEMINI_REQUEST_TIMEOUT_MS || 90000)
const embedModel = process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-001'
const embeddingDimensions = 768
const maxChunksPerDoc = Math.max(1, Number(process.env.MAX_EMBEDDING_CHUNKS || 120))

app.use(cors())
app.use(express.json({ limit: '2mb' }))

function requireApiKey(res) {
    if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY.startsWith('replace-')) {
        res.status(503).json({ error: 'Add GEMINI_API_KEY to .env before using AI features.' })
        return false
    }
    return true
}

async function authenticate(req, res) {
    const token = req.headers.authorization?.replace('Bearer ', '')
    if (!token) {
        res.status(401).json({ error: 'Authentication is required.' })
        return null
    }

    try {
        const supabase = createClient(process.env.VITE_SBASE_URL, process.env.VITE_SBASE_PKEY, {
            global: {
                headers: { Authorization: `Bearer ${token}` },
                fetch: httpsFetch
            }
        })
        const { data, error } = await supabase.auth.getUser()
        if (error || !data.user) {
            res.status(401).json({ error: 'Your session has expired. Please sign in again.' })
            return null
        }
        return { user: data.user, supabase }
    } catch (e) {
        console.error('authenticate error:', e)
        if (!res.headersSent) res.status(502).json({ error: e.message })
        return null
    }
}

async function generateContent(parts, responseMimeType = 'text/plain') {
    let lastError = null
    for (const model of geminiModels) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), geminiRequestTimeoutMs)
        let response
        let payload
        try {
            response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: controller.signal,
                body: JSON.stringify({
                    contents: [{ role: 'user', parts }],
                    generationConfig: { responseMimeType, temperature: 0.3 }
                })
            })
            payload = await response.json()
        } catch (error) {
            lastError = error.name === 'AbortError' ? new Error(`${model}: request timed out`) : error
            continue
        } finally {
            clearTimeout(timeout)
        }
        const message = payload.error?.message || 'Gemini request failed.'
        const fallbackEligible = [403, 404, 408, 409, 429, 500, 502, 503, 504].includes(response.status)
            || /quota|rate.?limit|resource.?exhausted|overloaded|temporar|not available|unavailable/i.test(message)
        if (response.ok) {
            return payload.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || ''
        }
        lastError = new Error(`${model}: ${message}`)
        if (!fallbackEligible) throw lastError
    }
    throw new Error(`All configured Gemini models failed. ${lastError?.message || ''}`.trim())
}

function contextPart(document) {
    return {
        text: `Study document: ${document.name}\n\n${document.context.slice(0, 60000)}`
    }
}

function parseJsonResponse(value) {
    const cleaned = value.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '')
    return JSON.parse(cleaned)
}

function publicSupabase() {
    return createClient(process.env.VITE_SBASE_URL, process.env.VITE_SBASE_PKEY, {
        global: { fetch: httpsFetch }
    })
}

function chunkText(text, size = 1100, overlap = 150) {
    const clean = String(text || '').replace(/\r\n/g, '\n').trim()
    if (!clean) return []
    if (clean.length <= size) return [clean]
    const chunks = []
    let start = 0
    while (start < clean.length && chunks.length < maxChunksPerDoc) {
        let end = Math.min(start + size, clean.length)
        if (end < clean.length) {
            const breakPoint = Math.max(clean.lastIndexOf('\n', end), clean.lastIndexOf('. ', end))
            if (breakPoint > start + size * 0.5) end = breakPoint + 1
        }
        const piece = clean.slice(start, end).trim()
        if (piece) chunks.push(piece)
        if (end >= clean.length) break
        start = Math.max(end - overlap, start + 1)
    }
    return chunks
}

async function embedTexts(texts, taskType = 'RETRIEVAL_DOCUMENT') {
    if (!texts.length) return []
    const vectors = []
    const batchSize = 50
    for (let offset = 0; offset < texts.length; offset += batchSize) {
        const batch = texts.slice(offset, offset + batchSize)
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${embedModel}:batchEmbedContents?key=${process.env.GEMINI_API_KEY}`
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                requests: batch.map((text) => ({
                    model: `models/${embedModel}`,
                    content: { parts: [{ text }] },
                    taskType,
                    outputDimensionality: embeddingDimensions
                }))
            })
        })
        let payload
        try { payload = await response.json() } catch { payload = {} }
        if (!response.ok) throw new Error(payload.error?.message || `Embedding failed (${response.status}).`)
        const batchVectors = (payload.embeddings || []).map((entry) => entry.values)
        if (batchVectors.length !== batch.length) throw new Error('Embedding response count mismatch.')
        vectors.push(...batchVectors)
    }
    return vectors
}

async function loadActiveDocument(supabase, ownerId, kind) {
    const { data: doc, error } = await supabase
        .from('documents')
        .select('id, name')
        .eq('owner_id', ownerId)
        .eq('kind', kind)
        .eq('status', 'ready')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
    if (error) throw error
    if (!doc) return null
    return loadDocumentText(supabase, ownerId, doc.id, doc.name, kind)
}

async function loadDocumentText(supabase, ownerId, documentId, name, knownKind) {
    const { data: docRow, error: docError } = await supabase
        .from('documents')
        .select('id, name, kind, owner_id')
        .eq('id', documentId)
        .maybeSingle()
    if (docError || !docRow) return null
    if (knownKind && docRow.kind && docRow.kind !== knownKind) return null
    if (ownerId && docRow.owner_id !== ownerId) return null
    const { data: rows, error: chunksError } = await supabase
        .from('document_chunks')
        .select('content, chunk_index')
        .eq('document_id', documentId)
        .order('chunk_index')
    if (chunksError) throw chunksError
    return {
        id: docRow.id,
        name: docRow.name,
        kind: docRow.kind || 'textbook',
        context: (rows || []).map((row) => row.content).join('\n\n')
    }
}

async function retrieveChunks(supabase, query, documentId, matchCount = 6) {
    const [queryVector] = await embedTexts([query], 'RETRIEVAL_QUERY')
    const { data, error } = await supabase.rpc('match_document_chunks', {
        query_embedding: queryVector,
        match_count: matchCount,
        requested_document_id: documentId || null
    })
    if (error) throw new Error(error.message)
    return data || []
}

async function buildStudyContext(auth, seedQuery) {
    const [sgk, lesson] = [
        await loadActiveDocument(auth.supabase, auth.user.id, 'textbook'),
        await loadActiveDocument(auth.supabase, auth.user.id, 'lesson')
    ]
    if (!sgk && !lesson) return null

    let sgkGrounding = ''
    if (sgk?.context) {
        try {
            const hits = await retrieveChunks(auth.supabase, seedQuery, sgk.id, 8)
            sgkGrounding = hits.map((hit) => hit.content).join('\n\n') || sgk.context.slice(0, 30000)
        } catch (retrievalError) {
            console.error('retrieveChunks fallback to full text:', retrievalError.message)
            sgkGrounding = sgk.context.slice(0, 30000)
        }
    }

    return {
        sgk,
        lesson,
        sgkGrounding,
        lessonContext: lesson?.context ? lesson.context.slice(0, 20000) : '',
        contextParts: () => {
            const parts = []
            if (sgkGrounding) parts.push({ text: `TEXTBOOK EXCERPTS (authoritative source of truth):\n${sgkGrounding}` })
            if (lessonContextSafe()) parts.push({ text: `TODAY'S LESSON:\n${lessonContextSafe()}` })
            return parts
        },
        primaryDocumentId: lesson?.id || sgk?.id || null,
        primarySourceName: lesson?.name || sgk?.name || ''
    }

    function lessonContextSafe() { return lesson?.context ? lesson.context.slice(0, 20000) : '' }
}

app.get('/api/health', (req, res) => {
    res.json({ ok: true, aiConfigured: Boolean(process.env.GEMINI_API_KEY && !process.env.GEMINI_API_KEY.startsWith('replace-')), primaryModel: geminiModels[0], fallbackModels: geminiModels.slice(1) })
})

app.post('/api/process-document', upload.single('document'), async (req, res) => {
    const auth = await authenticate(req, res)
    if (!auth) return
    if (!requireApiKey(res)) return
    if (!req.file) return res.status(400).json({ error: 'Please upload a PDF or image.' })
    const kind = ['textbook', 'lesson'].includes(req.body.kind) ? req.body.kind : 'textbook'

    const allowedTypes = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp']
    if (!allowedTypes.includes(req.file.mimetype)) {
        return res.status(400).json({ error: 'Only PDF, PNG, JPG, and WEBP files are supported.' })
    }

    try {
        const { data: document, error: documentError } = await auth.supabase
            .from('documents')
            .insert({
                owner_id: auth.user.id,
                name: req.file.originalname,
                mime_type: req.file.mimetype,
                size_bytes: req.file.size,
                kind,
                status: 'processing'
            })
            .select('id')
            .single()
        if (documentError) throw documentError

        const prompt = req.file.mimetype === 'application/pdf'
            ? 'Extract the study document faithfully. Preserve headings, page markers when visible, formulas, definitions, and examples. Return plain text only.'
            : 'Read this image carefully as OCR. Return all visible text, preserving headings, lists, formulas, and line breaks. Return plain text only.'
        const text = await generateContent([
            { text: prompt },
            { inline_data: { mime_type: req.file.mimetype, data: req.file.buffer.toString('base64') } }
        ])

        if (!text.trim()) {
            await auth.supabase.from('documents').update({ status: 'failed', error_message: 'No readable text found.' }).eq('id', document.id)
            return res.status(422).json({ error: 'No readable text was found in this file.' })
        }

        let embeddedChunks = 0
        let embeddingWarning = null
        try {
            const pieces = chunkText(text)
            if (pieces.length) {
                const vectors = await embedTexts(pieces)
                const rows = pieces.map((content, index) => ({
                    document_id: document.id,
                    owner_id: auth.user.id,
                    chunk_index: index,
                    content,
                    embedding: vectors[index]
                }))
                for (let offset = 0; offset < rows.length; offset += 50) {
                    const { error: chunksError } = await auth.supabase.from('document_chunks').insert(rows.slice(offset, offset + 50))
                    if (chunksError) throw chunksError
                }
                embeddedChunks = rows.length
                if (text.length > maxChunksPerDoc * 1100) {
                    embeddingWarning = `Only the first ${maxChunksPerDoc} chunks were embedded.`
                }
            }
        } catch (embeddingError) {
            embeddingWarning = embeddingError.message
            console.error('Embedding pipeline warning:', embeddingError.message)
        }

        await auth.supabase.from('documents').update({ status: 'ready', extracted_characters: text.length }).eq('id', document.id)
        res.json({ ok: true, id: document.id, name: req.file.originalname, kind, characters: text.length, chunks: embeddedChunks, warning: embeddingWarning })
    } catch (error) {
        console.error('process-document failed:', error)
        await auth.supabase.from('documents').update({ status: 'failed', error_message: error.message }).eq('owner_id', auth.user.id).eq('status', 'processing')
        res.status(502).json({ error: error.message })
    }
})

app.post('/api/upload-lesson', upload.single('lesson'), async (req, res) => {
    const auth = await authenticate(req, res)
    if (!auth) return
    if (!requireApiKey(res)) return
    if (!req.file) return res.status(400).json({ error: 'Please upload a lesson image or PDF.' })

    const allowedTypes = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp']
    if (!allowedTypes.includes(req.file.mimetype)) {
        return res.status(400).json({ error: 'Only PDF, PNG, JPG, and WEBP files are supported.' })
    }

    try {
        const { data: doc, error: docError } = await auth.supabase
            .from('documents')
            .insert({
                owner_id: auth.user.id,
                name: req.file.originalname,
                mime_type: req.file.mimetype,
                size_bytes: req.file.size,
                kind: 'lesson',
                status: 'processing'
            })
            .select('id')
            .single()
        if (docError) throw docError

        const lessonText = await generateContent([
            { text: 'Read this lesson accurately. Extract and return JSON with: title, objectives (array), topics (array), activities (array), key_concepts (array). Return valid JSON only.' },
            { inline_data: { mime_type: req.file.mimetype, data: req.file.buffer.toString('base64') } }
        ], 'application/json')

        const lessonData = parseJsonResponse(lessonText)

        const sgk = await loadActiveDocument(auth.supabase, auth.user.id, 'textbook')
        let alignment = null
        if (sgk?.context && lessonData.topics?.length) {
            const seed = lessonData.topics.join(', ') + ' ' + (lessonData.objectives || []).join(', ')
            try {
                const hits = await retrieveChunks(auth.supabase, seed, sgk.id, 12)
                const sgkGrounding = hits.map((h) => h.content).join('\n\n') || sgk.context.slice(0, 20000)
                const alignPrompt = `Compare the lesson below with the textbook excerpts. For each lesson topic/concept, state if the textbook AGREES, CONTRADICTS, or is MISSING. List specific page/heading references when available. Return JSON: { "alignment": [ { "topic": "...", "status": "agrees|contradicts|missing", "details": "...", "textbook_ref": "..." } ], "summary": "..." }`
                const alignResult = await generateContent([
                    { text: alignPrompt },
                    { text: `LESSON:\n${JSON.stringify(lessonData, null, 2)}` },
                    { text: `TEXTBOOK EXCERPTS:\n${sgkGrounding}` }
                ], 'application/json')
                alignment = parseJsonResponse(alignResult)
            } catch (e) {
                alignment = { alignment: [], summary: 'Alignment check failed: ' + e.message }
            }
        } else if (!sgk) {
            alignment = { alignment: [], summary: 'No textbook uploaded yet — cannot check alignment.' }
        }

        await auth.supabase.from('documents').update({ status: 'ready', extracted_characters: lessonText.length }).eq('id', doc.id)
        res.json({ ok: true, id: doc.id, name: req.file.originalname, lesson: lessonData, alignment })
    } catch (error) {
        console.error('upload-lesson failed:', error)
        await auth.supabase.from('documents').update({ status: 'failed', error_message: error.message }).eq('owner_id', auth.user.id).eq('status', 'processing')
        res.status(502).json({ error: error.message })
    }
})

app.delete('/api/document/:docId', async (req, res) => {
    const auth = await authenticate(req, res)
    if (!auth) return
    try {
        const { data: doc, error: docError } = await auth.supabase
            .from('documents')
            .select('id')
            .eq('id', req.params.docId)
            .eq('owner_id', auth.user.id)
            .single()
        if (docError || !doc) {
            return res.status(404).json({ error: 'Document not found.' })
        }
        await auth.supabase.from('document_chunks').delete().eq('document_id', req.params.docId)
        await auth.supabase.from('documents').delete().eq('id', req.params.docId)
        res.json({ ok: true })
    } catch (error) {
        res.status(502).json({ error: error.message })
    }
})

app.post('/api/ask', async (req, res) => {
    const auth = await authenticate(req, res)
    if (!auth) return
    if (!requireApiKey(res)) return
    const { question, level = 'intermediate', goal = 'practice' } = req.body
    if (!question?.trim()) return res.status(400).json({ error: 'Question is required.' })

    let study
    try {
        study = await buildStudyContext(auth, question.trim())
    } catch (error) {
        return res.status(502).json({ error: error.message })
    }
    if (!study) return res.status(400).json({ error: 'Process a study document before asking a question.' })

    try {
        const answer = await generateContent([
            { text: `You are a patient study guide. Answer in English using only the supplied textbook excerpts and today's lesson. The textbook is the authoritative source of truth. Adapt explanation to level: ${level}. Learner goal: ${goal}. If the sources do not contain the answer, say so clearly. End with a short "Sources" section naming the relevant heading or page marker when available.\n\nQuestion: ${question.trim()}` },
            ...study.contextParts()
        ])
        const { data: session, error: sessionError } = await auth.supabase
            .from('learning_sessions')
            .insert({ owner_id: auth.user.id, document_id: study.primaryDocumentId, question: question.trim(), answer, source: [{ name: study.primarySourceName }], level, goal })
            .select('id')
            .single()
        if (sessionError) throw sessionError
        res.json({ ok: true, sessionId: session.id, answer, source: study.primarySourceName })
    } catch (error) {
        res.status(502).json({ error: error.message })
    }
})

app.post('/api/quiz', async (req, res) => {
    const auth = await authenticate(req, res)
    if (!auth) return
    if (!requireApiKey(res)) return
    const { level = 'intermediate', count = 5, topic } = req.body

    let study
    try {
        const seed = topic?.trim()
            || (await loadActiveDocument(auth.supabase, auth.user.id, 'lesson'))?.name
            || 'key concepts and definitions'
        study = await buildStudyContext(auth, seed)
    } catch (error) {
        return res.status(502).json({ error: error.message })
    }
    if (!study) return res.status(400).json({ error: 'Process a study document before generating a quiz.' })

    try {
        const quiz = await generateContent([
            { text: `Create ${Math.min(Number(count) || 5, 10)} multiple-choice questions in English for a ${level} learner. Each question MUST include at least ONE distractor based on a COMMON MISCONCEPTION about the topic (e.g., for electricity: "current flows like water in a pipe", "voltage is the amount of current", "resistance slows down current like friction"). Return valid JSON only as an array of objects with keys: question, options (array of 4 strings), answer (zero-based number), explanation, topic, misconception_hint (string describing the misconception the distractor targets). Ground all content in the supplied document — do not invent facts.` },
            ...study.contextParts()
        ], 'application/json')
        res.json({ ok: true, quiz: parseJsonResponse(quiz), source: study.primarySourceName })
    } catch (error) {
        res.status(502).json({ error: error.message })
    }
})

app.post('/api/lesson-plan', upload.single('lesson'), async (req, res) => {
    const auth = await authenticate(req, res)
    if (!auth) return
    if (!requireApiKey(res)) return
    const document = await loadActiveDocument(auth.supabase, auth.user.id, 'textbook')
    if (!document) return res.status(400).json({ error: 'Process a textbook before generating a lesson.' })
    if (!req.file) return res.status(400).json({ error: 'Upload an original lesson image or PDF.' })

    const allowedTypes = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp']
    if (!allowedTypes.includes(req.file.mimetype)) {
        return res.status(400).json({ error: 'Only PDF, PNG, JPG, and WEBP files are supported.' })
    }

    try {
        const lessonText = await generateContent([
            { text: 'Read this lesson accurately. Preserve its title, objectives, activities, questions, timing, and line breaks. Return plain text only.' },
            { inline_data: { mime_type: req.file.mimetype, data: req.file.buffer.toString('base64') } }
        ])
        const lesson = await generateContent([
            { text: `You are an expert instructional designer. Using ONLY the original lesson and textbook content below, create three versions of the same lesson. Return valid JSON in this exact shape: [{"level":"support|core|stretch","label":"...","objective":"...","activities":["..."],"assessment":"...","homework":"..."}]. Give each version a clear objective, feasible classroom activities, and an appropriate level of challenge. Do not invent content outside the textbook.\n\nORIGINAL LESSON:\n${lessonText.slice(0, 18000)}` },
            contextPart(document)
        ], 'application/json')
        const versions = parseJsonResponse(lesson)
        const { data: savedLesson, error: lessonError } = await auth.supabase.from('lessons').insert({
            owner_id: auth.user.id,
            document_id: document.id,
            title: versions[0]?.objective || req.file.originalname,
            source_text: lessonText
        }).select('id').single()
        if (lessonError) throw lessonError
        const { error: versionsError } = await auth.supabase.from('lesson_versions').insert(versions.map((version) => ({
            lesson_id: savedLesson.id,
            owner_id: auth.user.id,
            level: version.level,
            content: version
        })))
        if (versionsError) throw versionsError
        res.json({ ok: true, source: document.name, versions })
    } catch (error) {
        res.status(502).json({ error: error.message })
    }
})

app.post('/api/quiz-attempt', async (req, res) => {
    const auth = await authenticate(req, res)
    if (!auth) return
    const { documentId = null, totalQuestions, correctAnswers, topics = [] } = req.body
    if (!Number.isInteger(totalQuestions) || totalQuestions < 1 || !Number.isInteger(correctAnswers)) {
        return res.status(400).json({ error: 'The quiz result data is invalid.' })
    }
    const { data, error } = await auth.supabase.from('quiz_attempts').insert({
        owner_id: auth.user.id,
        document_id: documentId,
        total_questions: totalQuestions,
        correct_answers: Math.max(0, Math.min(correctAnswers, totalQuestions)),
        topics: Array.isArray(topics) ? topics.slice(0, 20) : []
    }).select('id, correct_answers, total_questions, topics, created_at').single()
    if (error) return res.status(502).json({ error: error.message })
    res.json({ ok: true, attempt: data })
})

app.post('/api/quiz-share', async (req, res) => {
    const auth = await authenticate(req, res)
    if (!auth) return
    if (!requireApiKey(res)) return
    const { quizData, title } = req.body
    if (!quizData || !Array.isArray(quizData.questions)) {
        return res.status(400).json({ error: 'Invalid quiz data.' })
    }
    try {
        const { data, error } = await auth.supabase.from('quizzes').insert({
            owner_id: auth.user.id,
            title: title || 'Quiz',
            questions: quizData.questions,
            is_shared: true
        }).select('id').single()
        if (error) throw error
        const shareUrl = `http://127.0.0.1:5173/student-quiz.html?quiz_id=${data.id}`
        res.json({ ok: true, quizId: data.id, shareUrl })
    } catch (error) {
        res.status(502).json({ error: error.message })
    }
})

app.get('/api/quiz/:quizId', async (req, res) => {
    try {
        const supabase = publicSupabase()
        const { data, error } = await supabase
            .from('quizzes')
            .select('id, title, questions, created_at')
            .eq('id', req.params.quizId)
            .eq('is_shared', true)
            .single()
        if (error || !data) {
            return res.status(404).json({ error: 'Quiz not found.' })
        }
        res.json({ ok: true, quiz: data })
    } catch (error) {
        res.status(502).json({ error: error.message })
    }
})

app.get('/api/quiz-responses/:quizId', async (req, res) => {
    try {
        const supabase = publicSupabase()
        const { data, error } = await supabase
            .from('quiz_responses')
            .select('id, answers, score, total, created_at')
            .eq('quiz_id', req.params.quizId)
            .order('created_at', { ascending: false })
        if (error) throw error
        res.json({ ok: true, responses: data || [] })
    } catch (error) {
        res.status(502).json({ error: error.message })
    }
})

app.post('/api/quiz-submit', async (req, res) => {
    const { quizId, answers, studentName } = req.body
    if (!quizId || !answers || typeof answers !== 'object') {
        return res.status(400).json({ error: 'Invalid submission data.' })
    }
    try {
        const supabase = publicSupabase()
        const { data: quiz, error: quizError } = await supabase
            .from('quizzes')
            .select('questions')
            .eq('id', quizId)
            .single()
        if (quizError || !quiz) {
            return res.status(404).json({ error: 'Quiz not found.' })
        }

        let correct = 0
        quiz.questions.forEach((q, idx) => {
            if (q.answer === answers[idx]) correct++
        })

        const { data: attempt, error: insertError } = await supabase.from('quiz_responses').insert({
            quiz_id: quizId,
            answers: answers,
            score: correct,
            total: quiz.questions.length,
            student_name: studentName || null
        }).select('id').single()
        if (insertError) throw insertError

        res.json({ ok: true, attemptId: attempt.id, score: correct, total: quiz.questions.length })
    } catch (error) {
        res.status(502).json({ error: error.message })
    }
})

app.post('/api/quiz-feedback', async (req, res) => {
    if (!requireApiKey(res)) return
    const { quiz, answers, attemptId } = req.body
    if (!quiz?.questions || !answers || typeof answers !== 'object') {
        return res.status(400).json({ error: 'Invalid feedback request.' })
    }
    try {
        const feedbackPrompt = quiz.questions.map((q, idx) => {
            const selectedIdx = answers[idx]
            const isCorrect = q.answer === selectedIdx
            return `Q${idx + 1}. "${q.question}"\nStudent picked: "${q.options[selectedIdx] || 'N/A'}"\nCorrect: "${q.options[q.answer]}"\nWas correct: ${isCorrect}\nExplanation: ${q.explanation || 'N/A'}`
        }).join('\n\n')

        const aiEval = await generateContent([
            { text: `You are an expert teacher evaluating student quiz responses. For each question, provide VERY BRIEF (1-2 sentences max) personalized feedback on why the answer was right/wrong and a learning tip. Format as JSON: [{"questionNum":1,"isCorrect":true,"feedback":"..."}]. Be encouraging but honest.\n\n${feedbackPrompt}` }
        ], 'application/json')

        const details = parseJsonResponse(aiEval)
        res.json({ ok: true, details })
    } catch (error) {
        res.status(502).json({ error: error.message })
    }
})

app.post('/api/test-create-quiz', async (req, res) => {
    const auth = await authenticate(req, res)
    if (!auth) return
    try {
        const quizData = {
            title: 'Physics Quiz - Electric Circuits (Test)',
            questions: [
                {
                    question: "What is Ohm's Law?",
                    options: ['V = IR', 'P = IV', 'R = V/I', 'I = V/R'],
                    answer: 0,
                    explanation: "Ohm's Law states that voltage equals current times resistance (V = IR).",
                    topic: 'Ohm\'s Law'
                },
                {
                    question: 'In a series circuit, how does current behave?',
                    options: ['It increases at each component', 'It remains constant throughout', 'It decreases at each component', 'It varies randomly'],
                    answer: 1,
                    explanation: 'In a series circuit, current is the same everywhere in the circuit.',
                    topic: 'Circuit Basics'
                },
                {
                    question: 'What is the SI unit of resistance?',
                    options: ['Ampere', 'Volt', 'Ohm', 'Watt'],
                    answer: 2,
                    explanation: 'The SI unit of electrical resistance is the Ohm (Ω).',
                    topic: 'Units & Measurement'
                }
            ]
        }
        const { data, error } = await auth.supabase.from('quizzes').insert({
            owner_id: auth.user.id,
            title: quizData.title,
            questions: quizData.questions,
            is_shared: true
        }).select('id').single()
        if (error) throw error
        const shareUrl = `http://127.0.0.1:5173/student-quiz.html?quiz_id=${data.id}`
        res.json({ ok: true, quizId: data.id, shareUrl })
    } catch (error) {
        res.status(502).json({ error: error.message })
    }
})

app.post('/api/misconceptions', async (req, res) => {
    const auth = await authenticate(req, res)
    if (!auth) return
    if (!requireApiKey(res)) return
    const { quizResponseId, studentId, quiz, answers } = req.body
    if (!quiz?.questions || !answers || typeof answers !== 'object') {
        return res.status(400).json({ error: 'Invalid misconception request.' })
    }
    try {
        const feedbackPrompt = quiz.questions.map((q, idx) => {
            const selectedIdx = answers[idx]
            const isCorrect = q.answer === selectedIdx
            return `Q${idx + 1}. "${q.question}"\nStudent picked: "${q.options[selectedIdx] || 'N/A'}"\nCorrect: "${q.options[q.answer]}"\nWas correct: ${isCorrect}\nExplanation: ${q.explanation || 'N/A'}\nTopic: ${q.topic || 'General'}`
        }).join('\n\n')

        const aiEval = await generateContent([{
            text: `You are an expert teacher analyzing student misconceptions. For each INCORRECT answer, identify the specific misconception, state the correct concept, and provide a brief explanation. Return valid JSON array: [{"topic":"...","misconception":"...","correctConcept":"...","explanation":"...","confidence":80}]. Only include entries for wrong answers. If all correct, return [].\n\n${feedbackPrompt}`
        }], 'application/json')

        const misconceptions = parseJsonResponse(aiEval)
        if (misconceptions.length > 0) {
            const { error } = await auth.supabase.from('misconceptions').insert(misconceptions.map((m) => ({
                owner_id: auth.user.id,
                student_id: studentId,
                quiz_response_id: quizResponseId,
                topic: m.topic,
                misconception: m.misconception,
                correct_concept: m.correctConcept,
                explanation: m.explanation,
                confidence: m.confidence || 80
            })))
            if (error) throw error
        }
        res.json({ ok: true, misconceptions })
    } catch (error) {
        res.status(502).json({ error: error.message })
    }
})

// Public endpoint for students: resolve studentName → UUID, then store misconceptions
app.post('/api/misconceptions-public', async (req, res) => {
    if (!requireApiKey(res)) return
    const { quizResponseId, studentName, quiz, answers } = req.body
    if (!quiz?.questions || !answers || typeof answers !== 'object' || !studentName) {
        return res.status(400).json({ error: 'Invalid misconception request.' })
    }
    try {
        const supabase = publicSupabase()
        // Get or create student
        let student
        const { data: existing } = await supabase
            .from('students')
            .select('id')
            .eq('display_name', studentName)
            .limit(1)
            .maybeSingle()
        if (existing) {
            student = existing
        } else {
            const { data: created, error: createErr } = await supabase
                .from('students')
                .insert({ owner_id: '00000000-0000-0000-0000-000000000000', display_name: studentName })
                .select('id')
                .single()
            if (createErr) throw createErr
            student = created
        }

        const feedbackPrompt = quiz.questions.map((q, idx) => {
            const selectedIdx = answers[idx]
            const isCorrect = q.answer === selectedIdx
            return `Q${idx + 1}. "${q.question}"\nStudent picked: "${q.options[selectedIdx] || 'N/A'}"\nCorrect: "${q.options[q.answer]}"\nWas correct: ${isCorrect}\nExplanation: ${q.explanation || 'N/A'}\nTopic: ${q.topic || 'General'}`
        }).join('\n\n')

        const aiEval = await generateContent([{
            text: `You are an expert teacher analyzing student misconceptions. For each INCORRECT answer, identify the specific misconception, state the correct concept, and provide a brief explanation. Return valid JSON array: [{"topic":"...","misconception":"...","correctConcept":"...","explanation":"...","confidence":80}]. Only include entries for wrong answers. If all correct, return [].\n\n${feedbackPrompt}`
        }], 'application/json')

        const misconceptions = parseJsonResponse(aiEval)
        if (misconceptions.length > 0) {
            const { error } = await supabase.from('misconceptions').insert(misconceptions.map((m) => ({
                owner_id: '00000000-0000-0000-0000-000000000000',
                student_id: student.id,
                quiz_response_id: quizResponseId,
                topic: m.topic,
                misconception: m.misconception,
                correct_concept: m.correctConcept,
                explanation: m.explanation,
                confidence: m.confidence || 80
            })))
            if (error) throw error
        }
        res.json({ ok: true, misconceptions })
    } catch (error) {
        res.status(502).json({ error: error.message })
    }
})

// Public endpoint for students: resolve studentName → UUID, then upsert skill_radar
app.post('/api/skill-radar-public', async (req, res) => {
    if (!requireApiKey(res)) return
    const { studentName, topic, masteryScore, attempts = 1 } = req.body
    if (!studentName || !topic || !Number.isInteger(masteryScore)) {
        return res.status(400).json({ error: 'Invalid skill radar data.' })
    }
    try {
        const supabase = publicSupabase()
        // Get or create student
        let student
        const { data: existing } = await supabase
            .from('students')
            .select('id')
            .eq('display_name', studentName)
            .limit(1)
            .maybeSingle()
        if (existing) {
            student = existing
        } else {
            const { data: created, error: createErr } = await supabase
                .from('students')
                .insert({ owner_id: '00000000-0000-0000-0000-000000000000', display_name: studentName })
                .select('id')
                .single()
            if (createErr) throw createErr
            student = created
        }

        const { data, error } = await supabase.from('skill_radar').upsert({
            owner_id: '00000000-0000-0000-0000-000000000000',
            student_id: student.id,
            topic,
            mastery_score: Math.max(0, Math.min(100, masteryScore)),
            attempts,
            last_assessed: new Date().toISOString()
        }, { onConflict: 'owner_id,student_id,topic' }).select().single()
        if (error) throw error
        res.json({ ok: true, skill: data })
    } catch (error) {
        res.status(502).json({ error: error.message })
    }
})

app.post('/api/skill-radar', async (req, res) => {
    const auth = await authenticate(req, res)
    if (!auth) return
    const { studentId, topic, masteryScore, attempts = 1 } = req.body
    if (!studentId || !topic || !Number.isInteger(masteryScore)) {
        return res.status(400).json({ error: 'Invalid skill radar data.' })
    }
    try {
        const { data, error } = await auth.supabase.from('skill_radar').upsert({
            owner_id: auth.user.id,
            student_id: studentId,
            topic,
            mastery_score: Math.max(0, Math.min(100, masteryScore)),
            attempts,
            last_assessed: new Date().toISOString()
        }, { onConflict: 'owner_id,student_id,topic' }).select().single()
        if (error) throw error
        res.json({ ok: true, skill: data })
    } catch (error) {
        res.status(502).json({ error: error.message })
    }
})

app.get('/api/skill-radar/:studentId', async (req, res) => {
    const auth = await authenticate(req, res)
    if (!auth) return
    try {
        const { data, error } = await auth.supabase.from('skill_radar').select('topic,mastery_score,attempts,last_assessed').eq('student_id', req.params.studentId).eq('owner_id', auth.user.id).order('mastery_score', { ascending: false })
        if (error) throw error
        res.json({ ok: true, skills: data })
    } catch (error) {
        res.status(502).json({ error: error.message })
    }
})

app.post('/api/class-analytics', async (req, res) => {
    const auth = await authenticate(req, res)
    if (!auth) return
    const { classId, topic, studentScores } = req.body
    if (!classId || !topic || !Array.isArray(studentScores)) {
        return res.status(400).json({ error: 'Invalid class analytics data.' })
    }
    try {
        const scores = studentScores.map((s) => s.score).filter((n) => Number.isInteger(n))
        if (scores.length === 0) return res.json({ ok: true, analytics: null })
        scores.sort((a, b) => a - b)
        const median = scores.length % 2 === 0
            ? (scores[scores.length / 2 - 1] + scores[scores.length / 2]) / 2
            : scores[Math.floor(scores.length / 2)]
        const mean = scores.reduce((a, b) => a + b, 0) / scores.length
        const variance = scores.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / scores.length
        const stdDev = Math.sqrt(variance)
        const weakStudents = studentScores.filter((s) => s.score < median * 0.7).map((s) => ({ id: s.studentId, score: s.score }))
        const strongStudents = studentScores.filter((s) => s.score > median * 1.3).map((s) => ({ id: s.studentId, score: s.score }))

        const { data, error } = await auth.supabase.from('class_analytics').upsert({
            owner_id: auth.user.id,
            class_id: classId,
            topic,
            median_score: Math.round(median),
            mean_score: Number(mean.toFixed(2)),
            std_dev: Number(stdDev.toFixed(2)),
            student_count: scores.length,
            weak_students: weakStudents,
            strong_students: strongStudents,
            assessed_at: new Date().toISOString()
        }, { onConflict: 'owner_id,class_id,topic' }).select().single()
        if (error) throw error
        res.json({ ok: true, analytics: data })
    } catch (error) {
        res.status(502).json({ error: error.message })
    }
})

app.get('/api/class-analytics/:classId', async (req, res) => {
    const auth = await authenticate(req, res)
    if (!auth) return
    try {
        const { data, error } = await auth.supabase.from('class_analytics').select('topic,median_score,mean_score,std_dev,student_count,weak_students,strong_students,assessed_at').eq('class_id', req.params.classId).eq('owner_id', auth.user.id).order('assessed_at', { ascending: false })
        if (error) throw error
        res.json({ ok: true, analytics: data })
    } catch (error) {
        res.status(502).json({ error: error.message })
    }
})

app.post('/api/differentiated-lessons', async (req, res) => {
    const auth = await authenticate(req, res)
    if (!auth) return
    if (!requireApiKey(res)) return
    const { lessonText, lessonDocumentId, classAnalytics, skillRadar } = req.body

    let resolvedLessonText = typeof lessonText === 'string' ? lessonText.trim() : ''
    let lessonSourceName = 'Pasted lesson text'
    try {
        if (!resolvedLessonText && lessonDocumentId) {
            const lessonDoc = await loadDocumentText(auth.supabase, auth.user.id, lessonDocumentId)
            if (lessonDoc?.context) {
                resolvedLessonText = lessonDoc.context
                lessonSourceName = lessonDoc.name
            }
        }
        if (!resolvedLessonText) {
            const latestLesson = await loadActiveDocument(auth.supabase, auth.user.id, 'lesson')
            if (latestLesson?.context) {
                resolvedLessonText = latestLesson.context
                lessonSourceName = latestLesson.name
            }
        }
        if (!resolvedLessonText) {
            return res.status(400).json({ error: 'Upload today\'s lesson or paste its text first.' })
        }

        const study = await buildStudyContext(auth, resolvedLessonText.slice(0, 800))
        const analyticsContext = classAnalytics ? `\nCLASS ANALYTICS:\n${JSON.stringify(classAnalytics, null, 2)}` : ''
        const radarContext = skillRadar ? `\nSKILL RADAR:\n${JSON.stringify(skillRadar, null, 2)}` : ''
        const lesson = await generateContent([{
            text: `You are an expert instructional designer. Using the textbook content, class analytics, and skill radar data, create THREE differentiated versions of the same lesson: SUPPORT (for struggling students), CORE (for on-level students), and STRETCH (for advanced students). Return valid JSON array: [{"level":"support","label":"Support","objective":"...","activities":["..."],"assessment":"...","homework":"..."},{"level":"core","label":"Core","objective":"...","activities":["..."],"assessment":"...","homework":"..."},{"level":"stretch","label":"Stretch","objective":"...","activities":["..."],"assessment":"...","homework":"..."}]. Each version must have a clear objective, 3-5 activities, formative assessment, and homework. Address misconceptions from analytics.${analyticsContext}${radarContext}\n\nORIGINAL LESSON:\n${resolvedLessonText.slice(0, 18000)}`
        }, ...(study ? study.contextParts() : [])], 'application/json')
        const versions = parseJsonResponse(lesson)
        const { data: savedLesson, error: lessonError } = await auth.supabase.from('lessons').insert({
            owner_id: auth.user.id,
            document_id: study?.primaryDocumentId || null,
            title: versions[0]?.objective || 'Differentiated Lesson',
            source_text: resolvedLessonText
        }).select('id').single()
        if (lessonError) throw lessonError
        const { error: versionsError } = await auth.supabase.from('lesson_versions').insert(versions.map((version) => ({
            lesson_id: savedLesson.id,
            owner_id: auth.user.id,
            level: version.level,
            content: version
        })))
        if (versionsError) throw versionsError
        res.json({ ok: true, source: lessonSourceName, lessonId: savedLesson.id, versions })
    } catch (error) {
        res.status(502).json({ error: error.message })
    }
})

app.post('/api/assign-lessons', async (req, res) => {
    const auth = await authenticate(req, res)
    if (!auth) return
    if (!requireApiKey(res)) return
    const { lessonId, classId = 'default-class' } = req.body
    if (!lessonId) return res.status(400).json({ error: 'lessonId required.' })

    try {
        const supabase = auth.supabase

        const { data: versions, error: vErr } = await supabase
            .from('lesson_versions')
            .select('id, level, content')
            .eq('lesson_id', lessonId)
            .eq('owner_id', auth.user.id)
        if (vErr) throw vErr
        if (!versions?.length) return res.status(404).json({ error: 'Lesson versions not found.' })

        const { data: classAnalytics, error: caErr } = await supabase
            .from('class_analytics')
            .select('topic,median_score,weak_students')
            .eq('class_id', classId)
            .eq('owner_id', auth.user.id)
        if (caErr) throw caErr

        const { data: students, error: sErr } = await supabase
            .from('students')
            .select('id, display_name')
            .eq('class_id', classId)
        if (sErr) throw sErr

        const studentLevels = await Promise.all((students || []).map(async (student) => {
            const { data: radar } = await supabase
                .from('skill_radar')
                .select('topic,mastery_score')
                .eq('student_id', student.id)
                .eq('owner_id', auth.user.id)

            let level = 'core'
            if (radar?.length) {
                const weakTopics = radar.filter(r => r.mastery_score < 60).map(r => r.topic)
                const strongTopics = radar.filter(r => r.mastery_score >= 80).map(r => r.topic)
                if (weakTopics.length > strongTopics.length) level = 'support'
                else if (strongTopics.length > weakTopics.length) level = 'stretch'
            } else {
                const isWeak = (classAnalytics || []).some(ca =>
                    ca.weak_students?.some(ws => ws.id === student.id)
                )
                if (isWeak) level = 'support'
            }

            return { studentId: student.id, studentName: student.display_name, level }
        }))

        const assignments = []
        for (const { studentId, studentName, level } of studentLevels) {
            const version = versions.find(v => v.level === level)
            if (!version) continue
            const { data: assignment } = await supabase.from('assignments').insert({
                owner_id: auth.user.id,
                lesson_version_id: version.id,
                student_id: studentId,
                level,
                status: 'assigned'
            }).select('id').single()
            assignments.push({ id: assignment.id, studentName, level, link: `http://127.0.0.1:5173/student-lesson.html?aid=${assignment.id}` })
        }

        res.json({ ok: true, assignments })
    } catch (error) {
        res.status(502).json({ error: error.message })
    }
})

app.listen(port, () => {
    console.log(`LearnSpace API listening at http://localhost:${port}`)
})

app.use((error, req, res, _next) => {
    if (error?.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'File exceeds the 10 MB limit. Compress the PDF or upload a smaller chapter.' })
    }
    if (error?.code === 'LIMIT_UNEXPECTED_FILE') {
        return res.status(400).json({ error: `Unexpected upload field "${error.field}".` })
    }
    console.error('Unhandled API error:', error)
    if (!res.headersSent) res.status(500).json({ error: error.message || 'Server error.' })
})
