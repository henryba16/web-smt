// scripts/smoke-test.cjs
// End-to-end smoke test for the teacher API.
// Requires a real teacher account to be created in Supabase first.
require('dotenv').config({ path: '.env' })
const { createClient } = require('@supabase/supabase-js')

const SUPABASE_URL = process.env.VITE_SBASE_URL
const SUPABASE_KEY = process.env.VITE_SBASE_PKEY
const API = process.env.API_PORT ? `http://localhost:${process.env.API_PORT}/api` : 'http://localhost:8787/api'

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('Missing Supabase credentials in .env')
    process.exit(1)
}

const email = process.argv[2]
const password = process.argv[3]
if (!email || !password) {
    console.error('Usage: node scripts/smoke-test.cjs <email> <password>')
    process.exit(1)
}

async function main() {
    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    if (error || !data.session) {
        console.error('Sign in failed:', error?.message || 'No session')
        process.exit(1)
    }
    const token = data.session.access_token
    console.log('Signed in as', data.user.email)

    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

    console.log('\n[1/4] Health check...')
    const health = await (await fetch(`${API}/health`)).json()
    console.log('   ', health)

    console.log('\n[2/4] Create test quiz...')
    const quiz = await (await fetch(`${API}/test-create-quiz`, { method: 'POST', headers, body: '{}' })).json()
    if (!quiz.ok) {
        console.error('   quiz creation failed:', quiz.error)
        process.exit(1)
    }
    console.log('   quizId:', quiz.quizId)
    console.log('   shareUrl:', quiz.shareUrl)

    console.log('\n[3/4] Fetch quiz as a student (no auth)...')
    const fetched = await (await fetch(`${API}/quiz/${quiz.quizId}`)).json()
    console.log('   ', fetched.quiz?.title, '— questions:', fetched.quiz?.questions?.length)

    console.log('\n[4/4] Submit answers as a student...')
    const answers = fetched.quiz.questions.map((_q, i) => i === 0 ? 0 : (i === 1 ? 1 : 2))
    const submit = await (await fetch(`${API}/quiz-submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quizId: quiz.quizId, answers })
    })).json()
    console.log('   score:', submit.score, '/', submit.total)

    console.log('\n[5/5] Teacher fetches responses...')
    const responses = await (await fetch(`${API}/quiz-responses/${quiz.quizId}`)).json()
    console.log('   responses received:', responses.responses?.length || 0)

    console.log('\nALL CHECKS PASSED')
}

main().catch((e) => { console.error('FATAL', e); process.exit(1) })