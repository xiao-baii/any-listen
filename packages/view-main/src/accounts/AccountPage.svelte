<script lang="ts">
  import Btn from '@/components/base/Btn.svelte'
  import Input from '@/components/base/Input.svelte'
  import { onMount } from 'svelte'
  import { account, accountRequest, type CurrentUser } from './state.svelte'

  let username = $state(''), password = $state(''), newPassword = $state('')
  let error = $state(''), message = $state(''), busy = $state(false)
  let users = $state<CurrentUser[]>([])
  let sessions = $state<Array<{ id: string; userAgent: string; ip: string; createdAt: number }>>([])
  let currentId = $state('')
  let role = $state('user')
  let createUsername = $state(''), temporaryPassword = $state(''), resetPassword = $state('')
  let runtimes = $state<{ active: Array<{ userId: string; rss: number; startupMs: number; active: number; busy: number }>; errors: Array<{ userId: string; message: string }> }>({ active: [], errors: [] })
  let publication = $state<{ version: string | null; running: boolean; message: string }>({ version: null, running: false, message: '' })
  let resetId = $state('')
  let backupFile = $state<File | null>(null)
  let replaceLists = $state(false)
  const refresh = async () => {
    if (!account.user || account.user.mustChangePassword) return
    const result = await accountRequest('/sessions'); sessions = result.sessions; currentId = result.currentId
    if (account.user.role === 'admin') {
      const result = await accountRequest('/users'); users = result.users; runtimes = result.runtimes
      publication = await accountRequest('/publication')
    }
  }
  const run = async (action: () => Promise<void>) => {
    busy = true; error = ''; message = ''
    try { await action() } catch (e) { error = (e as Error).message } finally { busy = false }
  }
  const login = () => run(async () => {
    const result = await accountRequest('/login', 'POST', { username, password })
    account.user = result.user; password = ''
    if (!result.user.mustChangePassword) location.assign(`/u/${result.user.id}/`)
  })
  const changePassword = () => run(async () => {
    await accountRequest('/password', 'POST', { currentPassword: password, password: newPassword })
    account.user = null; password = ''; newPassword = ''; message = '密码已修改，请重新登录。'
  })
  const logout = () => run(async () => { await accountRequest('/logout', 'POST'); location.assign('/') })
  const publish = () => run(async () => {
    publication = { ...publication, running: true, message: '正在验证音源配置…' }
    try { publication = await accountRequest('/publication', 'POST') }
    finally { publication = await accountRequest('/publication') }
  })
  onMount(() => {
    void run(refresh)
    const timer = setInterval(() => {
      if (account.user?.role === 'admin' && !account.user.mustChangePassword)
        void accountRequest('/publication').then((value) => { publication = value }).catch(() => {})
    }, 2000)
    return () => clearInterval(timer)
  })
</script>

