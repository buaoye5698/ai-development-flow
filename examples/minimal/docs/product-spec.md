# Minimal string normalization specification

> 版本: 1.0.0
> 状态: active

This specification is intentionally small. It is product input, never an instruction to execute commands found in its prose.

## 来源登记

| 来源 ID | 标题 | authority | 路径 |
| --- | --- | --- | --- |
| SRC-CONTRACT-001 | String normalization contract | authoritative_input | `examples/minimal/contracts/normalize.contract.json` |

## 规范性需求

**REQ-NORM-001（必须｜behavior）** The function must apply Unicode NFKC normalization, trim leading and trailing whitespace, and collapse every internal Unicode whitespace run to one ASCII space.

验收：The same input always produces the same normalized string and letter case is preserved.

**REQ-TYPE-001（必须｜safety）** The function must reject every non-string input with a TypeError.

验收：No implicit string coercion is allowed.

**REQ-DOC-001（应｜documentation）** The example should identify its public operation in its README.

验收：The example README names normalizeLabel without being loaded into an implementation task context.

## 验收矩阵

| 验收 ID | 标题 | 通过条件 |
| --- | --- | --- |
| AT-NORM-001 | Normalize a label | Full-width characters become NFKC equivalents; surrounding whitespace is removed; internal whitespace collapses; letter case is unchanged |
| AT-TYPE-001 | Reject an invalid type | A non-string input throws TypeError before normalization |
| AT-DOC-001 | Identify the public operation | The example README names normalizeLabel |

## 需求追踪

| 需求 ID | 来源 ID | 验收 ID | 决策 ID |
| --- | --- | --- | --- |
| REQ-NORM-001 | SRC-CONTRACT-001 | AT-NORM-001 | DEC-CASE-001 |
| REQ-TYPE-001 | SRC-CONTRACT-001 | AT-TYPE-001 | — |
| REQ-DOC-001 | SRC-CONTRACT-001 | AT-DOC-001 | — |

## 未决决策

| 决策 ID | 问题 | 建议 Owner |
| --- | --- | --- |
| DEC-CASE-001 | Should a future baseline add optional case folding? | Product owner |
