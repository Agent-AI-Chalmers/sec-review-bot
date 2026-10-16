type User = { displayName: string }

export function Profile({ user }: { user: User }) {
  return <h1>{user.displayName}</h1>
}
