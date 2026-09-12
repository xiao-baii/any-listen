export interface CurrentUser {
  id: string
  username: string
  role: 'admin' | 'user'
  disabled: number
  mustChangePassword: number
}
export const account = $state<{ enabled: boolean; ready: boolean; user: CurrentUser | null; error: string }>({
  enabled: false,
  ready: false,
  user: null,
  error: '',
})
export const accountRequest = async (endpoint: string, method = 'GET', body?: unknown) => {
  const response = await fetch(`/account-api${endpoint}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await response.json()
  if (response.status === 401 && endpoint !== '/login') {
    location.assign('/')
    throw new Error('登录已失效')
  }
  if (!response.ok) throw new Error(data.error ?? 'Request failed')
  return data
}
export const initAccount = async () => {
  if (!import.meta.env.VITE_IS_WEB) {
    account.ready = true
    return
  }
  try {
    const response = await fetch('/account-api/me')
    if (response.status === 404) {
      account.ready = true
      return
    }
    if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('账号服务暂时不可用，请刷新重试。')
    account.enabled = true
    document.documentElement.classList.add('multi-user')
    if (response.ok) account.user = (await response.json()).user
  } catch (error) {
    account.enabled = true
    account.error = (error as Error).message
  }
  account.ready = true
}
