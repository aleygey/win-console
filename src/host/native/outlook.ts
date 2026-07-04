/**
 * Read the classic Outlook inbox over COM. On Windows we drive PowerShell with
 * the Outlook.Application COM object — passing the script via -EncodedCommand
 * (UTF-16LE base64) so Chinese subjects/senders survive any code page. Off
 * Windows we return mock fixtures. Pure node (no electron) so the smoke test and
 * the real native host both reuse it.
 *
 * Carried over verbatim from win-console; only the type import path changed.
 */
import { spawn } from "node:child_process"
import type {
  OutlookMail,
  OutlookSearchReq,
  OutlookSearchRes,
  OutlookListReq,
  OutlookListRes,
  OutlookReadReq,
  OutlookReadRes,
  OutlookReplyReq,
  OutlookReplyRes,
  OutlookFoldersRes,
  OutlookSaveAttachmentsRes,
  MailMessage,
} from "../../contracts"

export async function outlookSearch(req: OutlookSearchReq): Promise<OutlookSearchRes> {
  const top = Math.max(1, Math.min(50, req.top ?? 15))
  const query = (req.query ?? "").trim()

  if (process.platform !== "win32") {
    return { ok: true, mock: true, mails: mockMails(query, top) }
  }

  try {
    const stdout = await runPowerShell(psScript(query, top))
    const parsed: unknown = JSON.parse(stdout.trim() || "[]")
    const arr: unknown[] = Array.isArray(parsed) ? parsed : parsed ? [parsed] : []
    return { ok: true, mails: arr.map(normalize) }
  } catch (e) {
    return {
      ok: false,
      error: `读取 Outlook 失败:${e instanceof Error ? e.message : String(e)}(确认装了经典版 Outlook 且已登录;新版 Outlook 不支持 COM)`,
    }
  }
}

// Shared PowerShell helper: build "DisplayName <smtp>" for a mail item. For
// Exchange INTERNAL senders, Outlook's SenderEmailAddress is an X.500 EX address
// (e.g. /O=…/CN=zhangzenan), NOT the SMTP — so we resolve the real SMTP via
// GetExchangeUser().PrimarySmtpAddress, falling back to PR_SENDER_SMTP_ADDRESS,
// so a `发件人含 zhangzenan@tp-link.com.cn` filter matches internal mail too.
const PS_FROM_FN = `function Get-FromString($m) {
  $name = ''
  try { $name = [string]$m.SenderName } catch {}
  $addr = ''
  try { $addr = [string]$m.SenderEmailAddress } catch {}
  $smtp = ''
  try {
    if ($m.SenderEmailType -eq 'EX' -and $m.Sender) {
      $eu = $m.Sender.GetExchangeUser()
      if ($eu) { $smtp = [string]$eu.PrimarySmtpAddress }
    }
  } catch {}
  if ([string]::IsNullOrEmpty($smtp)) {
    try { $smtp = [string]$m.PropertyAccessor.GetProperty('http://schemas.microsoft.com/mapi/proptag/0x5D01001F') } catch {}
  }
  $final = if (-not [string]::IsNullOrEmpty($smtp)) { $smtp } else { $addr }
  if (-not [string]::IsNullOrEmpty($final)) { "$name <$final>" } else { $name }
}`

