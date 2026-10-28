import React from 'react'
import { MantineProvider } from '@mantine/core'
import { render, type RenderResult } from '@testing-library/react'

import { mantineTheme } from '../../browser/app/theme.js'
import { LanguageProvider, type Language } from '../../browser/shared/i18n.js'

export function renderComponent(
  ui: React.ReactNode,
  { language = 'en' }: { language?: Language } = {}
): RenderResult {
  localStorage.setItem('ui-language', language)
  const Providers = ({
    children
  }: {
    children: React.ReactNode
  }): React.JSX.Element => (
    <LanguageProvider>
      <MantineProvider theme={mantineTheme}>{children}</MantineProvider>
    </LanguageProvider>
  )
  return render(ui, { wrapper: Providers })
}
