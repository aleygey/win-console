import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import type { HostContext } from "../../contracts"
import {
  extractSection,
  listRecordSections,
  parseSecNum,
  patchRecordSection,
  resolveVaultDirs,
  restructureSectionContent,
  taskflowCapability,
  writeRecordSection,
} from "./taskflow"

const baseBody = [
  "# 示例任务",
  "",
  "## 待办",
  "- [ ] 完成验证",
  "",
  "---",
  "",
  "## 日志",
  "",
  "| 时间 | 会话 | 记录 |",
  "| --- | --- | --- |",
  "",
].join("\n")

test("章节编号最多支持四级", () => {
  assert.deepEqual(parseSecNum("1.2.3.4"), [1, 2, 3, 4])
  assert.equal(parseSecNum("1.2.3.4.5"), null)
  assert.equal(parseSecNum("1..2"), null)

  const structured = restructureSectionContent("# 平台\n结论\n## 接口\n细节\n### 边界\n证据\n#### 过深\n说明", [1])
  assert.match(structured, /^### 1\.1 平台$/m)
  assert.match(structured, /^#### 1\.1\.1 接口$/m)
  assert.match(structured, /^##### 1\.1\.1\.1 边界$/m)
  assert.match(structured, /^\*\*过深\*\*$/m)

  const written = writeRecordSection(baseBody, "1", "适配结论", structured)
  assert.ok(written)
  assert.deepEqual(
    listRecordSections(written).map((x) => x.num),
    ["1", "1.1", "1.1.1", "1.1.1.1"],
  )
  assert.match(extractSection(written, "1.1.1.1") ?? "", /^##### 1\.1\.1\.1 边界$/m)

  const leaf = writeRecordSection(written, "1.1.1.1", "边界验证", "更新后的证据")
  assert.ok(leaf)
  assert.match(extractSection(leaf, "1.1.1.1") ?? "", /更新后的证据/)
  assert.match(extractSection(leaf, "1.1.1") ?? "", /##### 1\.1\.1\.1 边界验证/)
})

test("patch 只修改目标章节自身正文且要求唯一精确匹配", () => {
  const body = [
    "# 示例任务",
    "",
    "## 待办",
    "- [ ] 修正文案",
    "",
    "---",
    "",
    "## 1 父章",
    "",
    "父章 TOKEN",
    "",
    "### 1.1 子节",
    "",
    "子节 TOKEN",
    "",
    "---",
    "",
    "## 2 兄弟章",
    "",
    "兄弟 TOKEN",
    "",
    "## 日志",
    "",
    "| 时间 | 会话 | 记录 |",
    "| --- | --- | --- |",
    "",
  ].join("\n")

  const parent = patchRecordSection(body, "1", "父章 TOKEN", "父章 已修正")
  assert.equal(parent.ok, true)
  if (!parent.ok) return
  assert.equal(parent.body, body.replace("父章 TOKEN", "父章 已修正"))
  assert.match(parent.body, /父章 已修正/)
  assert.match(parent.body, /子节 TOKEN/)
  assert.match(parent.body, /兄弟 TOKEN/)

  const child = patchRecordSection(parent.body, "1.1", "子节 TOKEN", "子节 已修正")
  assert.equal(child.ok, true)
  if (!child.ok) return
  assert.match(child.body, /子节 已修正/)

  const ambiguousBody = body.replace("父章 TOKEN", "TOKEN 与 TOKEN")
  assert.deepEqual(patchRecordSection(ambiguousBody, "1", "TOKEN", "X"), { ok: false, error: "ambiguous_match" })
  assert.deepEqual(patchRecordSection(body, "1", "不存在", "X"), { ok: false, error: "match_not_found" })
  assert.deepEqual(patchRecordSection(body, "1", "", "X"), { ok: false, error: "empty_match" })
  assert.deepEqual(patchRecordSection(body, "1", "父章 TOKEN", "## 新标题"), { ok: false, error: "outline_changed" })
  assert.deepEqual(patchRecordSection(body, "1", "父章 TOKEN", "---"), { ok: false, error: "outline_changed" })
  assert.deepEqual(patchRecordSection(body, "1", "父章", "##"), { ok: false, error: "outline_changed" })

  const fenced = body.replace("父章 TOKEN", ["```text", "父章 TOKEN", "```"].join("\n"))
  const fencedPatch = patchRecordSection(fenced, "1", "父章 TOKEN", "## 代码里的注释")
  assert.equal(fencedPatch.ok, true)
  if (fencedPatch.ok) assert.match(fencedPatch.body, /```text\n## 代码里的注释\n```/)
})

test("手动扫描根优先于 Obsidian 上报路径", () => {
  const unc = "\\\\192.168.56.100\\share\\vault"
  assert.deepEqual(resolveVaultDirs(unc, "Z:\\vault"), [unc])
  assert.deepEqual(resolveVaultDirs("", "Z:\\vault"), ["Z:\\vault"])
  assert.deepEqual(resolveVaultDirs(`${unc};${unc.toUpperCase()}`, "Z:\\vault"), [unc])
})

test("MCP 暴露 patch 写入且不再暴露 task_set_status", () => {
  const tools = taskflowCapability.tools ?? []
  const names = tools.map((tool) => tool.name)
  assert.equal(names.length, 9)
  assert.ok(names.includes("task_write_section"))
  assert.ok(!names.includes("task_set_status"))

  const write = tools.find((tool) => tool.name === "task_write_section")
  const properties = write?.inputSchema.properties as Record<string, { enum?: string[] }> | undefined
  assert.deepEqual(properties?.mode?.enum, ["replace", "append", "patch"])
  assert.ok(properties?.old_text)
  assert.match(write?.description ?? "", /禁止用 edit\/write\/apply_patch/)

  const issue = tools.find((tool) => tool.name === "task_issue")
  const required = issue?.inputSchema.required as string[] | undefined
  assert.ok(required?.includes("verification"))
})

test("task_write_section patch 通过 MCP handler 只改目标章节正文", async () => {
  const root = mkdtempSync(join(tmpdir(), "win-console-taskflow-"))
  const boardPath = join(root, "任务看板.md")
  const taskPath = join(root, "局部修改.md")
  writeFileSync(
    boardPath,
    ["---", "kanban-plugin: board", "project: 示例", "---", "", "## 进行中", "", "- [ ] [[局部修改]]", ""].join("\n"),
    "utf8",
  )
  writeFileSync(
    taskPath,
    [
      "---",
      "project: 示例",
      "type: bug修复",
      "pha_issue:",
      "---",
      "# 局部修改",
      "",
      "## 待办",
      "- [ ] 验证修改",
      "",
      "---",
      "",
      "## 1 结论",
      "",
      "旧参数 = 1",
      "",
      "### 1.1 证据",
      "",
      "子节保持不变",
      "",
      "## 日志",
      "",
      "| 时间 | 会话 | 记录 |",
      "| --- | --- | --- |",
      "",
    ].join("\n"),
    "utf8",
  )

  const ctx = {
    native: {} as HostContext["native"],
    config: () => ({ vaultDir: root }),
    global: () => ({}) as ReturnType<HostContext["global"]>,
    emit: () => undefined,
    log: () => undefined,
    dataDir: root,
  } satisfies HostContext

  try {
    const write = taskflowCapability.tools?.find((tool) => tool.name === "task_write_section")
    assert.ok(write)
    const result = await write.handler(
      { id: "局部修改", section: "1", mode: "patch", old_text: "旧参数 = 1", content: "新参数 = 2" },
      ctx,
    )
    assert.equal(result.isError, undefined)
    assert.match(result.text, /局部修改/)
    const changed = readFileSync(taskPath, "utf8")
    assert.match(changed, /新参数 = 2/)
    assert.doesNotMatch(changed, /旧参数 = 1/)
    assert.match(changed, /子节保持不变/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
