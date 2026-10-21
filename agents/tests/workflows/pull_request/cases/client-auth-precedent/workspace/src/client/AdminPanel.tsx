export function AdminPanel({ currentUser, selectedUser }) {
  if (!currentUser.isAdmin) return null
  return (
    <button
      onClick={() => fetch(`/api/admin/users/${selectedUser.id}/role`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'admin' })
      })}
    >Promote</button>
  )
}
