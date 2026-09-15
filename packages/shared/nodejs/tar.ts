import type { TarOptionsWithAliasesAsyncNoFile } from 'tar'

export const pack = async (directory: string, files: string[]) => {
  const { c } = await import('tar')
  const chunks: Buffer[] = []
  for await (const chunk of c({ cwd: directory, gzip: true, portable: true }, files)) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

export const unpack = async (filePath: string, dist: string, opts: TarOptionsWithAliasesAsyncNoFile = {}) => {
  const { x } = await import('tar')
  return x({
    file: filePath,
    C: dist,
    ...opts,
  })
}
