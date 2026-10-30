BEGIN {
  count = split(allowed_keys, keys, " ")
  for (i = 1; i <= count; i++) allowed[keys[i]] = 1
}

/^[[:space:]]*(#|$)/ { next }

{
  key = $0
  sub(/^[[:space:]]*/, "", key)
  sub(/=.*/, "", key)
  if (allowed[key]) print
}