function psScript(query: string, top: number): string {
  const q = query.replace(/'/g, "''")
  // Force UTF-8 stdout: on Chinese Windows PowerShell emits GBK by default, which
  // node then mis-reads as UTF-8 → mojibake for Chinese subjects/senders/bodies.
  return `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
$ErrorActionPreference='Stop'
$ol = New-Object -ComObject Outlook.Application
$ns = $ol.GetNamespace('MAPI')
${PS_FROM_FN}
$inbox = $ns.GetDefaultFolder(6)
$items = $inbox.Items
$items.Sort('[ReceivedTime]', $true)
$q = '${q}'
$top = ${top}
$out = New-Object System.Collections.ArrayList
foreach ($m in $items) {
  if ($out.Count -ge $top) { break }
  try {
    if ($q -ne '' -and ($m.Subject -notlike "*$q*") -and ($m.SenderName -notlike "*$q*")) { continue }
    $body = [string]$m.Body
    if ($body.Length -gt 200) { $body = $body.Substring(0,200) }
    $fromStr = Get-FromString $m
    $null = $out.Add([PSCustomObject]@{
      subject  = [string]$m.Subject
      from     = $fromStr
      received = $m.ReceivedTime.ToString('o')
      unread   = [bool]$m.UnRead
      preview  = ($body -replace '\\s+',' ').Trim()
      entryId  = [string]$m.EntryID
    })
  } catch {}
}
$out | ConvertTo-Json -Depth 3 -Compress`
}

function runPowerShell(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(script, "utf16le").toString("base64")
    const ps = spawn("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encoded,
    ])
    let out = ""
    let err = ""
    // COM can hang (Outlook security-access dialog, or new Outlook with no COM).
    // Bail after 20s so the panel shows an error instead of spinning forever.
    const timer = setTimeout(() => {
      ps.kill()
      reject(new Error("Outlook COM 20s 无响应(经典 Outlook 是否弹了访问确认框?新版 Outlook olk.exe 不支持 COM)"))
    }, 20_000)
    ps.stdout.on("data", (d) => (out += d.toString()))
    ps.stderr.on("data", (d) => (err += d.toString()))
    ps.on("error", (e) => {
      clearTimeout(timer)
      reject(e)
    })
    ps.on("close", (code) => {
      clearTimeout(timer)
      code === 0 ? resolve(out) : reject(new Error(err.trim() || `powershell exit ${code}`))
    })
  })
}

function normalize(x: unknown): OutlookMail {
  const o = (x ?? {}) as Record<string, unknown>
  return {
    subject: String(o.subject ?? ""),
    from: String(o.from ?? ""),
    received: String(o.received ?? ""),
    unread: Boolean(o.unread),
    preview: String(o.preview ?? ""),
    entryId: o.entryId ? String(o.entryId) : undefined,
  }
}

// ── Mail workflow: list a folder (with EntryIDs) + reply by EntryID ───────────

export async function outlookList(req: OutlookListReq): Promise<OutlookListRes> {
  const top = Math.max(1, Math.min(100, req.top ?? 25))
  const folder = (req.folder ?? "").trim()
  const unreadOnly = !!req.unreadOnly

  if (process.platform !== "win32") {
    return { ok: true, mock: true, mails: mockList(folder, top, unreadOnly) }
  }
  try {
    const stdout = await runPowerShell(psListScript(folder, top, unreadOnly))
    const parsed: unknown = JSON.parse(stdout.trim() || "[]")
    const arr: unknown[] = Array.isArray(parsed) ? parsed : parsed ? [parsed] : []
    return { ok: true, mails: arr.map(normalizeMsg) }
  } catch (e) {
    return {
      ok: false,
      error: `读取 Outlook 文件夹失败:${e instanceof Error ? e.message : String(e)}(确认经典版 Outlook 已登录,文件夹路径是否正确)`,
    }
  }
}

export async function outlookReply(req: OutlookReplyReq): Promise<OutlookReplyRes> {
  if (process.platform !== "win32") return { ok: true, mock: true, sent: !!req.send }
  if (!req.entryId) return { ok: false, error: "缺少 entryId" }
  try {
    await runPowerShell(psReplyScript(req.entryId, req.body ?? "", !!req.replyAll, !!req.send))
    return { ok: true, sent: !!req.send }
  } catch (e) {
    return { ok: false, error: `回复 Outlook 邮件失败:${e instanceof Error ? e.message : String(e)}` }
  }
}

/** Shared PS snippet: resolve a backslash folder path relative to the mailbox
 *  root (or inbox), same semantics as the mailflow list script. Expects $inbox. */
const PS_RESOLVE_FOLDER = `function Resolve-Folder($pathStr) {
  if ([string]::IsNullOrWhiteSpace($pathStr)) { return $inbox }
  $parts = $pathStr -split '[\\\\/]' | Where-Object { $_ -ne '' }
  foreach ($start in @($inbox.Parent, $inbox)) {
    $cur = $start; $okAll = $true
    foreach ($p in $parts) {
      $next = $null
      foreach ($sf in $cur.Folders) { if ($sf.Name -eq $p) { $next = $sf; break } }
      if ($null -eq $next) { $okAll = $false; break }
      $cur = $next
    }
    if ($okAll) { return $cur }
  }
  throw "找不到文件夹: $pathStr"
}`

/** Read ONE mail in full — by EntryID, or first subject-keyword match in a
 *  folder. Optionally lists the rest of its conversation (same topic, ≤10). */
