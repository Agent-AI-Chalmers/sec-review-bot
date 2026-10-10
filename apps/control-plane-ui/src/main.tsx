import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { App } from './App.js'
import { LanguageProvider } from './i18n.js'
import { Preferences } from './preferences.js'
import './styles.css'
import '@mantine/core/styles.css'

createRoot(document.getElementById('root')!).render(
  <LanguageProvider>
    <Preferences>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </Preferences>
  </LanguageProvider>
)
