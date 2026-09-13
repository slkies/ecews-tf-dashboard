import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { TooltipProvider } from '@/components/ui/tooltip'
import App from './App'
import { SessionProvider } from './core/session'
import { ThemeProvider } from './core/theme'
// IBM Plex, self-hosted from /vendor: no external request at runtime.
import './styles/fonts.css'
// Tailwind, shadcn and the Option 1 theme. The stylesheets ported from the
// single-file dashboard are gone: their global table, input and card rules
// would restyle shadcn's components underneath them.
import './index.css'

const root = document.getElementById('root')
if (!root) throw new Error('#root is missing from index.html')

createRoot(root).render(
  <StrictMode>
    <ThemeProvider>
      <TooltipProvider>
        <SessionProvider>
          <App />
        </SessionProvider>
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>,
)