export async function outlookRead(req: OutlookReadReq): Promise<OutlookReadRes> {
  if (process.platform !== "win32") return { ok: true, mock: true }
  if (!req.entryId && !req.subjectContains) return { ok: false, error: "需要 entryId 或 subjectContains" }
  try {
    const stdout = await runPowerShell(psReadScript(req))
    const parsed = JSON.parse(stdout.trim() || "{}") as Record<string, any>
    if (!parsed || !parsed.entryId) return { ok: false, error: "没有找到匹配的邮件" }
    return {
      ok: true,
      mail: {
        entryId: String(parsed.entryId),
        subject: String(parsed.subject ?? ""),
        from: String(parsed.from ?? ""),
        to: String(parsed.to ?? ""),
        received: String(parsed.received ?? ""),
        body: String(parsed.body ?? ""),
        attachments: Array.isArray(parsed.attachments)
          ? parsed.attachments.map((a: any) => ({ name: String(a?.name ?? ""), size: Number(a?.size ?? 0) }))
          : [],
        conversationTopic: parsed.topic ? String(parsed.topic) : undefined,
      },
      thread: Array.isArray(parsed.thread)
        ? parsed.thread.map((t: any) => ({
            entryId: String(t?.entryId ?? ""),
            subject: String(t?.subject ?? ""),
            from: String(t?.from ?? ""),
            received: String(t?.received ?? ""),
          }))
        : undefined,
    }
  } catch (e) {
    return { ok: false, error: `读取邮件失败:${e instanceof Error ? e.message : String(e)}` }
  }
}

