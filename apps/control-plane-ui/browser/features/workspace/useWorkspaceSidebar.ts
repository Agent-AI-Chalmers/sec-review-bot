import React from 'react'

const SIDEBAR_WIDTH_KEY = 'file-workspace-sidebar-width'
const DEFAULT_SIDEBAR_WIDTH = 240
const MIN_SIDEBAR_WIDTH = 180
const MAX_SIDEBAR_WIDTH = 480

function storedSidebarWidth(): number {
  const value = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY))
  return Number.isFinite(value)
    ? Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, value))
    : DEFAULT_SIDEBAR_WIDTH
}

interface WorkspaceSidebar {
  workspaceRef: React.RefObject<HTMLDivElement | null>
  sidebarWidth: number
  splitterProps: React.HTMLAttributes<HTMLDivElement>
}

/** Own sidebar sizing, pointer capture, keyboard adjustment and persisted width. */
export function useWorkspaceSidebar(): WorkspaceSidebar {
  const [sidebarWidth, setSidebarWidth] = React.useState(storedSidebarWidth)
  const workspaceRef = React.useRef<HTMLDivElement>(null)
  const currentSidebarWidth = React.useRef(sidebarWidth)
  const dragStart = React.useRef<{ pointerX: number; width: number } | null>(
    null
  )
  const updateSidebarWidth = (width: number, persist = false): void => {
    const workspaceWidth =
      workspaceRef.current?.getBoundingClientRect().width ?? 0
    const responsiveMaximum = workspaceWidth
      ? Math.max(MIN_SIDEBAR_WIDTH, workspaceWidth * 0.45)
      : MAX_SIDEBAR_WIDTH
    const next = Math.round(
      Math.min(
        MAX_SIDEBAR_WIDTH,
        responsiveMaximum,
        Math.max(MIN_SIDEBAR_WIDTH, width)
      )
    )
    currentSidebarWidth.current = next
    setSidebarWidth(next)
    if (persist) localStorage.setItem(SIDEBAR_WIDTH_KEY, String(next))
  }
  return {
    workspaceRef,
    sidebarWidth,
    splitterProps: {
      'aria-valuemin': MIN_SIDEBAR_WIDTH,
      'aria-valuemax': MAX_SIDEBAR_WIDTH,
      'aria-valuenow': sidebarWidth,
      tabIndex: 0,
      onDoubleClick: () => updateSidebarWidth(DEFAULT_SIDEBAR_WIDTH, true),
      onKeyDown: (event): void => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault()
        updateSidebarWidth(
          sidebarWidth + (event.key === 'ArrowLeft' ? -16 : 16),
          true
        )
      },
      onPointerDown: (event): void => {
        dragStart.current = { pointerX: event.clientX, width: sidebarWidth }
        event.currentTarget.setPointerCapture(event.pointerId)
      },
      onPointerMove: (event): void => {
        if (dragStart.current)
          updateSidebarWidth(
            dragStart.current.width + event.clientX - dragStart.current.pointerX
          )
      },
      onPointerUp: (event): void => {
        if (!dragStart.current) return
        dragStart.current = null
        event.currentTarget.releasePointerCapture(event.pointerId)
        localStorage.setItem(
          SIDEBAR_WIDTH_KEY,
          String(currentSidebarWidth.current)
        )
      }
    }
  }
}
