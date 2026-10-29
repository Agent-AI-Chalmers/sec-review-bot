import React from 'react'
import { MantineProvider } from '@mantine/core'
import { render, screen } from '@testing-library/react'
import { BrowserRouter } from 'react-router-dom'
import { expect, test, vi } from 'vitest'

import { App } from '../../browser/app/App.js'
import { mantineTheme } from '../../browser/app/theme.js'
import { LanguageProvider } from '../../browser/shared/i18n.js'

vi.mock('../../browser/app/preferences.js', () => ({
  PreferenceControls: (): null => null
}))

vi.mock('../../browser/features/runs/Runs.js', () => ({
  Runs: (): React.JSX.Element => <div>Runs route</div>
}))

test('the application root opens the run list', async () => {
  window.history.replaceState(null, '', '/')

  render(
    <LanguageProvider>
      <MantineProvider theme={mantineTheme}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </MantineProvider>
    </LanguageProvider>
  )

  expect(await screen.findByText('Runs route')).toBeVisible()
  expect(window.location.pathname).toBe('/runs')
})

test('unknown routes preserve the URL and render a not-found page', async () => {
  window.history.replaceState(null, '', '/unknown')

  render(
    <LanguageProvider>
      <MantineProvider theme={mantineTheme}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </MantineProvider>
    </LanguageProvider>
  )

  expect(
    await screen.findByRole('heading', { name: '404' })
  ).toBeInTheDocument()
  expect(screen.getByText('The requested page does not exist.')).toBeVisible()
  expect(screen.getByRole('link', { name: 'Back to runs' })).toHaveAttribute(
    'href',
    '/runs'
  )
  expect(window.location.pathname).toBe('/unknown')
})
