export const uploadSource = async (kind: 'package' | 'script', file: File): Promise<{ name: string }> => {
  const limit = kind === 'package' ? 16 : 1
  if (!file.size || file.size > limit * 1024 * 1024) throw new Error(`文件不能为空且不能超过 ${limit} MiB。`)
  const response = await fetch(`/account-api/source-${kind}`, {
    method: 'POST',
    headers: { 'Content-Type': kind === 'script' ? 'text/javascript' : 'application/octet-stream' },
    body: file,
  })
  if (response.status === 401) {
    location.assign('/')
    throw new Error('登录已失效')
  }
  const result = await response.json()
  if (!response.ok) throw new Error(result.error ?? '上传失败，请重试。')
  return result
}