function psReadScript(req: OutlookReadReq): string {
  const id = (req.entryId ?? "").replace(/'/g, "''")
  const folder = (req.folder ?? "").replace(/'/g, "''")
  const kw = (req.subjectContains ?? "").replace(/'/g, "''")
  return `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
$ErrorActionPreference='Stop'
$ol = New-Object -ComObject Outlook.Application
$ns = $ol.GetNamespace('MAPI')
${PS_FROM_FN}
$inbox = $ns.GetDefaultFolder(6)
${PS_RESOLVE_FOLDER}
$item = $null
if ('${id}' -ne '') {
  $item = $ns.GetItemFromID('${id}')
} else {
  $target = Resolve-Folder '${folder}'
  $items = $target.Items
  $items.Sort('[ReceivedTime]', $true)
  foreach ($m in $items) {
    try { if ($m.Subject -like "*${kw}*") { $item = $m; break } } catch {}
  }
}
if ($null -eq $item) { '{}'; exit 0 }
$body = [string]$item.Body
if ($body.Length -gt 50000) { $body = $body.Substring(0, 50000) + "\`n…(正文已截断)" }
$atts = New-Object System.Collections.ArrayList
foreach ($a in $item.Attachments) { $null = $atts.Add(@{ name = [string]$a.FileName; size = [long]$a.Size }) }
$to = ''
try { $to = [string]$item.To } catch {}
$topic = ''
try { $topic = [string]$item.ConversationTopic } catch {}
$thread = New-Object System.Collections.ArrayList
if ($${req.thread ? "true" : "false"} -and $topic -ne '') {
  try {
    $pf = $item.Parent
    $tItems = $pf.Items
    $tItems.Sort('[ReceivedTime]', $true)
    foreach ($t in $tItems) {
      if ($thread.Count -ge 10) { break }
      try {
        if ($t.ConversationTopic -eq $topic -and $t.EntryID -ne $item.EntryID) {
          $null = $thread.Add(@{ entryId = [string]$t.EntryID; subject = [string]$t.Subject; from = (Get-FromString $t); received = $t.ReceivedTime.ToString('o') })
        }
      } catch {}
    }
  } catch {}
}
[PSCustomObject]@{
  entryId = [string]$item.EntryID
  subject = [string]$item.Subject
  from = (Get-FromString $item)
  to = $to
  received = $item.ReceivedTime.ToString('o')
  body = $body
  attachments = $atts
  topic = $topic
  thread = $thread
} | ConvertTo-Json -Depth 4 -Compress`
}

/** Save a mail's attachments into `dir` so the agent (WSL side, via /mnt/…)
 *  can read them directly — no size cap here since nothing travels inline. */
export async function outlookSaveAttachments(entryId: string, dir: string): Promise<OutlookSaveAttachmentsRes> {
  if (process.platform !== "win32") return { ok: true, files: [] }
  if (!entryId) return { ok: false, error: "缺少 entryId" }
  try {
    const stdout = await runPowerShell(psSaveAttachmentsScript(entryId, dir))
    const parsed: unknown = JSON.parse(stdout.trim() || "[]")
    const arr = (Array.isArray(parsed) ? parsed : parsed ? [parsed] : []) as Array<Record<string, unknown>>
    return {
      ok: true,
      files: arr.map((a) => ({ name: String(a.name ?? ""), size: Number(a.size ?? 0), winPath: String(a.path ?? "") })),
    }
  } catch (e) {
    return { ok: false, error: `保存附件失败:${e instanceof Error ? e.message : String(e)}` }
  }
}

function psSaveAttachmentsScript(entryId: string, dir: string): string {
  const id = entryId.replace(/'/g, "''")
  const d = dir.replace(/'/g, "''")
  return `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
$ErrorActionPreference='Stop'
$ol = New-Object -ComObject Outlook.Application
$ns = $ol.GetNamespace('MAPI')
$item = $ns.GetItemFromID('${id}')
$dir = '${d}'
$null = New-Item -ItemType Directory -Force -Path $dir
$out = New-Object System.Collections.ArrayList
foreach ($att in $item.Attachments) {
  $name = [string]$att.FileName
  # sanitize: strip path separators a hostile filename could carry
  $safe = ($name -replace '[\\\\/:*?"<>|]', '_')
  $dest = Join-Path $dir $safe
  try {
    $att.SaveAsFile($dest)
    $null = $out.Add(@{ name = $safe; size = [long](Get-Item -LiteralPath $dest).Length; path = $dest })
  } catch {}
}
ConvertTo-Json -Depth 3 @($out)`
}

/** Extract a mail's attachments as inline data-URL files. Caps: ≤5 files,
 *  ≤4MB each, ≤10MB total (they travel inline in the chat prompt request).
 *  Oversized/extra attachments are skipped with a note in `error`. */
export async function outlookAttachments(
  entryId: string,
): Promise<{ ok: boolean; files?: Array<{ name: string; mime: string; dataUrl: string }>; error?: string }> {
  if (process.platform !== "win32") return { ok: true, files: [] }
  if (!entryId) return { ok: false, error: "缺少 entryId" }
  try {
    const stdout = await runPowerShell(psAttachmentsScript(entryId))
    const parsed: unknown = JSON.parse(stdout.trim() || "[]")
    const arr = (Array.isArray(parsed) ? parsed : parsed ? [parsed] : []) as Array<Record<string, unknown>>
    const files: Array<{ name: string; mime: string; dataUrl: string }> = []
    const skipped: string[] = []
    let total = 0
    for (const a of arr) {
      const name = String(a.name ?? "attachment")
      if (a.skipped) {
        skipped.push(`${name}(${a.skipped})`)
        continue
      }
      const b64 = String(a.b64 ?? "")
      if (!b64) continue
      const bytes = Math.floor((b64.length * 3) / 4)
      if (files.length >= 5 || total + bytes > 10 * 1024 * 1024) {
        skipped.push(`${name}(超出总量上限)`)
        continue
      }
      total += bytes
      const mime = mimeOfName(name)
      files.push({ name, mime, dataUrl: `data:${mime};base64,${b64}` })
    }
    return { ok: true, files, error: skipped.length ? `已跳过:${skipped.join("、")}` : undefined }
  } catch (e) {
    return { ok: false, error: `读取附件失败:${e instanceof Error ? e.message : String(e)}` }
  }
}

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  webp: "image/webp",
  pdf: "application/pdf",
  txt: "text/plain",
  log: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  xml: "application/xml",
  html: "text/html",
  zip: "application/zip",
  "7z": "application/x-7z-compressed",
  gz: "application/gzip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  bin: "application/octet-stream",
  hex: "text/plain",
  patch: "text/plain",
  diff: "text/plain",
}
function mimeOfName(name: string): string {
  const ext = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase() ?? ""
  return MIME_BY_EXT[ext] ?? "application/octet-stream"
}

/** Save each attachment to %TEMP%, read + base64 it, clean up. Per-file cap
 *  4MB (larger ones reported as skipped so the caller can tell the user). */
function psAttachmentsScript(entryId: string): string {
  const id = entryId.replace(/'/g, "''")
  return `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
$ErrorActionPreference='Stop'
$ol = New-Object -ComObject Outlook.Application
$ns = $ol.GetNamespace('MAPI')
$item = $ns.GetItemFromID('${id}')
$out = New-Object System.Collections.ArrayList
foreach ($att in $item.Attachments) {
  $name = [string]$att.FileName
  if ($att.Size -gt 4MB) { $null = $out.Add(@{ name = $name; skipped = "超过4MB" }); continue }
  $tmp = Join-Path $env:TEMP ("wh_att_" + [Guid]::NewGuid().ToString('N') + "_" + $name)
  try {
    $att.SaveAsFile($tmp)
    $b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($tmp))
    $null = $out.Add(@{ name = $name; b64 = $b64 })
  } catch {
    $null = $out.Add(@{ name = $name; skipped = "读取失败" })
  } finally {
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  }
}
ConvertTo-Json -Depth 3 @($out)`
}

export async function outlookFolders(): Promise<OutlookFoldersRes> {
  if (process.platform !== "win32") {
    return { ok: true, mock: true, folders: ["收件箱", "收件箱\\Bugzilla", "收件箱\\Gerrit", "已发送邮件", "其他"] }
  }
  try {
    const stdout = await runPowerShell(psFoldersScript())
    const parsed: unknown = JSON.parse(stdout.trim() || "[]")
    const arr = Array.isArray(parsed) ? parsed : parsed ? [parsed] : []
    return { ok: true, folders: arr.map((x) => String(x)).filter(Boolean) }
  } catch (e) {
    return { ok: false, error: `枚举 Outlook 文件夹失败:${e instanceof Error ? e.message : String(e)}` }
  }
}

/** Walk the default mailbox's folder tree (depth ≤4, ≤200) → backslash paths
 *  relative to the root, matching what Resolve-Folder in psListScript expects. */
function psFoldersScript(): string {
  return `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
$ErrorActionPreference='Stop'
$ol = New-Object -ComObject Outlook.Application
$ns = $ol.GetNamespace('MAPI')
$root = $ns.GetDefaultFolder(6).Parent
$out = New-Object System.Collections.ArrayList
function Walk($folder, $prefix, $depth) {
  if ($depth -gt 4) { return }
  foreach ($f in $folder.Folders) {
    if ($out.Count -ge 200) { return }
    $path = if ($prefix -ne '') { "$prefix\\$($f.Name)" } else { [string]$f.Name }
    $null = $out.Add($path)
    Walk $f $path ($depth + 1)
  }
}
Walk $root '' 0
$out | ConvertTo-Json -Compress`
}

/** Resolve a folder by "A\\B\\C" path (relative to the mailbox root, then the
 *  inbox as a fallback), list newest-first, optionally unread-only. Emits the
 *  EntryID so a reply can later re-open the exact item. Body capped at 8000. */
function psListScript(folder: string, top: number, unreadOnly: boolean): string {
  const f = folder.replace(/'/g, "''")
  return `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
$ErrorActionPreference='Stop'
$ol = New-Object -ComObject Outlook.Application
$ns = $ol.GetNamespace('MAPI')
${PS_FROM_FN}
$inbox = $ns.GetDefaultFolder(6)
function Resolve-Folder($pathStr) {
  if ([string]::IsNullOrWhiteSpace($pathStr)) { return $inbox }
  $parts = $pathStr -split '[\\\\/]' | Where-Object { $_ -ne '' }
  foreach ($start in @($inbox.Parent, $inbox)) {
    $cur = $start; $okAll = $true
    foreach ($p in $parts) {
      $next = $null
      foreach ($sf in $cur.Folders) { if ($sf.Name -eq $p) { $next = $sf; break } }
      if ($null -eq $next) { $okAll = $false; break }
      $cur = $next
    }
    if ($okAll) { return $cur }
  }
  throw "找不到文件夹: $pathStr"
}
$target = Resolve-Folder '${f}'
$items = $target.Items
$items.Sort('[ReceivedTime]', $true)
$top = ${top}
$unread = $${unreadOnly ? "true" : "false"}
$out = New-Object System.Collections.ArrayList
foreach ($m in $items) {
  if ($out.Count -ge $top) { break }
  try {
    if ($m.Class -ne 43) { continue }
    if ($unread -and -not $m.UnRead) { continue }
    $body = [string]$m.Body
    if ($body.Length -gt 8000) { $body = $body.Substring(0,8000) }
    $fromStr = Get-FromString $m
    $null = $out.Add([PSCustomObject]@{
      entryId  = [string]$m.EntryID
      subject  = [string]$m.Subject
      from     = $fromStr
      received = $m.ReceivedTime.ToString('o')
      unread   = [bool]$m.UnRead
      body     = $body
      folder   = [string]$target.Name
    })
  } catch {}
}
$out | ConvertTo-Json -Depth 3 -Compress`
}

/** Reply to a mail by EntryID. The reply body is passed base64 (UTF-8) so any
 *  characters/newlines survive without escaping. send → Send(); else → Save()
 *  (lands in Drafts). */
function psReplyScript(entryId: string, body: string, replyAll: boolean, send: boolean): string {
  const id = entryId.replace(/'/g, "''")
  const bodyB64 = Buffer.from(body, "utf8").toString("base64")
  return `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
$ErrorActionPreference='Stop'
$ol = New-Object -ComObject Outlook.Application
$ns = $ol.GetNamespace('MAPI')
$item = $ns.GetItemFromID('${id}')
$reply = $item.${replyAll ? "ReplyAll" : "Reply"}()
$new = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${bodyB64}'))
$reply.Body = $new + "\`r\`n\`r\`n" + $reply.Body
${send ? "$reply.Send()" : "$reply.Save()"}
'ok'`
}

function normalizeMsg(x: unknown): MailMessage {
  const o = (x ?? {}) as Record<string, unknown>
  return {
    entryId: String(o.entryId ?? ""),
    subject: String(o.subject ?? ""),
    from: String(o.from ?? ""),
    received: String(o.received ?? ""),
    unread: Boolean(o.unread),
    body: String(o.body ?? ""),
    folder: o.folder ? String(o.folder) : undefined,
  }
}

function mockList(folder: string, top: number, unreadOnly: boolean): MailMessage[] {
  const now = Date.now()
  const base: MailMessage[] = [
    {
      entryId: "MOCK-BUGZILLA-1",
      subject: "[Bug 12345] 串口在高波特率下偶发丢字节",
      from: "bugzilla@corp.com",
      received: new Date(now - 1.2e6).toISOString(),
      unread: true,
      body: "Bug 12345\n产品: opencode-plugin-serial\n严重程度: major\n复现: 921600 波特率连续发送 1KB 数据,偶发丢失 1-2 字节。\n期望: 不丢字节。",
      folder: folder || "收件箱",
    },
    {
      entryId: "MOCK-GERRIT-1",
      subject: "Change 6789: serial: fix ring buffer overflow",
      from: "gerrit@corp.com",
      received: new Date(now - 2.4e6).toISOString(),
      unread: true,
      body: "Reviewer 请求: 请评审 change 6789。\nDiff:\n- buf_len = size;\n+ buf_len = size > MAX ? MAX : size;\n说明: 修复环形缓冲区在大包下越界。",
      folder: folder || "收件箱",
    },
    {
      entryId: "MOCK-PLAIN-1",
      subject: "周会纪要 6/3",
      from: "张伟 <zhangwei@corp.com>",
      received: new Date(now - 8.64e7).toISOString(),
      unread: false,
      body: "本周进度同步……",
      folder: folder || "收件箱",
    },
  ]
  const filtered = unreadOnly ? base.filter((m) => m.unread) : base
  return filtered.slice(0, top)
}

function mockMails(query: string, top: number): OutlookMail[] {
  const now = Date.now()
  const base: OutlookMail[] = [
    { subject: "周会纪要 6/3", from: "张伟 <zhangwei@corp.com>", received: new Date(now - 3.6e6).toISOString(), unread: true, preview: "本周进度同步:编译流水线已迁移到新的 docker 镜像,下周开始灰度…" },
    { subject: "[CI] build #1423 passed", from: "ci@corp.com", received: new Date(now - 7.2e6).toISOString(), unread: false, preview: "All checks passed on branch feature/win-host. Artifacts uploaded." },
    { subject: "关于报销流程的更新", from: "财务部 <finance@corp.com>", received: new Date(now - 8.64e7).toISOString(), unread: true, preview: "自下月起,报销单据请通过新的 DMS 系统提交,旧入口将于月底关闭…" },
    { subject: "FW: 客户现场串口问题", from: "李娜 <lina@corp.com>", received: new Date(now - 1.728e8).toISOString(), unread: false, preview: "现场日志见附件,初步判断是串口超时,麻烦看下 opencode-plugin-serial…" },
    { subject: "午餐?", from: "王强 <wangq@corp.com>", received: new Date(now - 2.592e8).toISOString(), unread: false, preview: "12 点老地方。" },
  ]
  const q = query.toLowerCase()
  const filtered = q ? base.filter((m) => (m.subject + m.from + m.preview).toLowerCase().includes(q)) : base
  return filtered.slice(0, top)
}
