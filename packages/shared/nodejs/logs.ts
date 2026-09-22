import { exec } from 'node:child_process'
import fs from 'node:fs'

import { checkAndCreateDir, checkFile, joinPath } from './index'

export const createSimpleLogcat = async (path: string, name: string) => {
  await checkAndCreateDir(path)
  const filePath = joinPath(path, name)
  return (message: string) => {
    fs.appendFile(filePath, message + '\n', (error) => {
      if (error) console.error('write log error:', error)
    })
  }
}

export const readLastLines = async (filePath: string, lineCount = 100) => {
  if (!(await checkFile(filePath))) return ''
  return new Promise<string>((resolve, reject) => {
    let command

    if (process.platform === 'win32') {
      // Windows 系统下使用 PowerShell 来获取文件的最后100行
      command = `powershell -Command "chcp 65001; Get-Content '${filePath}' -Encoding UTF8 -Tail ${lineCount}"`
      exec(command, { encoding: 'utf8' }, (error, stdout, stderr) => {
        if (error) {
          console.error('exec error:', error)
          reject(error)
          return
        }
        if (stderr) {
          console.error('stderr:', stderr)
          reject(new Error(stderr))
          return
        }
        // console.log(stdout)
        // remove "Active code page: 65001" from stdout
        resolve(stdout.substring(25))
      })
    } else {
      // Linux/macOS 系统下使用 tail 命令
      command = `tail -n ${lineCount} '${filePath}'`
      exec(
        command,
        {
          encoding: 'utf8',
          env: {
            LANG: 'en_US.UTF-8',
            LC_ALL: 'en_US.UTF-8',
          },
        },
        (error, stdout, stderr) => {
          if (error) {
            console.error('exec error:', error)
            reject(error)
            return
          }
          if (stderr) {
            console.error('stderr:', stderr)
            reject(new Error(stderr))
            return
          }
          resolve(stdout)
        }
      )
    }
  })
}
