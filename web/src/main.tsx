import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { installBasePath } from './basePath'
import './styles.css'
import App from './App.tsx'

// Make root-relative fetches respect the mount prefix before anything renders.
installBasePath()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
