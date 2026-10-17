import { useSearchParams } from 'react-router-dom'

export function Announcement() {
  const [params] = useSearchParams()
  const body = params.get('body') ?? ''
  return <section dangerouslySetInnerHTML={{ __html: body }} />
}