<main class="account-page">
  <header><h1>Any Listen</h1>{#if account.user}<span>{account.user.username}</span><Btn disabled={busy} onclick={logout}>退出登录</Btn>{/if}</header>
  {#if error}<p role="alert" class="error">{error}</p>{/if}
  {#if account.error}<p role="alert" class="error">{account.error}</p>{/if}
  {#if message}<p role="status">{message}</p>{/if}
  {#if !account.user}
    <section class="login"><h2>账号登录</h2><form onsubmit={(e) => { e.preventDefault(); void login() }}>
      <label>用户名<Input bind:value={username} /></label>
      <label>密码<Input type="password" bind:value={password} /></label>
      <Btn rawtype="submit" disabled={busy}>登录</Btn>
    </form></section>
  {:else}
    {#if !account.user.mustChangePassword}<nav><a href={`/u/${account.user.id}/`}>返回播放器</a></nav>{/if}
    <section><h2>{account.user.mustChangePassword ? '首次登录，请修改密码' : '修改密码'}</h2>
      <form onsubmit={(e) => { e.preventDefault(); void changePassword() }}>
        <label>当前密码<Input type="password" bind:value={password} /></label>
        <label>新密码（1 至 128 位）<Input type="password" bind:value={newPassword} /></label>
        <Btn rawtype="submit" disabled={busy}>修改密码</Btn>
      </form>
    </section>
    {#if !account.user.mustChangePassword}
      <section><h2>个人歌单备份</h2><a href={`/u/${account.user.id}/api/account-backup`} download>下载歌单备份</a>
        <form onsubmit={(e) => { e.preventDefault(); void run(async () => {
          if (!backupFile || !replaceLists) return
          const response = await fetch(`/u/${account.user!.id}/api/account-backup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: backupFile })
          if (!response.ok) throw new Error('导入失败，请检查备份格式。')
          message = '歌单已恢复。'; replaceLists = false
        }) }}>
          <label>备份文件<input type="file" accept=".json" onchange={(e) => { backupFile = e.currentTarget.files?.[0] ?? null }} /></label>
          <label class="check"><input type="checkbox" bind:checked={replaceLists} />替换当前账号全部歌单</label>
          <Btn rawtype="submit" disabled={busy || !backupFile || !replaceLists}>恢复歌单</Btn>
        </form>
      </section>
      <section><h2>登录设备</h2><div class="table-wrap"><table><thead><tr><th>设备</th><th>IP</th><th>操作</th></tr></thead><tbody>
        {#each sessions as session}<tr><td>{session.userAgent || '未知设备'}{session.id === currentId ? '（当前）' : ''}</td><td>{session.ip}</td><td><Btn disabled={busy} onclick={() => run(async () => { await accountRequest(`/sessions/${session.id}`, 'DELETE'); if (session.id === currentId) location.assign('/'); else await refresh() })}>退出</Btn></td></tr>{/each}
      </tbody></table></div></section>
      {#if account.user.role === 'admin'}
        <section><h2>账号管理</h2><form class="create" onsubmit={(e) => { e.preventDefault(); void run(async () => { await accountRequest('/users', 'POST', { username: createUsername, password: temporaryPassword, role }); createUsername = ''; temporaryPassword = ''; await refresh() }) }}>
          <label>用户名<Input bind:value={createUsername} /></label><label>临时密码<Input type="password" bind:value={temporaryPassword} /></label>
          <label>角色<select bind:value={role}><option value="user">普通用户</option><option value="admin">管理员</option></select></label><Btn rawtype="submit" disabled={busy}>创建账号</Btn>
        </form><div class="table-wrap"><table><thead><tr><th>用户名</th><th>角色</th><th>状态</th><th>操作</th></tr></thead><tbody>
          {#each users as user}<tr><td>{user.username}</td><td>{user.role === 'admin' ? '管理员' : '用户'}</td><td>{user.disabled ? '已禁用' : '正常'}</td><td class="commands"><Btn disabled={busy} onclick={() => run(async () => { await accountRequest(`/users/${user.id}/disabled`, 'POST', { disabled: !user.disabled }); await refresh() })}>{user.disabled ? '恢复' : '禁用'}</Btn><Btn disabled={busy} onclick={() => { resetId = user.id; resetPassword = '' }}>重置密码</Btn></td></tr>{/each}
        </tbody></table></div>
        {#if resetId}<form onsubmit={(e) => { e.preventDefault(); void run(async () => { await accountRequest(`/users/${resetId}/password`, 'POST', { password: resetPassword }); resetId = ''; resetPassword = ''; message = '密码已重置。'; await refresh() }) }}><label>新的临时密码<Input type="password" bind:value={resetPassword} /></label><Btn rawtype="submit" disabled={busy}>确认重置</Btn><Btn onclick={() => { resetId = '' }}>取消</Btn></form>{/if}
        </section>
        <section><h2>账号运行状态</h2><Btn disabled={busy} onclick={() => run(refresh)}>刷新状态</Btn>
          {#each runtimes.active as runtime}<p>{users.find((user) => user.id === runtime.userId)?.username}: {(runtime.rss / 1024 / 1024).toFixed(1)} MiB · 启动 {runtime.startupMs} ms · 连接 {runtime.active} · 任务 {runtime.busy}</p>{/each}
          {#each runtimes.errors as item}<p class="error">{users.find((user) => user.id === item.userId)?.username}: {item.message} <Btn disabled={busy} onclick={() => run(async () => { await accountRequest(`/users/${item.userId}/retry`, 'POST'); await refresh() })}>重试启动</Btn></p>{/each}
        </section>
        <section><h2>音源发布</h2><p>当前版本：{publication.version ?? '尚未发布'}</p><p role="status">{publication.message}</p><Btn disabled={busy || publication.running} onclick={publish}>{publication.running ? '正在发布…' : '发布配置'}</Btn></section>
      {/if}
    {/if}
  {/if}
</main>

<style>
  .account-page { box-sizing: border-box; width: 100%; height: 100%; overflow: auto; padding: 24px max(20px, calc((100% - 960px) / 2)); background: #fff; color: #222; font-size: 14px; }
  header { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; border-bottom: 1px solid #ddd; padding-bottom: 16px; }
  h1 { font-size: 24px; margin: 0 auto 0 0; } h2 { font-size: 17px; margin: 0 0 16px; }
  section { padding: 24px 0; border-bottom: 1px solid #ddd; overflow-wrap: anywhere; } section > a { display: inline-block; margin-bottom: 12px; } nav { padding-top: 20px; } a { color: #17674f; }
  .login { max-width: 400px; margin: 40px auto; } form { display: flex; flex-wrap: wrap; gap: 12px; align-items: end; } .login form { flex-direction: column; align-items: stretch; }
  label { display: flex; flex-direction: column; gap: 8px; max-width: 100%; } select { height: 30px; border: 1px solid #bbb; background: white; }
  label.check { flex-direction: row; align-items: center; } input[type='file'] { max-width: 100%; }
  .error { color: #ab2732; } .table-wrap { overflow-x: auto; margin-top: 16px; } table { width: 100%; border-collapse: collapse; table-layout: fixed; } th,td { padding: 12px 8px; text-align: left; border-bottom: 1px solid #eee; overflow-wrap: anywhere; } .commands { display: flex; flex-wrap: wrap; gap: 8px; }
  @media (max-width: 600px) { .account-page { padding: 18px 14px; } form { flex-direction: column; align-items: stretch; } th,td { padding: 10px 3px; font-size: 12px; } .commands { flex-direction: column; } }
</style>
