/** A new client key: `sk-` and 24 random bytes as base64url (32 characters). */
export function generateKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  const b64 = btoa(String.fromCharCode(...bytes))
  return `sk-${b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`
}
