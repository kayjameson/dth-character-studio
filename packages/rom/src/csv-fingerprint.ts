/**
 * FNV-1a over names + text, line endings normalized so a checkout's autocrlf
 * setting can't change it. Identifies template content; not a security hash.
 * Its own module, free of `?raw` imports, so Playwright's node-side fixtures can
 * compute the same value from the files.
 */
export function templatesFingerprint(templates: Readonly<Record<string, string>>): string {
  let hash = 0x811c9dc5
  for (const name of Object.keys(templates).sort()) {
    const text = `${name}\0${templates[name].replace(/\r\n/g, '\n')}\0`
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i)
      hash = Math.imul(hash, 0x01000193)
    }
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}
