import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './dashboard.css'
import App from './App'
import ClassReportView from './components/ClassReportView'

// A classroom report deep-link (?report=<gameCode>) renders the read-only report and
// nothing else — no auth, no home screen. The matcher dashboard links here per group.
// Every other URL (including the student deep-link ?class=…&sid=…) renders the app.
const reportCode = new URLSearchParams(window.location.search).get('report')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {reportCode ? <ClassReportView gameCode={reportCode.trim().toUpperCase()} /> : <App />}
  </StrictMode>,
)
