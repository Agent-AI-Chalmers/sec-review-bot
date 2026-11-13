import React from 'react'
import { Badge, Collapse, ScrollArea, UnstyledButton } from '@mantine/core'
import {
  IconChevronDown,
  IconChevronRight,
  IconFile,
  IconFileText,
  IconFolder
} from '@tabler/icons-react'
import { ICON_SIZE } from '../../shared/design.js'

interface FileTreeNode {
  name: string
  path?: string
  children: FileTreeNode[]
}

function buildFileTree(paths: string[]): FileTreeNode[] {
  const root: FileTreeNode = { name: '', children: [] }
  for (const path of paths.sort()) {
    const parts = path.split('/')
    let parent = root
    parts.forEach((part, index) => {
      let child = parent.children.find((item) => item.name === part)
      if (!child) {
        child = { name: part, children: [] }
        parent.children.push(child)
      }
      if (index === parts.length - 1) child.path = path
      parent = child
    })
  }
  return root.children
}

function FileTreeItem({
  node,
  depth,
  selectedFile,
  onSelect,
  modifiedFiles,
  fileMarkers
}: {
  node: FileTreeNode
  depth: number
  selectedFile: string
  onSelect: (path: string) => void
  modifiedFiles: ReadonlySet<string>
  fileMarkers: Readonly<Record<string, { label: string; color: string }>>
}): React.JSX.Element {
  const [opened, setOpened] = React.useState(true)
  if (node.path === undefined) {
    return (
      <div>
        <UnstyledButton
          className="file-workspace-node file-workspace-directory"
          aria-expanded={opened}
          style={{ paddingLeft: 8 + depth * 16 }}
          onClick={() => setOpened((current) => !current)}
        >
          {opened ? (
            <IconChevronDown size={ICON_SIZE.sm} />
          ) : (
            <IconChevronRight size={ICON_SIZE.sm} />
          )}
          <IconFolder size={ICON_SIZE.md} />
          <span>{node.name}</span>
        </UnstyledButton>
        <Collapse expanded={opened}>
          {node.children.map((child) => (
            <FileTreeItem
              key={`${node.name}/${child.name}`}
              node={child}
              depth={depth + 1}
              selectedFile={selectedFile}
              onSelect={onSelect}
              modifiedFiles={modifiedFiles}
              fileMarkers={fileMarkers}
            />
          ))}
        </Collapse>
      </div>
    )
  }
  return (
    <UnstyledButton
      className="file-workspace-node file-workspace-file"
      data-active={node.path === selectedFile || undefined}
      aria-current={node.path === selectedFile ? 'true' : undefined}
      data-modified={modifiedFiles.has(node.path) || undefined}
      style={{ paddingLeft: 24 + depth * 16 }}
      onClick={() => onSelect(node.path!)}
    >
      {node.name.endsWith('.md') ? (
        <IconFileText size={ICON_SIZE.md} />
      ) : (
        <IconFile size={ICON_SIZE.md} />
      )}
      <span>{node.name}</span>
      {fileMarkers[node.path] && (
        <Badge
          size="xs"
          variant="light"
          color={fileMarkers[node.path]?.color}
          className="file-workspace-marker"
        >
          {fileMarkers[node.path]?.label}
        </Badge>
      )}
    </UnstyledButton>
  )
}

export function WorkspaceFileTree({
  paths,
  selectedFile,
  onSelect,
  modifiedFiles,
  fileMarkers
}: {
  paths: string[]
  selectedFile: string
  onSelect: (path: string) => void
  modifiedFiles: ReadonlySet<string>
  fileMarkers: Readonly<Record<string, { label: string; color: string }>>
}): React.JSX.Element {
  const tree = React.useMemo(() => buildFileTree([...paths]), [paths])
  return (
    <ScrollArea className="file-workspace-files">
      {tree.map((node) => (
        <FileTreeItem
          key={node.name}
          node={node}
          depth={0}
          selectedFile={selectedFile}
          onSelect={onSelect}
          modifiedFiles={modifiedFiles}
          fileMarkers={fileMarkers}
        />
      ))}
    </ScrollArea>
  )
}
