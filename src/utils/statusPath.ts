export function normalizeDisplayPath(path: string): string {
  return path.replace(/\\/g, '/')
}

export function basenameOfPath(path: string): string {
  const normalized = normalizeDisplayPath(path).replace(/\/+$/, '')
  return normalized.split('/').pop() || normalized || path
}

function hasWindowsDrive(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path)
}

function trimTrailingSlash(path: string): string {
  const normalized = normalizeDisplayPath(path)
  if (/^[A-Za-z]:\/$/.test(normalized)) return normalized
  if (normalized === '/') return normalized
  return normalized.replace(/\/+$/, '')
}

export function relativePathWithinRoot(filePath: string | null, root: string | null): string | null {
  if (!filePath || !root) return null

  const normalizedFile = normalizeDisplayPath(filePath)
  const normalizedRoot = trimTrailingSlash(root)
  const fileForCompare = hasWindowsDrive(normalizedFile) ? normalizedFile.toLowerCase() : normalizedFile
  const rootForCompare = hasWindowsDrive(normalizedRoot) ? normalizedRoot.toLowerCase() : normalizedRoot

  if (fileForCompare === rootForCompare) return basenameOfPath(normalizedFile)
  const prefix = rootForCompare.endsWith('/') ? rootForCompare : `${rootForCompare}/`
  if (!fileForCompare.startsWith(prefix)) return null

  return normalizedFile.slice(prefix.length)
}

export function displayFilePath(filePath: string | null, root: string | null): string {
  if (!filePath) return '未命名'
  return relativePathWithinRoot(filePath, root) ?? basenameOfPath(filePath)
}
