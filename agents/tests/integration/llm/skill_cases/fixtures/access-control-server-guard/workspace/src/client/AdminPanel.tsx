export function AdminPanel({ currentUser, selectedUser }) {
  if (!currentUser.isAdmin) return null
  return <button onClick={() => promote(selectedUser.id)}>Promote</button>
}
