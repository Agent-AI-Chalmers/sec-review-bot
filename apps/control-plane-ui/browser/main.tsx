import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { App } from './app/App.js'
import { Preferences } from './app/preferences.js'
import { LanguageProvider } from './shared/i18n.js'
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
